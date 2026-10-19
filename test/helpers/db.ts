import { createDb, createPool } from '../../src/db/index.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://notes:notes@localhost:5432/notes_test';

export const TEST_DB_TLS = {
  mode: 'verify' as const,
  caFile: process.env.TEST_DATABASE_CA_FILE ?? 'secrets/ca.crt',
};

/** Opens a TLS-verified pool and Kysely instance on the test database; call db.destroy() in afterAll. */
export function openTestDb() {
  const pool = createPool(TEST_DATABASE_URL, TEST_DB_TLS);
  return { pool, db: createDb(pool) };
}
