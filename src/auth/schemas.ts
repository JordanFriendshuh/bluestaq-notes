import { z } from 'zod';
import { singleLineText } from '../http/text.js';

const email = z.string().trim().max(254).pipe(z.email());

// bcrypt silently ignores everything past 72 bytes, so the limit is on bytes, not characters.
const withinBcryptLimit = (value: string) => Buffer.byteLength(value, 'utf8') <= 72;

const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine(withinBcryptLimit, 'Password must be at most 72 bytes')
  .refine((value) => !value.includes('\0'), 'Password must not contain NUL characters');

export const registerSchema = z.object({
  email,
  password: newPassword,
  displayName: singleLineText(1, 100),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).refine(withinBcryptLimit, 'Password must be at most 72 bytes'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
