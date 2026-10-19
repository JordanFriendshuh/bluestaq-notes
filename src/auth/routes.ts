import { Router } from 'express';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import { callerId, requireAuth } from './middleware.js';
import { loginSchema, registerSchema } from './schemas.js';
import { authenticate, findUserById, registerUser } from './service.js';
import { signToken, type TokenSettings } from './tokens.js';

export interface AuthSettings extends TokenSettings {
  bcryptRounds: number;
}

export function authRoutes(db: Db, settings: AuthSettings): Router {
  const router = Router();

  router.post('/auth/register', async (req, res) => {
    const input = parse(registerSchema, req.body);
    const user = await registerUser(db, input, settings.bcryptRounds);
    res.status(201).json({ token: signToken(user.id, settings), user });
  });

  router.post('/auth/login', async (req, res) => {
    const input = parse(loginSchema, req.body);
    const user = await authenticate(db, input);
    res.json({ token: signToken(user.id, settings), user });
  });

  router.get('/me', requireAuth(settings), async (req, res) => {
    const user = await findUserById(db, callerId(req));
    if (!user) throw new HttpError(401, 'unauthenticated', 'Account no longer exists');
    res.json({ user });
  });

  return router;
}
