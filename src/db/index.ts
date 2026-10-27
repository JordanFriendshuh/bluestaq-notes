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

// Every query here is small and index-driven. JIT compilation and parallel workers cost more to start
// than these queries take (measured: 20 ms -> 4 ms for the notes list), so both are off per session.
const SESSION_OPTIONS = '-c jit=off -c max_parallel_workers_per_gather=0';

/** Opens a pool that, unless TLS is off, verifies the server certificate and hostname. */
export function createPool(connectionString: string, tls: DbTls): pg.Pool {
  const ssl =
    tls.mode === 'off'
      ? false
      : {
          rejectUnauthorized: true,
          ...(tls.caFile && { ca: readFileSync(tls.caFile, 'utf8') }),
        };
  return new pg.Pool({ connectionString, ssl, options: SESSION_OPTIONS });
}
