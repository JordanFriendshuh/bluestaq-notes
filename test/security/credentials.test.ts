import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { NoteEvents } from '../../src/events.js';
import { dummyHash } from '../../src/auth/service.js';
import { createTestApp, resetDb, testAuth } from '../helpers/app.js';

const victim = { email: 'victim@example.com', password: 'correct horse battery', displayName: 'V' };

describe('brute force', () => {
  const { db } = createTestApp();
  // Each test gets a fresh app so its rate-limit counter starts at zero.
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await resetDb(db);
    app = createApp({
      db,
      auth: { ...testAuth, rateLimit: { windowSeconds: 60, limit: 3 } },
      events: new NoteEvents(),
    });
  });
  afterAll(() => db.destroy());

  it('stops password guessing with a 429 once the limit is reached', async () => {
    const guess = (password: string) =>
      request(app).post('/auth/login').send({ email: victim.email, password });

    const statuses = [];
    for (const password of ['a1', 'b2', 'c3', 'd4', 'e5'])
      statuses.push((await guess(password)).status);

    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  it('blocks the correct password too once limited, so guessing cannot continue', async () => {
    const login = (password: string) =>
      request(app).post('/auth/login').send({ email: victim.email, password });
    await request(app).post('/auth/register').send(victim);
    await login('wrong-1');
    await login('wrong-2');

    const res = await login(victim.password);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.headers).toHaveProperty('ratelimit-policy');
  });

  it('counts registrations against the same limit', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/auth/register')
        .send({ ...victim, email: `spam${i}@example.com` });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([201, 201, 201, 429]);
  });
});

describe('account enumeration', () => {
  it('compares unknown emails against a hash with the same cost as real ones', () => {
    for (const rounds of [4, 10, 12]) {
      expect(bcrypt.getRounds(dummyHash(rounds))).toBe(rounds);
    }
  });
});
