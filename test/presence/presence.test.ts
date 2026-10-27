import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerTestUser, resetDb } from '../helpers/app.js';
import { startPresenceServer, TestClient, type Message } from '../helpers/presence.js';

const server = await startPresenceServer();
const { app, db, url } = server;

afterAll(() => server.close());
beforeEach(() => resetDb(db));

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;

let owner: TestUser;
let stranger: TestUser;
let noteId: string;
let items: { id: string }[];
const clients: TestClient[] = [];

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
  stranger = await registerTestUser(app, 'stranger');
  const res = await request(app)
    .post('/notes')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title: 'Plan', body: 'draft', items: [{ text: 'milk' }, { text: 'eggs' }] });
  noteId = res.body.note.id;
  items = res.body.note.items;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function signedIn(user: TestUser) {
  const client = await TestClient.signedIn(url, user.token);
  clients.push(client);
  return client;
}

async function joined(user: TestUser) {
  const client = await signedIn(user);
  client.send({ type: 'join', noteId });
  await client.next('presence');
  return client;
}

/** Calls the REST API as the owner, sending If-Match "1" (ignored where it doesn't apply). */
function api(method: 'patch' | 'post' | 'delete', path: string, body: object = {}) {
  const agent = request(app);
  return agent[method](path)
    .set('Authorization', `Bearer ${owner.token}`)
    .set('If-Match', '"1"')
    .send(body);
}

const userIds = (m: Message) => (m.users as { userId: string }[]).map((u) => u.userId);

describe('authentication', () => {
  it('answers a valid auth message with ready', async () => {
    const client = await TestClient.open(url);
    clients.push(client);
    client.send({ type: 'auth', token: owner.token });

    expect(await client.next('ready')).toEqual({ type: 'ready', userId: owner.user.id });
  });

  it('handles a join sent right behind auth, without waiting', async () => {
    const client = await TestClient.open(url);
    clients.push(client);
    client.send({ type: 'auth', token: owner.token });
    client.send({ type: 'join', noteId });

    expect(userIds(await client.next('presence'))).toEqual([owner.user.id]);
  });

  it.each([
    ['an invalid token', { type: 'auth', token: 'not-a-jwt' }],
    ['any other message first', { type: 'join', noteId: '00000000-0000-4000-8000-000000000000' }],
  ])('closes the connection with 4401 for %s', async (_label, message) => {
    const client = await TestClient.open(url);
    clients.push(client);
    client.send(message);

    expect(await client.closed).toBe(4401);
  });

  it('closes a connection that never authenticates', async () => {
    const client = await TestClient.open(url);
    clients.push(client);

    expect(await client.closed).toBe(4401);
  });
});

