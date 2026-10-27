import { z } from 'zod';
import { singleLineText } from '../http/text.js';

export const MAX_ITEMS = 500;

const text = singleLineText(1, 500);

/** Where to put an item: after another item's id, null for the top, or omitted for the bottom. */
const after = z.uuid().nullable().optional();

export const newItemsSchema = z
  .array(z.object({ text, done: z.boolean().default(false) }))
  .max(MAX_ITEMS);

export const addItemSchema = z.object({
  text,
  done: z.boolean().default(false),
  after,
});

export const updateItemSchema = z
  .object({ text: text.optional(), done: z.boolean().optional(), after })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Send at least one of text, done or after',
  });

export const itemParamsSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
});

export type NewItemsInput = z.infer<typeof newItemsSchema>;
export type AddItemInput = z.infer<typeof addItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
