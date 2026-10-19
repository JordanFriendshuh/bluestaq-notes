import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';

const { app, db } = createTestApp();

afterAll(() => db.destroy());

describe('app', () => {
  it('reports health when the database answers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns the standard error body for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Route not found' } });
  });

  it('rejects malformed JSON with a 400', async () => {
    const res = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });
});
