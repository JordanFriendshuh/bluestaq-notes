import { readFileSync } from 'node:fs';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

export type Db = Kysely<Database>;

export interface DbTls {
  mode: 'verify' | 'off';
  caFile?: string;
}

/** Wraps a pg pool in a typed Kysely instance; destroying the instance ends the pool. */
export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

/** Opens a pool that, unless TLS is off, verifies the server certificate and hostname. */
export function createPool(connectionString: string, tls: DbTls): pg.Pool {
  const ssl =
    tls.mode === 'off'
      ? false
      : {
          rejectUnauthorized: true,
          ...(tls.caFile && { ca: readFileSync(tls.caFile, 'utf8') }),
        };
  return new pg.Pool({ connectionString, ssl });
}
