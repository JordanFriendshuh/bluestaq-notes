import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './logger.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

const applied = await runMigrations(pool);
if (applied.length > 0) logger.info({ applied }, 'migrations applied');

const db = createDb(pool);
const auth = {
  jwtSecret: config.JWT_SECRET,
  tokenTtlSeconds: config.TOKEN_TTL_SECONDS,
  bcryptRounds: config.BCRYPT_ROUNDS,
};
const server = createApp({ db, auth }).listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'listening');
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
