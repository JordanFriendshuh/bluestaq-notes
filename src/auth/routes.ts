import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import { callerId, requireAuth } from './middleware.js';
import { loginSchema, registerSchema } from './schemas.js';
import { authenticate, findUserById, registerUser } from './service.js';
import { signToken, type TokenSettings } from './tokens.js';

export interface AuthSettings extends TokenSettings {
  bcryptRounds: number;
  rateLimit: { windowSeconds: number; limit: number };
}

/** Per-IP cap on credential endpoints, against password guessing and bcrypt CPU exhaustion. */
function credentialRateLimit({ windowSeconds, limit }: AuthSettings['rateLimit']) {
  return rateLimit({
    windowMs: windowSeconds * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new HttpError(429, 'rate_limited', 'Too many attempts, try again later'));
    },
  });
}

export function authRoutes(db: Db, settings: AuthSettings): Router {
  const router = Router();
  const limitCredentials = credentialRateLimit(settings.rateLimit);

  router.post('/auth/register', limitCredentials, async (req, res) => {
    const input = parse(registerSchema, req.body);
    const user = await registerUser(db, input, settings.bcryptRounds);
    res.status(201).json({ token: signToken(user.id, settings), user });
  });

  router.post('/auth/login', limitCredentials, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const user = await authenticate(db, input, settings.bcryptRounds);
    res.json({ token: signToken(user.id, settings), user });
  });

  router.get('/me', requireAuth(settings), async (req, res) => {
    const user = await findUserById(db, callerId(req));
    if (!user) throw new HttpError(401, 'unauthenticated', 'Account no longer exists');
    res.json({ user });
  });

  return router;
}
