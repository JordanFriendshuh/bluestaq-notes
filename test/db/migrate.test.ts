import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('runMigrations with a broken or contested migration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrations-'));
  });
  afterEach(async () => {
    await pool.query("DELETE FROM schema_migrations WHERE name LIKE '9%_probe.sql'");
    await pool.query('DROP TABLE IF EXISTS migration_probe');
    await rm(dir, { recursive: true });
  });

  it('rolls back a failing migration completely and does not record it', async () => {
    await writeFile(
      join(dir, '900_probe.sql'),
      'CREATE TABLE migration_probe (id int); SELECT 1 / 0;',
    );

    await expect(runMigrations(pool, dir)).rejects.toThrow('Migration 900_probe.sql failed');
    const { rows } = await pool.query("SELECT to_regclass('migration_probe') AS t");
    const recorded = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = '900_probe.sql'",
    );
    expect(rows[0].t).toBeNull();
    expect(recorded.rowCount).toBe(0);
  });

  it('applies a migration exactly once when several processes start together', async () => {
    await writeFile(join(dir, '901_probe.sql'), 'CREATE TABLE migration_probe (id int);');

    const results = await Promise.all([1, 2, 3].map(() => runMigrations(pool, dir)));

    expect(results.flat()).toEqual(['901_probe.sql']);
  });
});