describe('rooms and presence', () => {
  it('shows every connection in the room and drops one when it closes', async () => {
    const tab1 = await joined(owner);
    const tab2 = await signedIn(owner);
    tab2.send({ type: 'join', noteId });

    expect(userIds(await tab1.next('presence'))).toEqual([owner.user.id, owner.user.id]);
    tab2.close();
    expect(userIds(await tab1.next('presence'))).toEqual([owner.user.id]);
  });

  it('refuses a stranger as not_found and sends them nothing about the note', async () => {
    const outsider = await signedIn(stranger);
    outsider.send({ type: 'join', noteId });

    expect(await outsider.next('error')).toMatchObject({ code: 'not_found' });
    await api('patch', `/notes/${noteId}`, { body: 'secret' }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(outsider.unread()).toEqual([]);
  });

  it('relays activity and cursors to the room', async () => {
    const watcher = await joined(owner);
    const editor = await joined(owner);
    await watcher.next('presence');

    editor.send({ type: 'activity', noteId, mode: 'editing' });
    editor.send({ type: 'cursor', noteId, field: 'body', anchor: 3, head: 5 });

    const presence = await watcher.next('presence', (m) =>
      (m.users as { cursor?: unknown }[]).some((u) => u.cursor),
    );
    expect(presence.users).toContainEqual({
      userId: owner.user.id,
      displayName: 'owner',
      mode: 'editing',
      cursor: { field: 'body', anchor: 3, head: 5 },
    });
  });

  it('requires joining before activity or cursors', async () => {
    const client = await signedIn(owner);
    client.send({ type: 'cursor', noteId, field: 'title', anchor: 0, head: 0 });

    expect(await client.next('error')).toMatchObject({ code: 'not_joined' });
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['an unknown type', { type: 'shout', noteId }],
    ['a bad cursor field', { type: 'cursor', noteId, field: 'footer', anchor: 0, head: 0 }],
  ])('answers %s with an error and keeps the connection', async (_label, message) => {
    const client = await joined(owner);
    client.send(message);

    expect(await client.next('error')).toMatchObject({ code: 'invalid_message' });
    client.send({ type: 'leave', noteId });
    client.send({ type: 'join', noteId });
    expect(await client.next('presence')).toBeDefined();
  });
});

describe('live changes from REST', () => {
  it('pushes note edits with the new text and version', async () => {
    const client = await joined(owner);
    await api('patch', `/notes/${noteId}`, { body: 'final' }).expect(200);

    expect(await client.next('note.updated')).toMatchObject({
      noteId,
      by: owner.user.id,
      note: { title: 'Plan', body: 'final', version: 2 },
    });
  });

  it('pushes added, moved, ticked and deleted items with where they now sit', async () => {
    const client = await joined(owner);
    const [milk, eggs] = items;

    const added = await api('post', `/notes/${noteId}/items`, { text: 'bread', after: milk!.id });
    expect(await client.next('item.added')).toMatchObject({
      item: { id: added.body.item.id, text: 'bread' },
      after: milk!.id,
    });

    await api('patch', `/notes/${noteId}/items/${eggs!.id}`, { after: null });
    expect(await client.next('item.updated')).toMatchObject({
      item: { id: eggs!.id },
      after: null,
    });

    await api('patch', `/notes/${noteId}/items/${milk!.id}`, { done: true });
    const ticked = await client.next('item.updated');
    expect(ticked).toMatchObject({ item: { id: milk!.id, done: true, version: 2 } });
    expect(ticked).not.toHaveProperty('after');

    await api('delete', `/notes/${noteId}/items/${milk!.id}`);
    expect(await client.next('item.deleted')).toMatchObject({ itemId: milk!.id });
  });

  it('tells the room when the note is deleted', async () => {
    const client = await joined(owner);
    await api('delete', `/notes/${noteId}`).expect(204);

    expect(await client.next('note.deleted')).toMatchObject({ noteId, by: owner.user.id });
  });

  it('sends nothing for a refused save', async () => {
    const client = await joined(owner);
    await api('patch', `/notes/${noteId}`, { body: 'one' }).expect(200);
    await client.next('note.updated');

    await api('patch', `/notes/${noteId}`, { body: 'stale' }).expect(409);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.unread().filter((m) => m.type === 'note.updated')).toEqual([]);
  });
});

describe('heartbeat', () => {
  const quick = {
    heartbeat: undefined as Awaited<ReturnType<typeof startPresenceServer>> | undefined,
  };

  beforeAll(async () => {
    quick.heartbeat = await startPresenceServer({ heartbeatMs: 50 });
  });
  afterAll(() => quick.heartbeat?.close());

  it('drops a connection that stops answering pings and updates presence', async () => {
    const live = await TestClient.signedIn(quick.heartbeat!.url, owner.token);
    const silent = await TestClient.signedIn(quick.heartbeat!.url, owner.token, {
      autoPong: false,
    });
    clients.push(live, silent);
    live.send({ type: 'join', noteId });
    silent.send({ type: 'join', noteId });
    await live.next('presence', (m) => userIds(m).length === 2);

    expect(await silent.closed).toBe(1006);
    expect(userIds(await live.next('presence', (m) => userIds(m).length === 1))).toEqual([
      owner.user.id,
    ]);
  });
});
