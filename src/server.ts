import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createServer } from './http/create-server.js';
import { logger } from './logger.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, {
  mode: config.DATABASE_TLS,
  caFile: config.DATABASE_CA_FILE,
});

const applied = await runMigrations(pool);
if (applied.length > 0) logger.info({ applied }, 'migrations applied');

const db = createDb(pool);
const auth = {
  jwtSecret: config.JWT_SECRET,
  tokenTtlSeconds: config.TOKEN_TTL_SECONDS,
  bcryptRounds: config.BCRYPT_ROUNDS,
};
const tls =
  config.TLS_CERT_FILE && config.TLS_KEY_FILE
    ? { certFile: config.TLS_CERT_FILE, keyFile: config.TLS_KEY_FILE }
    : undefined;

const server = createServer(createApp({ db, auth }), tls).listen(config.PORT, () => {
  logger.info({ port: config.PORT, https: Boolean(tls) }, 'listening');
});

/** Stops taking connections, lets in-flight requests finish, then closes the pool. */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void db.destroy().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
