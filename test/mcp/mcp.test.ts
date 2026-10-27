import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerTestUser, resetDb } from '../helpers/app.js';
import { mcpClient } from '../helpers/mcp.js';
import { startPresenceServer, TestClient } from '../helpers/presence.js';

const server = await startPresenceServer();
const { app, db, httpUrl, url: wsUrl } = server;

afterAll(() => server.close());
beforeEach(() => resetDb(db));

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;
type Mcp = Awaited<ReturnType<typeof mcpClient>>;

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

async function connect(user: TestUser): Promise<Mcp> {
  const mcp = await mcpClient(httpUrl, user.token);
  open.push(mcp);
  return mcp;
}

let owner: TestUser;
let ownerMcp: Mcp;

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
  ownerMcp = await connect(owner);
});

const rest = (user: TestUser) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${user.token}`),
  put: (path: string, body: object) =>
    request(app).put(path).set('Authorization', `Bearer ${user.token}`).send(body),
});

async function newNote(mcp = ownerMcp, items: string[] = ['milk']) {
  const { data } = await mcp.call('create_note', {
    title: 'Groceries',
    body: 'weekly shop',
    items: items.map((text) => ({ text })),
  });
  return data.note as { id: string; version: number; items: { id: string; version: number }[] };
}

describe('tools', () => {
  it('lists every tool with an input schema', async () => {
    const { tools } = await ownerMcp.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_item',
      'create_note',
      'delete_item',
      'get_note',
      'list_teams',
      'search_notes',
      'share_note',
      'update_item',
      'update_note',
    ]);
    expect(tools.find((t) => t.name === 'update_note')?.inputSchema.required).toEqual(
      expect.arrayContaining(['noteId', 'version']),
    );
  });

  it('creates a note that REST then sees', async () => {
    const note = await newNote();

    const res = await rest(owner).get(`/notes/${note.id}`);
    expect(res.body.note).toMatchObject({ title: 'Groceries', items: [{ text: 'milk' }] });
  });

  it('searches and lists like GET /notes', async () => {
    await newNote();

    const found = await ownerMcp.call('search_notes', { q: 'weekly' });
    const recent = await ownerMcp.call('search_notes', {});

    expect(found.data.notes.map((n: { title: string }) => n.title)).toEqual(['Groceries']);
    expect(found.data.notes[0].snippet).toContainEqual({ text: 'weekly', highlight: true });
    expect(recent.data.notes).toHaveLength(1);
  });

  it('updates with a version and refuses a stale one with the current note', async () => {
    const note = await newNote();

    const first = await ownerMcp.call('update_note', { noteId: note.id, version: 1, body: 'v2' });
    const stale = await ownerMcp.call('update_note', { noteId: note.id, version: 1, body: 'v3' });

    expect(first.data.note).toMatchObject({ body: 'v2', version: 2 });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toMatchObject({
      code: 'version_conflict',
      current: { body: 'v2', version: 2 },
    });
  });

  it('adds, ticks and deletes checklist items', async () => {
    const note = await newNote();

    const added = await ownerMcp.call('add_item', { noteId: note.id, text: 'eggs', after: null });
    const ticked = await ownerMcp.call('update_item', {
      noteId: note.id,
      itemId: note.items[0]!.id,
      version: 1,
      done: true,
    });
    await ownerMcp.call('delete_item', { noteId: note.id, itemId: added.data.item.id });

    expect(ticked.data.item).toMatchObject({ done: true, version: 2 });
    const res = await rest(owner).get(`/notes/${note.id}`);
    expect(res.body.note.items).toEqual([expect.objectContaining({ text: 'milk', done: true })]);
  });

  it('shares a note and lists teams', async () => {
    const guest = await registerTestUser(app, 'guest');
    const note = await newNote();

    const shared = await ownerMcp.call('share_note', {
      noteId: note.id,
      userEmail: guest.user.email,
      role: 'viewer',
    });
    const teams = await ownerMcp.call('list_teams');

    expect(shared.data.share).toMatchObject({ role: 'viewer', user: { id: guest.user.id } });
    expect((await rest(guest).get(`/notes/${note.id}`)).status).toBe(200);
    expect(teams.data).toEqual({ teams: [] });
  });

  it('applies the same text rules as REST', async () => {
    const res = await ownerMcp.call('create_note', { title: 'line\nbreak' });

    expect(res.isError).toBe(true);
    expect(res.data.text).toContain('control characters');
    expect((await ownerMcp.call('search_notes', {})).data.notes).toEqual([]);
  });

  it('pushes MCP edits to WebSocket viewers like REST edits', async () => {
    const note = await newNote();
    const viewer = await TestClient.signedIn(wsUrl, owner.token);
    open.push(viewer);
    viewer.send({ type: 'join', noteId: note.id });
    await viewer.next('presence');

    await ownerMcp.call('update_note', { noteId: note.id, version: 1, title: 'Shopping' });

    expect(await viewer.next('note.updated')).toMatchObject({
      noteId: note.id,
      note: { title: 'Shopping', version: 2 },
    });
  });
});

describe('roles', () => {
  let editor: TestUser;
  let viewer: TestUser;
  let teamMember: TestUser;
  let stranger: TestUser;
  let noteId: string;
  let itemId: string;

  beforeEach(async () => {
    editor = await registerTestUser(app, 'editor');
    viewer = await registerTestUser(app, 'viewer');
    teamMember = await registerTestUser(app, 'member');
    stranger = await registerTestUser(app, 'stranger');
    const team = await request(app)
      .post('/teams')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'T' });
    await request(app)
      .post(`/teams/${team.body.team.id}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: teamMember.user.email });
    const note = await newNote();
    noteId = note.id;
    itemId = note.items[0]!.id;
    const share = rest(owner).put;
    await share(`/notes/${noteId}/shares`, { userEmail: editor.user.email, role: 'editor' });
    await share(`/notes/${noteId}/shares`, { userEmail: viewer.user.email, role: 'viewer' });
    await share(`/notes/${noteId}/shares`, { teamId: team.body.team.id, role: 'viewer' });
  });

  const users = () => ({ owner, editor, viewer, teamMember, stranger });

  it.each([
    ['owner', null, null, null],
    ['editor', null, null, 'forbidden'],
    ['viewer', 'forbidden', 'forbidden', 'forbidden'],
    ['teamMember', 'forbidden', 'forbidden', 'forbidden'],
    ['stranger', 'not_found', 'not_found', 'not_found'],
  ] as const)('%s: edit %s, tick %s, share %s', async (who, edit, tick, share) => {
    const mcp = await connect(users()[who]);
    const results = [
      await mcp.call('update_note', { noteId, version: 1, title: `by ${who}` }),
      await mcp.call('update_item', { noteId, itemId, version: 1, done: true }),
      await mcp.call('share_note', { noteId, userEmail: stranger.user.email, role: 'viewer' }),
    ];
    const codes = results.map((r) => (r.isError ? r.data.error.code : null));

    expect(codes).toEqual([edit, tick, share]);
  });

  it.each([
    ['viewer', 'viewer'],
    ['teamMember', 'viewer'],
    ['stranger', null],
  ] as const)('%s reads the note as %s', async (who, role) => {
    const mcp = await connect(users()[who]);
    const res = await mcp.call('get_note', { noteId });
    const found = await mcp.call('search_notes', { q: 'groceries' });

    expect(res.isError ? null : res.data.note.role).toBe(role);
    expect(found.data.notes).toHaveLength(role ? 1 : 0);
  });
});

describe('transport', () => {
  it('requires a bearer token', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(401);
  });

  it.each(['get', 'delete'] as const)('answers %s with 405', async (method) => {
    const res = await request(app)[method]('/mcp').set('Authorization', `Bearer ${owner.token}`);

    expect(res.status).toBe(405);
  });
});
