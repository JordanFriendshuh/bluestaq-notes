import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, createPool } from './db/index.js';
import { NoteEvents } from './events.js';
import { runMigrations } from './db/migrate.js';
import { createServer } from './http/create-server.js';
import { logger } from './logger.js';
import { attachPresence } from './presence/socket.js';

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
  rateLimit: { windowSeconds: config.AUTH_RATE_WINDOW_SECONDS, limit: config.AUTH_RATE_LIMIT },
};
const tls =
  config.TLS_CERT_FILE && config.TLS_KEY_FILE
    ? { certFile: config.TLS_CERT_FILE, keyFile: config.TLS_KEY_FILE }
    : undefined;

const events = new NoteEvents();
const app = createApp({ db, auth, events, behindProxy: config.TLS_TERMINATED_UPSTREAM });
const server = createServer(app, tls);
const presence = attachPresence(server, { db, auth, events });
server.listen(config.PORT, () => {
  logger.info({ port: config.PORT, https: Boolean(tls) }, 'listening');
});

/** Drops WebSockets, stops taking connections, lets in-flight requests finish, then closes the pool. */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  void presence.close();
  server.close(() => {
    void db.destroy().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
