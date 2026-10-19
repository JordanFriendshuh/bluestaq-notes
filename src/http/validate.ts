import { z } from 'zod';
import { HttpError } from './errors.js';

/** Parses request input with a zod schema, throwing a 400 that names each invalid field. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, 'validation_failed', z.prettifyError(result.error));
  }
  return result.data;
}
