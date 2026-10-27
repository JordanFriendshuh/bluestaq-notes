import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { multiLineText, singleLineText } from '../http/text.js';

const title = singleLineText(1, 200);
const body = multiLineText(50_000);

const checklistItem = z.object({
  id: z.uuid().optional(),
  text: singleLineText(1, 500),
  done: z.boolean().default(false),
});

/** The whole checklist; items without an id get one, and ids must be unique within the note. */
const items = z
  .array(checklistItem)
  .max(500)
  .transform((list) => list.map((item) => ({ ...item, id: item.id ?? randomUUID() })))
  .refine((list) => new Set(list.map((item) => item.id)).size === list.length, {
    message: 'Checklist item ids must be unique',
  });

export const createNoteSchema = z.object({
  title,
  body: body.default(''),
  items: items.default([]),
});

export const updateNoteSchema = z
  .object({ title: title.optional(), body: body.optional(), items: items.optional() })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Send at least one of title, body or items',
  });

export const listNotesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const noteParamsSchema = z.object({
  id: z.uuid(),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type ListNotesInput = z.infer<typeof listNotesSchema>;
