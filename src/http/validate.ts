import type { z } from 'zod';
import { HttpError } from './errors.js';

/** Parses request input with a zod schema, throwing a 400 with one detail per invalid field. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    throw new HttpError(400, 'validation_failed', 'Request validation failed', details);
  }
  return result.data;
}
