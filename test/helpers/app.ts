import { sql } from 'kysely';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/index.js';
import { openTestDb } from './db.js';

export const testAuth = {
  jwtSecret: 'test-secret-that-is-at-least-32-characters',
  tokenTtlSeconds: 3600,
  bcryptRounds: 4,
};

/** An app wired to the test database with fast password hashing. */
export function createTestApp() {
  const { pool, db } = openTestDb();
  return { app: createApp({ db, auth: testAuth }), db, pool };
}

/** Empties every application table, keeping the migration history. */
export async function resetDb(db: Db) {
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
