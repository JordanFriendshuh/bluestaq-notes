import { sql } from 'kysely';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { AuthSettings } from '../../src/auth/routes.js';
import type { Db } from '../../src/db/index.js';
import { openTestDb } from './db.js';

export const testAuth: AuthSettings = {
  jwtSecret: 'test-secret-that-is-at-least-32-characters',
  tokenTtlSeconds: 3600,
  bcryptRounds: 4,
  rateLimit: { windowSeconds: 60, limit: 10_000 },
};

/** An app wired to the test database with fast password hashing; overrides adjust auth settings. */
export function createTestApp(overrides: Partial<AuthSettings> = {}) {
  const { pool, db } = openTestDb();
  return { app: createApp({ db, auth: { ...testAuth, ...overrides } }), db, pool };
}

/** Empties every application table, keeping the migration history; refuses to touch a non-test database. */
export async function resetDb(db: Db) {
  const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  if (!rows[0]?.name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${rows[0]?.name}": name must end in _test`);
  }
  await sql`
    DO $$ DECLARE t text;
    BEGIN
      FOR t IN SELECT tablename FROM pg_tables
               WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      LOOP EXECUTE format('TRUNCATE %I CASCADE', t); END LOOP;
    END $$`.execute(db);
}

let userCounter = 0;

/** Registers a fresh user and returns their token and profile. */
export async function registerTestUser(app: Parameters<typeof request>[0], name = 'user') {
  userCounter += 1;
  const res = await request(app)
    .post('/auth/register')
    .send({
      email: `${name}${userCounter}@example.com`,
      password: 'correct horse battery',
      displayName: name,
    });
  return res.body as { token: string; user: { id: string; email: string } };
}
