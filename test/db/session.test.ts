import { sql } from 'kysely';
import { afterAll, expect, it } from 'vitest';
import { openTestDb } from '../helpers/db.js';

const { db } = openTestDb();
afterAll(() => db.destroy());

it('turns off JIT and parallel workers on every connection', async () => {
  const { rows } = await sql<{ jit: string; workers: string }>`
    SELECT current_setting('jit') AS jit,
           current_setting('max_parallel_workers_per_gather') AS workers`.execute(db);

  expect(rows[0]).toEqual({ jit: 'off', workers: '0' });
});
