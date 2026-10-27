import express from 'express';
import helmet from 'helmet';
import { sql } from 'kysely';
import { authRoutes, type AuthSettings } from './auth/routes.js';
import type { Db } from './db/index.js';
import { errorHandler, unknownRoute } from './http/error-handler.js';
import { teamRoutes } from './teams/routes.js';

export interface AppDeps {
  db: Db;
  auth: AuthSettings;
  behindProxy?: boolean;
}

/** Builds the Express app without listening, so the server and the tests share the same wiring. */
export function createApp({ db, auth, behindProxy = false }: AppDeps) {
  const app = express();
  // Behind a TLS-terminating proxy, req.ip must come from X-Forwarded-For or every client shares one rate limit.
  app.set('trust proxy', behindProxy ? 1 : false);
  app.use(helmet());
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_req, res) => {
    await sql`SELECT 1`.execute(db);
    res.json({ status: 'ok' });
  });
  app.use(authRoutes(db, auth));
  app.use(teamRoutes(db, auth));

  app.use(unknownRoute);
  app.use(errorHandler);
  return app;
}
