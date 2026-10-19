import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';

const { app, db } = createTestApp();

afterAll(() => db.destroy());

describe('security headers', () => {
  it('sends HSTS, nosniff and frame protection, and hides the framework', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers).not.toHaveProperty('x-powered-by');
  });

  it('sends the same headers on error responses', async () => {
    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never returns a stack trace or internal detail in an error', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
  });
});
