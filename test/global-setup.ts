import { createPool } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { TEST_DATABASE_URL } from './helpers/db.js';

/** Brings the test database schema up to date once before any test file runs. */
export default async function setup() {
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
