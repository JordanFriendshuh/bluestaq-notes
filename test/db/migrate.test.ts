import { readdir } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openTestDb } from '../helpers/db.js';

const { pool, db } = openTestDb();

afterAll(() => db.destroy());

describe('runMigrations', () => {
  it('records every migration file and applies nothing on a second run', async () => {
    const files = (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );

    expect(rows.map((r) => r.name)).toEqual(files);
    expect(await runMigrations(pool)).toEqual([]);
  });

  it('installs the extensions the schema depends on', async () => {
    const { rows } = await pool.query<{ extname: string }>('SELECT extname FROM pg_extension');
    const installed = rows.map((r) => r.extname);

    expect(installed).toEqual(expect.arrayContaining(['citext', 'pg_trgm', 'vector']));
  });
});
