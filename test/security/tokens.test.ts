import jwt, { type SignOptions } from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb, testAuth } from '../helpers/app.js';

const { app, db } = createTestApp();
let userId: string;

beforeAll(async () => {
  await resetDb(db);
  userId = (await registerTestUser(app, 'victim')).user.id;
});
afterAll(() => db.destroy());

/** Builds a token that matches a real one in every respect except the overrides. */
function forgeToken(
  overrides: { secret?: string; claims?: object; options?: SignOptions } = {},
): string {
  return jwt.sign(overrides.claims ?? {}, overrides.secret ?? testAuth.jwtSecret, {
    subject: userId,
    expiresIn: 60,
    algorithm: 'HS256',
    issuer: 'team-notes-api',
    audience: 'team-notes-api',
    ...overrides.options,
  });
}

const meWith = (authorization: string) =>
  request(app).get('/me').set('Authorization', authorization);

describe('bearer token attacks', () => {
  it('accepts the unmodified forged token, proving each case below fails for its own reason', async () => {
    expect((await meWith(`Bearer ${forgeToken()}`)).status).toBe(200);
  });

  it.each<[string, () => string]>([
    ['signed with another secret', () => forgeToken({ secret: 'x'.repeat(40) })],
    ['expired', () => forgeToken({ options: { expiresIn: -10 } })],
    ['not yet valid', () => forgeToken({ options: { notBefore: 3600 } })],
    ['from another issuer', () => forgeToken({ options: { issuer: 'other-service' } })],
    ['meant for another audience', () => forgeToken({ options: { audience: 'other-api' } })],
    [
      'for a subject that is not a user id',
      () => forgeToken({ options: { subject: "1' OR '1'='1" } }),
    ],
    [
      'without a subject',
      () =>
        jwt.sign({}, testAuth.jwtSecret, {
          expiresIn: 60,
          issuer: 'team-notes-api',
          audience: 'team-notes-api',
        }),
    ],
    ['unsigned (alg: none)', () => jwt.sign({ sub: userId }, '', { algorithm: 'none' })],
    ['with a tampered payload', () => tamperPayload(forgeToken())],
  ])('rejects a token %s', async (_label, makeToken) => {
    const res = await meWith(`Bearer ${makeToken()}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('rejects an HS256 token signed with a guessable empty-ish secret', async () => {
    const token = jwt.sign({ sub: userId }, 'secret', { algorithm: 'HS256' });

    expect((await meWith(`Bearer ${token}`)).status).toBe(401);
  });
});

describe('Authorization header parsing', () => {
  it('accepts the scheme name in any case', async () => {
    expect((await meWith(`bearer ${forgeToken()}`)).status).toBe(200);
  });

  it.each([
    ['another scheme', () => `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['a scheme with no token', () => 'Bearer'],
    ['a raw token with no scheme', () => forgeToken()],
    ['two tokens', () => `Bearer ${forgeToken()} ${forgeToken()}`],
  ])('rejects %s', async (_label, header) => {
    expect((await meWith(header())).status).toBe(401);
  });
});

/** Swaps the payload for one naming a different subject while keeping the original signature. */
function tamperPayload(token: string): string {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  claims.sub = '00000000-0000-4000-8000-000000000000';
  return [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');
}
