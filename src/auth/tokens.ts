import jwt from 'jsonwebtoken';

export interface TokenSettings {
  jwtSecret: string;
  tokenTtlSeconds: number;
}

/** Signs a short-lived bearer token whose subject is the user id. */
export function signToken(userId: string, settings: TokenSettings): string {
  return jwt.sign({}, settings.jwtSecret, {
    subject: userId,
    expiresIn: settings.tokenTtlSeconds,
    algorithm: 'HS256',
  });
}

/** Returns the user id from a valid token, or null if it's malformed, tampered with or expired. */
export function verifyToken(token: string, settings: TokenSettings): string | null {
  try {
    const payload = jwt.verify(token, settings.jwtSecret, { algorithms: ['HS256'] });
    return typeof payload === 'object' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
