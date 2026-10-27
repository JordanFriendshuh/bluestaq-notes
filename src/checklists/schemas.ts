import { z } from 'zod';
import { singleLineText } from '../http/text.js';

export const MAX_ITEMS = 500;

export const itemText = singleLineText(1, 500);

/** Where to put an item: after another item's id, null for the top, or omitted for the bottom. */
export const itemAfter = z.uuid().nullable().optional();

export const newItemsSchema = z
  .array(z.object({ text: itemText, done: z.boolean().default(false) }))
  .max(MAX_ITEMS);

export const addItemSchema = z.object({
  text: itemText,
  done: z.boolean().default(false),
  after: itemAfter,
});

export const updateItemSchema = z
  .object({ text: itemText.optional(), done: z.boolean().optional(), after: itemAfter })
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
