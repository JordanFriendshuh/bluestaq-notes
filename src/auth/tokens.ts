import jwt from 'jsonwebtoken';
import { z } from 'zod';

export interface TokenSettings {
  jwtSecret: string;
  tokenTtlSeconds: number;
}

const TOKEN_ISSUER = 'team-notes-api';
const TOKEN_AUDIENCE = 'team-notes-api';
const userIdSchema = z.uuid();

/** Signs a short-lived bearer token whose subject is the user id. */
export function signToken(userId: string, settings: TokenSettings): string {
  return jwt.sign({}, settings.jwtSecret, {
    subject: userId,
    expiresIn: settings.tokenTtlSeconds,
    algorithm: 'HS256',
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  });
}

/** Returns the user id from a valid token, or null if it's malformed, tampered with, expired or not ours. */
export function verifyToken(token: string, settings: TokenSettings): string | null {
  try {
    const payload = jwt.verify(token, settings.jwtSecret, {
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
    if (typeof payload !== 'object') return null;
    return userIdSchema.safeParse(payload.sub).success ? (payload.sub as string) : null;
  } catch {
    return null;
  }
}
