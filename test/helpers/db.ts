import { createDb, createPool } from '../../src/db/index.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://notes:notes@localhost:5432/notes_test';

/** Opens a pool and Kysely instance on the test database; call db.destroy() in afterAll. */
export function openTestDb() {
  const pool = createPool(TEST_DATABASE_URL);
  return { pool, db: createDb(pool) };
}
