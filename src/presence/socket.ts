import type http from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { findUserById } from '../auth/service.js';
import { verifyTokenClaims, type TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import type { AccessChanged, NoteEvents } from '../events.js';
import { logger } from '../logger.js';
import { canEdit, noteRole } from '../notes/access.js';
import { PresenceHub } from './hub.js';
import { MessageRate, WS_LIMITS } from './limits.js';
import { clientMessageSchema, type ClientMessage } from './schemas.js';

export interface PresenceOptions {
  db: Db;
  auth: TokenSettings;
  events: NoteEvents;
  heartbeatMs?: number;
  authTimeoutMs?: number;
}

/** Close codes in the 4000 range are ours: 4401 = not authenticated, 4429 = too many connections. */
const UNAUTHENTICATED = 4401;
const TOO_MANY_CONNECTIONS = 4429;
const POLICY_VIOLATION = 1008;
// setTimeout delays above this overflow and fire immediately.
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Caller {
  userId: string;
  displayName: string;
}

/**
 * Serves presence and live note changes at /ws on the given server. The first message must be
 * `{ type: "auth", token }`; tokens never go in the URL, where proxies and logs would keep them.
 */
export function attachPresence(server: http.Server, options: PresenceOptions) {
  const { db, auth, events, heartbeatMs = 15_000, authTimeoutMs = 5_000 } = options;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: WS_LIMITS.maxMessageBytes });
  const hub = new PresenceHub(WS_LIMITS.maxBufferedBytes);
  const connectionsByUser = new Map<string, number>();
  // Bumped on every access change, so a join can tell whether one happened during its own check.
  let accessEpoch = 0;
  const unsubscribe = events.subscribe((event) => {
    if (event.type !== 'access.changed') return hub.forward(event);
    accessEpoch += 1;
    recheckAccess(event).catch((err: unknown) => {
      logger.error({ err }, 'presence access recheck failed');
    });
  });

  /**
   * Re-runs the access check for everyone in the affected rooms: anyone who lost access is removed
   * and told, and anyone downgraded to viewer stops showing as editing.
   */
  async function recheckAccess(change: AccessChanged): Promise<void> {
    const roles = new Map<string, ReturnType<typeof noteRole>>();
    for (const { noteId: id, socket, member } of hub.affectedBy(change)) {
      const key = `${id}:${member.userId}`;
      if (!roles.has(key)) roles.set(key, noteRole(db, id, member.userId));
      const role = await roles.get(key);
      if (!role) {
        hub.leave(id, socket);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'access.revoked', noteId: id }));
        }
      } else if (role !== member.role) {
        const mode = canEdit(role) ? member.mode : 'viewing';
        hub.update(id, socket, { role, mode });
      }
    }
  }
  const alive = new WeakSet<WebSocket>();

  /**
   * The caller's role, looked up again if access changed during the lookup: a revocation's recheck
   * could otherwise run before this join lands and miss it. Gives up after three changes in a row.
   */
  async function currentRole(noteId: string, userId: string) {
    let role: Awaited<ReturnType<typeof noteRole>>;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const epoch = accessEpoch;
      role = await noteRole(db, noteId, userId);
      if (epoch === accessEpoch) return role;
    }
    return undefined;
  }

  wss.on('connection', (socket) => {
    let caller: Caller | undefined;
    let expiryTimer: NodeJS.Timeout | undefined;
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    // ws raises protocol errors (oversized or malformed frames) here and closes the socket itself;
    // without a listener, Node treats the event as an uncaught exception and the process exits.
    socket.on('error', (err: Error & { code?: string }) => {
      logger.warn({ code: err.code }, 'websocket protocol error');
    });

    const authTimer = setTimeout(() => {
      if (!caller) socket.close(UNAUTHENTICATED, 'Authenticate first');
    }, authTimeoutMs);

    const send = (message: object) => socket.send(JSON.stringify(message));
    const sendError = (code: string, message: string) => send({ type: 'error', code, message });

    async function authenticate(token: string): Promise<void> {
      const claims = verifyTokenClaims(token, auth);
      const user = claims ? await findUserById(db, claims.userId) : undefined;
      if (!claims || !user) {
        socket.close(UNAUTHENTICATED, 'Invalid token');
        return;
      }
      const open = connectionsByUser.get(user.id) ?? 0;
      if (open >= WS_LIMITS.maxConnectionsPerUser) {
        socket.close(TOO_MANY_CONNECTIONS, 'Too many connections');
        return;
      }
      clearTimeout(authTimer);
      connectionsByUser.set(user.id, open + 1);
      caller = { userId: user.id, displayName: user.displayName };
      const msLeft = Math.min(claims.expiresAt.getTime() - Date.now(), MAX_TIMER_MS);
      expiryTimer = setTimeout(() => socket.close(UNAUTHENTICATED, 'Token expired'), msLeft);
      send({ type: 'ready', userId: user.id });
    }

    async function handle(message: ClientMessage, who: Caller): Promise<void> {
      if (message.type === 'auth')
        return sendError('already_authenticated', 'Already authenticated');
      if (message.type === 'join') {
        const alreadyIn = hub.member(message.noteId, socket) !== undefined;
        if (!alreadyIn && hub.roomCount(socket) >= WS_LIMITS.maxRoomsPerConnection) {
          return sendError('too_many_rooms', 'Leave a note before joining another');
        }
        const role = await currentRole(message.noteId, who.userId);
        if (!role) return sendError('not_found', 'Note not found');
        // The close handler may have run during the lookup; joining now would leave a ghost member.
        if (socket.readyState !== socket.OPEN) return;
        hub.join(message.noteId, socket, { ...who, role, mode: 'viewing' });
        return;
      }
      if (message.type === 'leave') return hub.leave(message.noteId, socket);

      const member = hub.member(message.noteId, socket);
      if (!member) return sendError('not_joined', 'Join the note first');
      if (message.type === 'activity') {
        if (message.mode === 'editing' && !canEdit(member.role)) {
          return sendError('forbidden', 'You can view this note but not edit it');
        }
        return hub.update(message.noteId, socket, { mode: message.mode });
      }
      const { field, anchor, head } = message;
      hub.update(message.noteId, socket, { cursor: { field, anchor, head } });
    }

    function dispatch(message: ClientMessage): Promise<void> {
      if (caller) return handle(message, caller);
      if (message.type === 'auth') return authenticate(message.token);
      socket.close(UNAUTHENTICATED, 'Authenticate first');
      return Promise.resolve();
    }

    // Messages run one at a time in arrival order, so a join sent right after auth waits for it.
    // The rate and the backlog are both capped, so a fast client can't pile up work or memory.
    let queue = Promise.resolve();
    let pending = 0;
    const rate = new MessageRate(WS_LIMITS.messagesPerSecond);
    socket.on('message', (data: RawData) => {
      if (!rate.allow() || pending >= WS_LIMITS.maxPendingMessages) {
        socket.close(POLICY_VIOLATION, 'Too many messages');
        return;
      }
      const message = parseMessage(data);
      if (!message) return sendError('invalid_message', 'Message is not a valid client message');
      pending += 1;
      queue = queue
        .then(() => (socket.readyState === socket.OPEN ? dispatch(message) : undefined))
        .catch((err: unknown) => {
          logger.error({ err }, 'presence message failed');
          sendError('internal', 'Internal server error');
        })
        .finally(() => {
          pending -= 1;
        });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearTimeout(expiryTimer);
      hub.leaveAll(socket);
      if (caller) {
        const open = (connectionsByUser.get(caller.userId) ?? 1) - 1;
        if (open > 0) connectionsByUser.set(caller.userId, open);
        else connectionsByUser.delete(caller.userId);
      }
    });
  });

  // A connection that misses a whole heartbeat (no pong) is dropped, which also clears its presence.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, heartbeatMs);

  return {
    close(): Promise<void> {
      clearInterval(heartbeat);
      unsubscribe();
      for (const socket of wss.clients) socket.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

function parseMessage(data: RawData): ClientMessage | undefined {
  try {
    const result = clientMessageSchema.safeParse(JSON.parse(data.toString()));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
