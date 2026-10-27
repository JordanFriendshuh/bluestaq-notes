import type http from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { findUserById } from '../auth/service.js';
import { verifyToken, type TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import type { NoteEvents } from '../events.js';
import { logger } from '../logger.js';
import { canEdit, noteRole } from '../notes/access.js';
import { PresenceHub } from './hub.js';
import { clientMessageSchema, type ClientMessage } from './schemas.js';

export interface PresenceOptions {
  db: Db;
  auth: TokenSettings;
  events: NoteEvents;
  heartbeatMs?: number;
  authTimeoutMs?: number;
}

/** Close codes in the 4000 range are ours: 4401 = not authenticated. */
const UNAUTHENTICATED = 4401;

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
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  const hub = new PresenceHub();
  const unsubscribe = events.subscribe((event) => hub.forward(event));
  const alive = new WeakSet<WebSocket>();

  wss.on('connection', (socket) => {
    let caller: Caller | undefined;
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));

    const authTimer = setTimeout(() => {
      if (!caller) socket.close(UNAUTHENTICATED, 'Authenticate first');
    }, authTimeoutMs);

    const send = (message: object) => socket.send(JSON.stringify(message));
    const sendError = (code: string, message: string) => send({ type: 'error', code, message });

    async function authenticate(token: string): Promise<void> {
      const userId = verifyToken(token, auth);
      const user = userId ? await findUserById(db, userId) : undefined;
      if (!user) {
        socket.close(UNAUTHENTICATED, 'Invalid token');
        return;
      }
      clearTimeout(authTimer);
      caller = { userId: user.id, displayName: user.displayName };
      send({ type: 'ready', userId: user.id });
    }

    async function handle(message: ClientMessage, who: Caller): Promise<void> {
      if (message.type === 'auth')
        return sendError('already_authenticated', 'Already authenticated');
      if (message.type === 'join') {
        const role = await noteRole(db, message.noteId, who.userId);
        if (!role) return sendError('not_found', 'Note not found');
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
    let queue = Promise.resolve();
    socket.on('message', (data: RawData) => {
      const message = parseMessage(data);
      if (!message) return sendError('invalid_message', 'Message is not a valid client message');
      queue = queue
        .then(() => dispatch(message))
        .catch((err: unknown) => {
          logger.error({ err }, 'presence message failed');
          sendError('internal', 'Internal server error');
        });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      hub.leaveAll(socket);
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
