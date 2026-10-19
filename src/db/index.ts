import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export type Db = Kysely<Database>;

/** Wraps a pg pool in a typed Kysely instance; destroying the instance ends the pool. */
export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}
