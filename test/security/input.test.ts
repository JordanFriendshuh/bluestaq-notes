import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

const valid = { email: 'eve@example.com', password: 'correct horse battery', displayName: 'Eve' };
const register = (body: unknown) =>
  request(app)
    .post('/auth/register')
    .send(body as object);

describe('SQL injection', () => {
  it('stores injection payloads as plain text and leaves the schema intact', async () => {
    const payload = "Robert'); DROP TABLE users;--";
    const res = await register({ ...valid, displayName: payload });

    expect(res.status).toBe(201);
    expect(res.body.user.displayName).toBe(payload);
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM users`.execute(db);
    expect(rows[0]?.n).toBe(1);
  });

  it.each(["' OR '1'='1", "admin@example.com' --", 'x@example.com; DROP TABLE users'])(
    'rejects the login email %s without touching the query',
    async (email) => {
      await register(valid);
      const res = await request(app).post('/auth/login').send({ email, password: "' OR '1'='1" });

      expect(res.status).toBe(400);
    },
  );

  it('does not log in with an injection password against a real account', async () => {
    await register(valid);
    const res = await request(app)
      .post('/auth/login')
      .send({ email: valid.email, password: "' OR '1'='1" });

    expect(res.status).toBe(401);
  });
});

describe('mass assignment and prototype pollution', () => {
  it('ignores fields the client is not allowed to set', async () => {
    const res = await register({
      ...valid,
      id: '00000000-0000-4000-8000-000000000000',
      passwordHash: 'attacker-chosen',
      createdAt: '1999-01-01T00:00:00Z',
      role: 'admin',
    });

    expect(res.status).toBe(201);
    expect(res.body.user.id).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(res.body.user).not.toHaveProperty('role');
    const login = await request(app)
      .post('/auth/login')
      .send({ email: valid.email, password: valid.password });
    expect(login.status).toBe(200);
  });

  it('does not let __proto__ or constructor keys pollute objects', async () => {
    const res = await request(app)
      .post('/auth/register')
      .set('Content-Type', 'application/json')
      .send(
        `{"email":"${valid.email}","password":"${valid.password}","displayName":"Eve",` +
          `"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
      );

    expect(res.status).toBe(201);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('hostile strings', () => {
  it.each([
    ['a NUL byte', 'Eve\u0000Admin'],
    ['a newline (log and header injection)', 'Eve\nAdmin'],
    ['a carriage return', 'Eve\r\nSet-Cookie: x'],
    ['an escape sequence (terminal injection)', 'Eve\u001b[31m'],
  ])('rejects a display name with %s as a 400, not a 500', async (_label, displayName) => {
    const res = await register({ ...valid, displayName });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('displayName');
  });

  it('rejects a password containing a NUL byte', async () => {
    const res = await register({ ...valid, password: 'correct\u0000horse' });

    expect(res.status).toBe(400);
  });

  it('accepts ordinary Unicode and emoji in display names', async () => {
    const res = await register({ ...valid, displayName: 'Zoë 李 🚀' });

    expect(res.status).toBe(201);
    expect(res.body.user.displayName).toBe('Zoë 李 🚀');
  });

  it('rejects a login password longer than bcrypt can compare', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: valid.email, password: 'a'.repeat(10_000) });

    expect(res.status).toBe(400);
  });
});

describe('malformed requests', () => {
  it('rejects a body over the size limit with a 413', async () => {
    const res = await register({ ...valid, displayName: 'x'.repeat(300 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('rejects an unsupported charset with a 415 instead of crashing', async () => {
    const res = await request(app)
      .post('/auth/register')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .send(JSON.stringify(valid));

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
  ])('rejects %s as the body', async (_label, body) => {
    const res = await request(app)
      .post('/auth/register')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(400);
  });

  it('rejects a form-encoded body instead of reading it', async () => {
    const res = await request(app)
      .post('/auth/register')
      .type('form')
      .send(new URLSearchParams(valid).toString());

    expect(res.status).toBe(400);
  });

  it.each([
    ['a number', { ...valid, email: 12345 }],
    ['an object', { ...valid, password: { $gt: '' } }],
    ['an array', { ...valid, displayName: ['Eve', 'Admin'] }],
  ])('rejects %s where a string belongs', async (_label, body) => {
    expect((await register(body)).status).toBe(400);
  });
});

describe('races', () => {
  it('lets exactly one of many simultaneous signups with one email through', async () => {
    const emails = ['race@example.com', 'RACE@example.com', 'Race@Example.com', 'race@example.com'];
    const results = await Promise.all(emails.map((email) => register({ ...valid, email })));

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });
});
