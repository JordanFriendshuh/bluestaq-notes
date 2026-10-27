import { z } from 'zod';
import { newItemsSchema } from '../checklists/schemas.js';
import { multiLineText, singleLineText } from '../http/text.js';
import { searchQuery } from '../search/schemas.js';

export const noteTitle = singleLineText(1, 200);
export const noteBody = multiLineText(50_000);

export const createNoteSchema = z.object({
  title: noteTitle,
  body: noteBody.default(''),
  items: newItemsSchema.default([]),
});

export const updateNoteSchema = z
  .object({ title: noteTitle.optional(), body: noteBody.optional() })
  .refine((input) => input.title !== undefined || input.body !== undefined, {
    message: 'Send at least one of title or body',
  });

export const listNotesSchema = z.object({
  q: searchQuery.optional(),
  scope: z.enum(['all', 'owned', 'shared']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const noteParamsSchema = z.object({
  id: z.uuid(),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type ListNotesInput = z.infer<typeof listNotesSchema>;
