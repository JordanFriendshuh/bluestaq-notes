import express from 'express';
import { sql } from 'kysely';
import { authRoutes, type AuthSettings } from './auth/routes.js';
import type { Db } from './db/index.js';
import { errorHandler, unknownRoute } from './http/error-handler.js';

export interface AppDeps {
  db: Db;
  auth: AuthSettings;
}

/** Builds the Express app without listening, so the server and the tests share the same wiring. */
export function createApp({ db, auth }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_req, res) => {
    await sql`SELECT 1`.execute(db);
    res.json({ status: 'ok' });
  });
  app.use(authRoutes(db, auth));

  app.use(unknownRoute);
  app.use(errorHandler);
  return app;
}
