import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;

let owner: TestUser;
let stranger: TestUser;

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
  stranger = await registerTestUser(app, 'stranger');
});

const auth = (user: TestUser) => `Bearer ${user.token}`;
const get = (path: string, user = owner) => request(app).get(path).set('Authorization', auth(user));
const post = (path: string, body: object) =>
  request(app).post(path).set('Authorization', auth(owner)).send(body);

/** PATCH with an If-Match header; pass null to leave the header off. */
const patch = (path: string, ifMatch: string | null, body: object, user = owner) => {
  const req = request(app).patch(path).set('Authorization', auth(user));
  return (ifMatch === null ? req : req.set('If-Match', ifMatch)).send(body);
};

async function newNote(items: string[] = []) {
  const res = await post('/notes', {
    title: 'Plan',
    body: 'draft',
    items: items.map((text) => ({ text })),
  });
  return res.body.note as { id: string; items: { id: string }[] };
}

describe('note versions', () => {
  it('starts at version 1 and returns it as an ETag', async () => {
    const note = await newNote();
    const res = await get(`/notes/${note.id}`);

    expect(res.headers.etag).toBe('"1"');
    expect(res.body.note.version).toBe(1);
  });

  it('applies a PATCH with the current version and bumps it', async () => {
    const note = await newNote();
    const res = await patch(`/notes/${note.id}`, '"1"', { title: 'Plan B' });

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(res.body.note).toMatchObject({ title: 'Plan B', version: 2 });
  });

  it('accepts a bare number for convenience', async () => {
    const note = await newNote();

    expect((await patch(`/notes/${note.id}`, '1', { title: 'x' })).status).toBe(200);
  });

  it('requires If-Match', async () => {
    const note = await newNote();
    const res = await patch(`/notes/${note.id}`, null, { title: 'x' });

    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('precondition_required');
  });

  it.each(['*', 'W/"1"', '"abc"', '"1", "2"', '"9999999999"'])(
    'rejects If-Match %s',
    async (ifMatch) => {
      const note = await newNote();
      const res = await patch(`/notes/${note.id}`, ifMatch, { title: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_if_match');
    },
  );

  it('refuses a stale version with 409 and the current note, changing nothing', async () => {
    const note = await newNote();
    await patch(`/notes/${note.id}`, '"1"', { body: 'their edit' });

    const res = await patch(`/notes/${note.id}`, '"1"', { body: 'my edit' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'version_conflict',
      current: { id: note.id, body: 'their edit', version: 2 },
    });
    expect((await get(`/notes/${note.id}`)).body.note.body).toBe('their edit');
  });

  it('lets exactly one of many simultaneous saves of the same version win', async () => {
    const note = await newNote();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        patch(`/notes/${note.id}`, '"1"', { body: `edit ${i}` }),
      ),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, ...Array(9).fill(409)]);
    const winner = results.find((r) => r.status === 200)!;
    expect((await get(`/notes/${note.id}`)).body.note).toMatchObject({
      body: winner.body.note.body,
      version: 2,
    });
  });

  it('gives a stranger 404, not 409, even with a stale version', async () => {
    const note = await newNote();
    await patch(`/notes/${note.id}`, '"1"', { title: 'x' });

    expect((await patch(`/notes/${note.id}`, '"1"', { title: 'y' }, stranger)).status).toBe(404);
  });
});

describe('item versions', () => {
  it('versions each item on its own', async () => {
    const note = await newNote(['milk', 'eggs']);
    const [milk, eggs] = note.items;

    const res = await patch(`/notes/${note.id}/items/${milk!.id}`, '"1"', { done: true });
    const after = (await get(`/notes/${note.id}`)).body.note.items;

    expect(res.headers.etag).toBe('"2"');
    expect(after.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    expect((await patch(`/notes/${note.id}/items/${eggs!.id}`, '"1"', { done: true })).status).toBe(
      200,
    );
  });

  it('refuses a stale item version with 409 and the current item', async () => {
    const note = await newNote(['milk']);
    const path = `/notes/${note.id}/items/${note.items[0]!.id}`;
    await patch(path, '"1"', { text: 'oat milk' });

    const res = await patch(path, '"1"', { done: true });

    expect(res.status).toBe(409);
    expect(res.body.error.current).toMatchObject({ text: 'oat milk', done: false, version: 2 });
  });

  it('lets exactly one of many simultaneous edits to the same item win', async () => {
    const note = await newNote(['milk']);
    const path = `/notes/${note.id}/items/${note.items[0]!.id}`;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => patch(path, '"1"', { text: `milk ${i}` })),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, ...Array(9).fill(409)]);
  });

  it('requires If-Match on item updates', async () => {
    const note = await newNote(['milk']);
    const res = await patch(`/notes/${note.id}/items/${note.items[0]!.id}`, null, { done: true });

    expect(res.status).toBe(428);
  });

  it('never changes the note version when items change', async () => {
    const note = await newNote(['milk']);
    await post(`/notes/${note.id}/items`, { text: 'eggs' });
    await patch(`/notes/${note.id}/items/${note.items[0]!.id}`, '"1"', { done: true });

    expect((await patch(`/notes/${note.id}`, '"1"', { title: 'Still v1' })).status).toBe(200);
  });
});
