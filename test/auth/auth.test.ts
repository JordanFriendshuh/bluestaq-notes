import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDb, testAuth } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

const alice = {
  email: 'alice@example.com',
  password: 'correct horse battery',
  displayName: 'Alice',
};

const register = (body: object) => request(app).post('/auth/register').send(body);
const login = (body: object) => request(app).post('/auth/login').send(body);
const me = (token?: string) => {
  const req = request(app).get('/me');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('POST /auth/register', () => {
  it('creates the user and returns a working token without the password hash', async () => {
    const res = await register(alice);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: alice.email, displayName: 'Alice' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect((await me(res.body.token)).body.user.id).toBe(res.body.user.id);
  });

  it('rejects an email that is already taken, ignoring case', async () => {
    await register(alice);
    const res = await register({ ...alice, email: 'ALICE@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it.each([
    ['an invalid email', { ...alice, email: 'not-an-email' }],
    ['a short password', { ...alice, password: 'short' }],
    ['a password over 72 bytes', { ...alice, password: 'é'.repeat(37) }],
    ['a blank display name', { ...alice, displayName: '   ' }],
    ['a missing field', { email: alice.email, password: alice.password }],
  ])('rejects %s', async (_label, body) => {
    const res = await register(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('POST /auth/login', () => {
  beforeEach(() => register(alice));

  it('returns a token for correct credentials, with the email in any case', async () => {
    const res = await login({ email: 'Alice@Example.com', password: alice.password });

    expect(res.status).toBe(200);
    expect((await me(res.body.token)).status).toBe(200);
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const wrongPassword = await login({ email: alice.email, password: 'wrong password!' });
    const unknownEmail = await login({ email: 'bob@example.com', password: alice.password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });
});

describe('GET /me', () => {
  it('requires a token', async () => {
    const res = await me();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('rejects a token signed with another secret', async () => {
    const { body } = await register(alice);
    const forged = jwt.sign({}, 'some-other-secret-at-least-32-characters', {
      subject: body.user.id,
    });

    expect((await me(forged)).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const { body } = await register(alice);
    const expired = jwt.sign({ exp: Math.floor(Date.now() / 1000) - 10 }, testAuth.jwtSecret, {
      subject: body.user.id,
    });

    expect((await me(expired)).status).toBe(401);
  });

  it('rejects an unsigned token', async () => {
    const { body } = await register(alice);
    const unsigned = jwt.sign({}, '', { subject: body.user.id, algorithm: 'none' });

    expect((await me(unsigned)).status).toBe(401);
  });

  it('rejects a valid token for an account that no longer exists', async () => {
    const { body } = await register(alice);
    await resetDb(db);

    expect((await me(body.token)).status).toBe(401);
  });
});
