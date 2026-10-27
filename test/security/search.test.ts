import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('search input', () => {
  it.each([
    "'; DROP TABLE notes; --",
    'budget:* | !secret',
    'a & b | (c',
    "budget') || to_tsquery('english', 'x",
    '\\',
    '%_%',
  ])('treats %s as plain words', async (q) => {
    const user = await registerTestUser(app, 'user');
    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'budget' });

    const res = await request(app)
      .get(`/notes?q=${encodeURIComponent(q)}`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.status).toBe(200);
    const count = await db
      .selectFrom('notes')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirst();
    expect(Number(count?.n)).toBe(1);
  });
});

describe('the search index column', () => {
  it('never appears in a response', async () => {
    const user = await registerTestUser(app, 'user');
    const auth = `Bearer ${user.token}`;
    const created = await request(app)
      .post('/notes')
      .set('Authorization', auth)
      .send({ title: 'x' });
    const id = created.body.note.id;

    const responses = [
      created,
      await request(app).get(`/notes/${id}`).set('Authorization', auth),
      await request(app)
        .patch(`/notes/${id}`)
        .set('Authorization', auth)
        .set('If-Match', '"1"')
        .send({ body: 'y' }),
      await request(app).get('/notes').set('Authorization', auth),
      await request(app).get('/notes?q=x').set('Authorization', auth),
    ];
    for (const res of responses) expect(JSON.stringify(res.body)).not.toContain('"search"');
  });
});
