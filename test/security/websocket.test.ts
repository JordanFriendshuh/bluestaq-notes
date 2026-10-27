import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { signToken } from '../../src/auth/tokens.js';
import { PresenceHub } from '../../src/presence/hub.js';
import { WS_LIMITS } from '../../src/presence/limits.js';
import { registerTestUser, resetDb } from '../helpers/app.js';
import { startPresenceServer, TestClient, type Message } from '../helpers/presence.js';

const server = await startPresenceServer();
const { app, db, url, auth } = server;

afterAll(() => server.close());
beforeEach(() => resetDb(db));

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;

let owner: TestUser;
let noteId: string;
const clients: TestClient[] = [];

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
  const res = await request(app)
    .post('/notes')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title: 'Plan' });
  noteId = res.body.note.id;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function track<T extends TestClient>(client: Promise<T>): Promise<T> {
  const opened = await client;
  clients.push(opened);
  return opened;
}

const signedIn = (token = owner.token) => track(TestClient.signedIn(url, token));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const userIds = (m: Message) => (m.users as { userId: string }[]).map((u) => u.userId);

describe('oversized messages', () => {
  it('closes the connection with 1009 and keeps the server running', async () => {
    const client = await track(TestClient.open(url));
    client.send('x'.repeat(WS_LIMITS.maxMessageBytes + 1));

    expect(await client.closed).toBe(1009);
    expect(await signedIn()).toBeDefined();
  });
});

describe('message floods', () => {
  it('closes a connection with a backlog of slow messages', async () => {
    const client = await signedIn();
    for (let i = 0; i <= WS_LIMITS.maxPendingMessages; i += 1)
      client.send({ type: 'join', noteId });

    expect(await client.closed).toBe(1008);
  });

  it('closes a connection that sends faster than the rate limit', async () => {
    const client = await signedIn();
    for (let i = 0; i <= WS_LIMITS.messagesPerSecond; i += 1) {
      client.send({ type: 'cursor', noteId, field: 'title', anchor: 0, head: 0 });
    }

    expect(await client.closed).toBe(1008);
  });
});

describe('room limits', () => {
  it(`refuses a join past ${WS_LIMITS.maxRoomsPerConnection} rooms`, async () => {
    const notes = await db
      .insertInto('notes')
      .values(
        Array.from({ length: WS_LIMITS.maxRoomsPerConnection }, (_, i) => ({
          ownerId: owner.user.id,
          title: `note ${i}`,
        })),
      )
      .returning('id')
      .execute();
    const client = await signedIn();

    // Batches of 15, a second apart, stay under both the rate limit and the backlog cap.
    for (let i = 0; i < notes.length; i += 15) {
      const batch = notes.slice(i, i + 15);
      for (const note of batch) client.send({ type: 'join', noteId: note.id });
      for (const note of batch) await client.next('presence', (m) => m.noteId === note.id);
      await pause(1100);
    }
    client.send({ type: 'join', noteId });

    expect(await client.next('error')).toMatchObject({ code: 'too_many_rooms' });
  });
});

describe('connections per user', () => {
  it(`closes a ${WS_LIMITS.maxConnectionsPerUser + 1}st connection with 4429 and frees a slot on close`, async () => {
    const open: TestClient[] = [];
    for (let i = 0; i < WS_LIMITS.maxConnectionsPerUser; i += 1) open.push(await signedIn());

    const extra = await track(TestClient.open(url));
    extra.send({ type: 'auth', token: owner.token });
    expect(await extra.closed).toBe(4429);

    open[0]!.close();
    await open[0]!.closed;
    expect(await signedIn()).toBeDefined();
  });
});

describe('token expiry', () => {
  it('closes the connection with 4401 when the token expires', async () => {
    const shortLived = signToken(owner.user.id, { ...auth, tokenTtlSeconds: 1 });
    const client = await signedIn(shortLived);

    expect(await client.closed).toBe(4401);
  });
});

describe('disconnecting mid-join', () => {
  it('never leaves a ghost member in the room', async () => {
    const watcher = await signedIn();
    watcher.send({ type: 'join', noteId });
    await watcher.next('presence');

    for (let i = 0; i < 5; i += 1) {
      const quitter = await track(TestClient.open(url));
      quitter.send({ type: 'auth', token: owner.token });
      quitter.send({ type: 'join', noteId });
      quitter.socket.terminate();
    }
    await pause(300);
    watcher.send({ type: 'activity', noteId, mode: 'editing' });

    const presence = await watcher.next('presence', (m) =>
      (m.users as { mode: string }[]).some((u) => u.mode === 'editing'),
    );
    expect(userIds(presence)).toEqual([owner.user.id]);
  });
});

describe('slow readers', () => {
  it('drops a client whose unread backlog passes the limit instead of buffering more', () => {
    const hub = new PresenceHub(WS_LIMITS.maxBufferedBytes);
    const fakeSocket = (bufferedAmount: number) => {
      const socket = { OPEN: 1, readyState: 1, bufferedAmount, sent: 0, terminated: false };
      return Object.assign(socket, {
        send: () => void (socket.sent += 1),
        terminate: () => void (socket.terminated = true),
      });
    };
    const reader = fakeSocket(0);
    const stalled = fakeSocket(WS_LIMITS.maxBufferedBytes + 1);
    const member = {
      userId: 'u',
      displayName: 'u',
      role: 'owner' as const,
      mode: 'viewing' as const,
    };

    hub.join('note', reader as unknown as WebSocket, member);
    hub.join('note', stalled as unknown as WebSocket, member);

    expect(reader.sent).toBe(2);
    expect(stalled.terminated).toBe(true);
    expect(stalled.sent).toBe(0);
  });
});
