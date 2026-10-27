import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;
interface Item {
  id: string;
  text: string;
  done: boolean;
}

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

/** Creates a note with the given item texts and returns its id and items. */
async function listWith(texts: string[]) {
  const res = await as(owner).post('/notes', {
    title: 'Groceries',
    items: texts.map((text) => ({ text })),
  });
  return { noteId: res.body.note.id as string, items: res.body.note.items as Item[] };
}

async function textsOf(noteId: string): Promise<string[]> {
  const res = await as(owner).get(`/notes/${noteId}`);
  return res.body.note.items.map((item: Item) => item.text);
}

describe('items on notes', () => {
  it('creates a note with its starting items in order', async () => {
    const res = await as(owner).post('/notes', {
      title: 'Groceries',
      items: [{ text: 'milk' }, { text: 'eggs', done: true }],
    });

    expect(res.status).toBe(201);
    expect(res.body.note.items).toEqual([
      { id: expect.any(String), text: 'milk', done: false },
      { id: expect.any(String), text: 'eggs', done: true },
    ]);
  });

  it('defaults to an empty checklist', async () => {
    const res = await as(owner).post('/notes', { title: 'Prose only' });

    expect(res.body.note.items).toEqual([]);
  });

  it('includes each note’s items in the list', async () => {
    const { noteId } = await listWith(['milk', 'eggs']);
    await as(owner).post('/notes', { title: 'Empty' });

    const res = await as(owner).get('/notes');
    const groceries = res.body.notes.find((note: { id: string }) => note.id === noteId);

    expect(groceries.items.map((item: Item) => item.text)).toEqual(['milk', 'eggs']);
    expect(res.body.notes.find((note: { id: string }) => note.id !== noteId).items).toEqual([]);
  });

  it('ignores items sent to PATCH /notes/:id', async () => {
    const { noteId } = await listWith(['milk']);
    await as(owner).patch(`/notes/${noteId}`, { title: 'Shopping', items: [] });

    expect(await textsOf(noteId)).toEqual(['milk']);
  });

  it('deletes the items with the note', async () => {
    const { noteId } = await listWith(['milk']);
    await as(owner).delete(`/notes/${noteId}`);

    expect(await db.selectFrom('noteItems').selectAll().execute()).toEqual([]);
  });
});

