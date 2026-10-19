import { readFileSync } from 'node:fs';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    DATABASE_TLS: z.enum(['verify', 'off']).default('verify'),
    DATABASE_CA_FILE: z.string().min(1).optional(),
    TLS_CERT_FILE: z.string().min(1).optional(),
    TLS_KEY_FILE: z.string().min(1).optional(),
    TLS_TERMINATED_UPSTREAM: z.stringbool().default(false),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
    AUTH_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.TLS_CERT_FILE) !== Boolean(env.TLS_KEY_FILE)) {
      ctx.addIssue({
        code: 'custom',
        message: 'TLS_CERT_FILE and TLS_KEY_FILE must be set together',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.DATABASE_TLS === 'off') {
      ctx.addIssue({ code: 'custom', message: 'DATABASE_TLS=off is not allowed in production' });
    }
    if (!env.TLS_CERT_FILE && !env.TLS_TERMINATED_UPSTREAM) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Production needs TLS_CERT_FILE/TLS_KEY_FILE, or TLS_TERMINATED_UPSTREAM=true behind a proxy',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

/** Validates an environment, throwing with every problem listed; JWT_SECRET_FILE fills in JWT_SECRET. */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const withSecret =
    env.JWT_SECRET_FILE && !env.JWT_SECRET
      ? { ...env, JWT_SECRET: readFileSync(env.JWT_SECRET_FILE, 'utf8').trim() }
      : env;
  const result = envSchema.safeParse(withSecret);
  if (!result.success) throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Reads and validates the environment once at startup; exits with a readable error if it's wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
