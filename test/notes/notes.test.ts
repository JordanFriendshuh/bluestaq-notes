import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;

const as = (user: TestUser) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${user.token}`),
  post: (path: string, body: object) =>
    request(app).post(path).set('Authorization', `Bearer ${user.token}`).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(path).set('Authorization', `Bearer ${user.token}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${user.token}`),
});

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let owner: TestUser;
let stranger: TestUser;

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
  stranger = await registerTestUser(app, 'stranger');
});

async function noteBy(user: TestUser, title = 'Standup', body = 'Ship the API') {
  const res = await as(user).post('/notes', { title, body });
  return res.body.note as { id: string; updatedAt: string };
}

describe('POST /notes', () => {
  it('creates a note owned by the caller', async () => {
    const res = await as(owner).post('/notes', { title: 'Standup', body: 'line one\nline two' });

    expect(res.status).toBe(201);
    expect(res.body.note).toMatchObject({
      ownerId: owner.user.id,
      title: 'Standup',
      body: 'line one\nline two',
      role: 'owner',
    });
  });

  it('defaults the body to empty and ignores fields the client may not set', async () => {
    const res = await as(owner).post('/notes', {
      title: 'Idea',
      ownerId: stranger.user.id,
      id: MISSING_ID,
    });

    expect(res.body.note).toMatchObject({ body: '', ownerId: owner.user.id });
    expect(res.body.note.id).not.toBe(MISSING_ID);
  });

  it.each([
    ['a blank title', { title: '  ' }, 'title'],
    ['a title with a newline', { title: 'a\nb' }, 'title'],
    ['a title over 200 characters', { title: 'x'.repeat(201) }, 'title'],
    ['a NUL in the body', { title: 'ok', body: 'a\0b' }, 'body'],
    ['a terminal escape in the body', { title: 'ok', body: '\u001b[31mred' }, 'body'],
    ['a body over 50,000 characters', { title: 'ok', body: 'x'.repeat(50_001) }, 'body'],
  ])('rejects %s', async (_label, body, path) => {
    const res = await as(owner).post('/notes', body);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(path);
  });

  it('keeps tabs and Windows line endings in the body', async () => {
    const res = await as(owner).post('/notes', { title: 'ok', body: 'a\tb\r\nc' });

    expect(res.body.note.body).toBe('a\tb\r\nc');
  });

  it('requires a token', async () => {
    expect((await request(app).post('/notes').send({ title: 'x' })).status).toBe(401);
  });
});

describe('GET /notes', () => {
  it("lists only the caller's notes, most recently updated first", async () => {
    const first = await noteBy(owner, 'first');
    const second = await noteBy(owner, 'second');
    await noteBy(stranger, 'not yours');
    await as(owner).patch(`/notes/${first.id}`, { body: 'touched' });

    const res = await as(owner).get('/notes');

    expect(res.body.notes.map((n: { id: string }) => n.id)).toEqual([first.id, second.id]);
  });

  it('pages with limit and offset', async () => {
    for (const title of ['a', 'b', 'c']) await noteBy(owner, title);

    const page = await as(owner).get('/notes?limit=2&offset=1');

    expect(page.body.notes.map((n: { title: string }) => n.title)).toEqual(['b', 'a']);
  });

  it.each(['limit=0', 'limit=101', 'offset=-1', 'limit=abc'])('rejects %s', async (query) => {
    expect((await as(owner).get(`/notes?${query}`)).status).toBe(400);
  });
});

describe('GET /notes/:id', () => {
  it('returns the note to its owner', async () => {
    const note = await noteBy(owner);
    const res = await as(owner).get(`/notes/${note.id}`);

    expect(res.status).toBe(200);
    expect(res.body.note).toMatchObject({ id: note.id, title: 'Standup', role: 'owner' });
  });

  it('returns 404 to a stranger, the same as for a note that does not exist', async () => {
    const note = await noteBy(owner);
    const hidden = await as(stranger).get(`/notes/${note.id}`);
    const missing = await as(stranger).get(`/notes/${MISSING_ID}`);

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it('rejects an id that is not a UUID as a 400', async () => {
    expect((await as(owner).get('/notes/not-a-uuid')).status).toBe(400);
  });
});

describe('PATCH /notes/:id', () => {
  it('changes only the fields sent and bumps updatedAt', async () => {
    const note = await noteBy(owner);
    const res = await as(owner).patch(`/notes/${note.id}`, { title: 'Retro' });

    expect(res.status).toBe(200);
    expect(res.body.note).toMatchObject({ title: 'Retro', body: 'Ship the API' });
    expect(new Date(res.body.note.updatedAt).getTime()).toBeGreaterThan(
      new Date(note.updatedAt).getTime(),
    );
  });

  it('rejects an empty update', async () => {
    const note = await noteBy(owner);
    const res = await as(owner).patch(`/notes/${note.id}`, {});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('cannot move a note to another owner', async () => {
    const note = await noteBy(owner);
    await as(owner).patch(`/notes/${note.id}`, { title: 'Mine', ownerId: stranger.user.id });

    expect((await as(owner).get(`/notes/${note.id}`)).body.note.ownerId).toBe(owner.user.id);
  });

  it('returns 404 to a stranger and leaves the note unchanged', async () => {
    const note = await noteBy(owner);

    expect((await as(stranger).patch(`/notes/${note.id}`, { title: 'pwned' })).status).toBe(404);
    expect((await as(owner).get(`/notes/${note.id}`)).body.note.title).toBe('Standup');
  });
});

describe('DELETE /notes/:id', () => {
  it('lets the owner delete the note', async () => {
    const note = await noteBy(owner);

    expect((await as(owner).delete(`/notes/${note.id}`)).status).toBe(204);
    expect((await as(owner).get(`/notes/${note.id}`)).status).toBe(404);
  });

  it('returns 404 to a stranger and keeps the note', async () => {
    const note = await noteBy(owner);

    expect((await as(stranger).delete(`/notes/${note.id}`)).status).toBe(404);
    expect((await as(owner).get(`/notes/${note.id}`)).status).toBe(200);
  });
});

describe('checklists', () => {
  const ITEM_ID = '11111111-1111-4111-8111-111111111111';

  it('creates a note with items, filling in ids and done', async () => {
    const res = await as(owner).post('/notes', {
      title: 'Groceries',
      items: [{ text: 'milk' }, { id: ITEM_ID, text: 'eggs', done: true }],
    });

    expect(res.status).toBe(201);
    expect(res.body.note.items).toEqual([
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), text: 'milk', done: false },
      { id: ITEM_ID, text: 'eggs', done: true },
    ]);
  });

  it('defaults to an empty checklist', async () => {
    const res = await as(owner).post('/notes', { title: 'Prose only' });

    expect(res.body.note.items).toEqual([]);
  });

  it('replaces the whole checklist on PATCH and keeps it when items are not sent', async () => {
    const created = await as(owner).post('/notes', {
      title: 'Groceries',
      items: [{ id: ITEM_ID, text: 'milk' }],
    });
    const id = created.body.note.id;

    const ticked = await as(owner).patch(`/notes/${id}`, {
      items: [{ id: ITEM_ID, text: 'milk', done: true }, { text: 'bread' }],
    });
    const retitled = await as(owner).patch(`/notes/${id}`, { title: 'Shopping' });

    expect(ticked.body.note.items).toEqual([
      { id: ITEM_ID, text: 'milk', done: true },
      { id: expect.any(String), text: 'bread', done: false },
    ]);
    expect(retitled.body.note.items).toEqual(ticked.body.note.items);
  });

  it('clears the checklist with an empty array', async () => {
    const created = await as(owner).post('/notes', { title: 'x', items: [{ text: 'a' }] });
    const res = await as(owner).patch(`/notes/${created.body.note.id}`, { items: [] });

    expect(res.body.note.items).toEqual([]);
  });

  it('drops item fields the client may not set', async () => {
    const res = await as(owner).post('/notes', {
      title: 'x',
      items: [{ text: 'a', assignee: 'bob' }],
    });

    expect(Object.keys(res.body.note.items[0]).sort()).toEqual(['done', 'id', 'text']);
  });

  it.each([
    ['a blank item', [{ text: ' ' }], 'items.0.text'],
    ['an item with a newline', [{ text: 'a\nb' }], 'items.0.text'],
    ['an item over 500 characters', [{ text: 'x'.repeat(501) }], 'items.0.text'],
    ['a non-boolean done', [{ text: 'a', done: 'yes' }], 'items.0.done'],
    ['an id that is not a UUID', [{ id: '1', text: 'a' }], 'items.0.id'],
    [
      'duplicate ids',
      [
        { id: ITEM_ID, text: 'a' },
        { id: ITEM_ID, text: 'b' },
      ],
      'items',
    ],
    ['more than 500 items', Array.from({ length: 501 }, () => ({ text: 'a' })), 'items'],
    ['an object instead of an array', { text: 'a' }, 'items'],
  ])('rejects %s', async (_label, items, path) => {
    const res = await as(owner).post('/notes', { title: 'x', items });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(path);
  });
});
