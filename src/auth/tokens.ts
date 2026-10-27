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

export interface TokenClaims {
  userId: string;
  expiresAt: Date;
}

/** The claims of a valid token, or null if it's malformed, tampered with, expired or not ours. */
export function verifyTokenClaims(token: string, settings: TokenSettings): TokenClaims | null {
  try {
    const payload = jwt.verify(token, settings.jwtSecret, {
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
    if (typeof payload !== 'object' || typeof payload.exp !== 'number') return null;
    if (!userIdSchema.safeParse(payload.sub).success) return null;
    return { userId: payload.sub as string, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
}

/** Returns the user id from a valid token, or null if it's malformed, tampered with, expired or not ours. */
export function verifyToken(token: string, settings: TokenSettings): string | null {
  return verifyTokenClaims(token, settings)?.userId ?? null;
}
