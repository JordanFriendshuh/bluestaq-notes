import { z } from 'zod';

/** A trimmed one-line string; \p{Cc} rejects NUL (which Postgres can't store), newlines and other invisible controls. */
export const singleLineText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^\P{Cc}*$/u, 'Must not contain control characters');