describe('POST /notes/:id/items', () => {
  it('adds to the bottom by default', async () => {
    const { noteId } = await listWith(['milk']);
    const res = await as(owner).post(`/notes/${noteId}/items`, { text: 'eggs' });

    expect(res.status).toBe(201);
    expect(res.body.item).toEqual({ id: expect.any(String), text: 'eggs', done: false });
    expect(await textsOf(noteId)).toEqual(['milk', 'eggs']);
  });

  it('adds to the top with after: null and after an item with its id', async () => {
    const { noteId, items } = await listWith(['milk', 'eggs']);
    await as(owner).post(`/notes/${noteId}/items`, { text: 'bread', after: null });
    await as(owner).post(`/notes/${noteId}/items`, { text: 'butter', after: items[0]!.id });

    expect(await textsOf(noteId)).toEqual(['bread', 'milk', 'butter', 'eggs']);
  });

  it('bumps the note’s updatedAt', async () => {
    const { noteId } = await listWith([]);
    const before = (await as(owner).get(`/notes/${noteId}`)).body.note.updatedAt;
    await as(owner).post(`/notes/${noteId}/items`, { text: 'milk' });
    const after = (await as(owner).get(`/notes/${noteId}`)).body.note.updatedAt;

    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('keeps every item when many are added after the same item at once', async () => {
    const { noteId, items } = await listWith(['first', 'last']);
    const texts = Array.from({ length: 20 }, (_, i) => `item ${i}`);

    const results = await Promise.all(
      texts.map((text) => as(owner).post(`/notes/${noteId}/items`, { text, after: items[0]!.id })),
    );

    expect(results.map((r) => r.status)).toEqual(texts.map(() => 201));
    const order = await textsOf(noteId);
    expect(order).toHaveLength(22);
    expect(order[0]).toBe('first');
    expect(order.at(-1)).toBe('last');
  });

  it('refuses a 501st item', async () => {
    const { noteId } = await listWith(Array.from({ length: 500 }, (_, i) => `item ${i}`));
    const res = await as(owner).post(`/notes/${noteId}/items`, { text: 'one too many' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('checklist_full');
  });

  it('rejects after pointing at an item in another note', async () => {
    const { noteId } = await listWith(['milk']);
    const other = await listWith(['elsewhere']);
    const res = await as(owner).post(`/notes/${noteId}/items`, {
      text: 'eggs',
      after: other.items[0]!.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_position');
  });

  it.each([
    ['a blank item', { text: ' ' }, 'text'],
    ['an item with a newline', { text: 'a\nb' }, 'text'],
    ['an item over 500 characters', { text: 'x'.repeat(501) }, 'text'],
    ['a non-boolean done', { text: 'a', done: 'yes' }, 'done'],
    ['an after that is not a UUID', { text: 'a', after: '1' }, 'after'],
  ])('rejects %s', async (_label, body, path) => {
    const { noteId } = await listWith([]);
    const res = await as(owner).post(`/notes/${noteId}/items`, body);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(path);
  });
});

describe('PATCH /notes/:id/items/:itemId', () => {
  it('ticks an item and edits its text without touching the others', async () => {
    const { noteId, items } = await listWith(['milk', 'eggs']);
    const res = await as(owner).patch(`/notes/${noteId}/items/${items[0]!.id}`, {
      text: 'oat milk',
      done: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({ id: items[0]!.id, text: 'oat milk', done: true });
    expect((await as(owner).get(`/notes/${noteId}`)).body.note.items[1]).toEqual(items[1]);
  });

  it('moves an item by rewriting only that item’s position', async () => {
    const { noteId, items } = await listWith(['a', 'b', 'c', 'd']);
    const positionsBefore = await db.selectFrom('noteItems').select(['id', 'position']).execute();

    await as(owner).patch(`/notes/${noteId}/items/${items[3]!.id}`, { after: items[0]!.id });
    await as(owner).patch(`/notes/${noteId}/items/${items[1]!.id}`, { after: null });

    expect(await textsOf(noteId)).toEqual(['b', 'a', 'd', 'c']);
    const positionsAfter = await db.selectFrom('noteItems').select(['id', 'position']).execute();
    const changed = positionsAfter.filter(
      (row) => positionsBefore.find((old) => old.id === row.id)?.position !== row.position,
    );
    expect(changed.map((row) => row.id).sort()).toEqual([items[1]!.id, items[3]!.id].sort());
  });

  it('keeps every change when different items are ticked at once', async () => {
    const { noteId, items } = await listWith(Array.from({ length: 20 }, (_, i) => `item ${i}`));

    await Promise.all(
      items.map((item) => as(owner).patch(`/notes/${noteId}/items/${item.id}`, { done: true })),
    );

    const res = await as(owner).get(`/notes/${noteId}`);
    expect(res.body.note.items.every((item: Item) => item.done)).toBe(true);
  });

  it('rejects placing an item after itself and an empty update', async () => {
    const { noteId, items } = await listWith(['milk']);
    const path = `/notes/${noteId}/items/${items[0]!.id}`;

    expect((await as(owner).patch(path, { after: items[0]!.id })).body.error.code).toBe(
      'invalid_position',
    );
    expect((await as(owner).patch(path, {})).status).toBe(400);
  });

  it('returns 404 for an item that belongs to another note', async () => {
    const { noteId } = await listWith(['milk']);
    const other = await listWith(['elsewhere']);
    const res = await as(owner).patch(`/notes/${noteId}/items/${other.items[0]!.id}`, {
      done: true,
    });

    expect(res.status).toBe(404);
    expect((await textsOf(other.noteId)).length).toBe(1);
  });
});

describe('DELETE /notes/:id/items/:itemId', () => {
  it('removes only that item', async () => {
    const { noteId, items } = await listWith(['milk', 'eggs']);

    expect((await as(owner).delete(`/notes/${noteId}/items/${items[0]!.id}`)).status).toBe(204);
    expect(await textsOf(noteId)).toEqual(['eggs']);
  });

  it('returns 404 for an item that does not exist', async () => {
    const { noteId } = await listWith([]);

    expect((await as(owner).delete(`/notes/${noteId}/items/${MISSING_ID}`)).status).toBe(404);
  });
});

describe('strangers', () => {
  it('get 404 on every item route and change nothing', async () => {
    const { noteId, items } = await listWith(['milk']);
    const itemPath = `/notes/${noteId}/items/${items[0]!.id}`;

    expect((await as(stranger).post(`/notes/${noteId}/items`, { text: 'x' })).status).toBe(404);
    expect((await as(stranger).patch(itemPath, { done: true })).status).toBe(404);
    expect((await as(stranger).delete(itemPath)).status).toBe(404);
    expect((await as(owner).get(`/notes/${noteId}`)).body.note.items).toEqual(items);
  });
});
