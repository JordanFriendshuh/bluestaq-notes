import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

describe('owning one note grants nothing on others', () => {
  it('a user with notes of their own still gets 404 on someone else’s note everywhere', async () => {
    const alice = await registerTestUser(app, 'alice');
    const mallory = await registerTestUser(app, 'mallory');
    const auth = (user: typeof alice) => `Bearer ${user.token}`;
    const victim = (
      await request(app).post('/notes').set('Authorization', auth(alice)).send({ title: 'Private' })
    ).body.note.id;
    await request(app).post('/notes').set('Authorization', auth(mallory)).send({ title: 'Mine' });

    const attempts = [
      request(app).get(`/notes/${victim}`),
      request(app).patch(`/notes/${victim}`).set('If-Match', '"1"').send({ title: 'pwned' }),
      request(app).post(`/notes/${victim}/items`).send({ text: 'pwned' }),
      request(app).get(`/notes/${victim}/shares`),
      request(app)
        .put(`/notes/${victim}/shares`)
        .send({ userEmail: mallory.user.email, role: 'editor' }),
      request(app).delete(`/notes/${victim}`),
    ];
    for (const attempt of attempts) {
      expect((await attempt.set('Authorization', auth(mallory))).status).toBe(404);
    }

    const list = await request(app).get('/notes').set('Authorization', auth(mallory));
    expect(list.body.notes.map((n: { title: string }) => n.title)).toEqual(['Mine']);
    const note = await request(app).get(`/notes/${victim}`).set('Authorization', auth(alice));
    expect(note.body.note).toMatchObject({ title: 'Private', items: [] });
  });
});
