import type { Request, RequestHandler } from 'express';
import { HttpError } from '../http/errors.js';
import { verifyToken, type TokenSettings } from './tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

// The auth scheme name is case-insensitive per RFC 9110.
const BEARER = /^bearer +(\S+)$/i;

const unauthenticated = () =>
  new HttpError(401, 'unauthenticated', 'A valid bearer token is required');

/** Rejects requests without a valid bearer token and records the caller's user id on the request. */
export function requireAuth(settings: TokenSettings): RequestHandler {
  return (req, _res, next) => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const userId = token ? verifyToken(token, settings) : null;
    if (!userId) throw unauthenticated();
    req.userId = userId;
    next();
  };
}

/** The authenticated caller's id; only valid in handlers mounted behind requireAuth. */
export function callerId(req: Request): string {
  if (!req.userId) throw unauthenticated();
  return req.userId;
}
