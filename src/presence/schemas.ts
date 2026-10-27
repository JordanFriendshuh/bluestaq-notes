import { z } from 'zod';

const noteId = z.uuid();
const offset = z.number().int().min(0).max(1_000_000);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().max(4096) }),
  z.object({ type: z.literal('join'), noteId }),
  z.object({ type: z.literal('leave'), noteId }),
  z.object({ type: z.literal('activity'), noteId, mode: z.enum(['viewing', 'editing']) }),
  z.object({
    type: z.literal('cursor'),
    noteId,
    field: z.string().regex(/^(?:title|body|item:[0-9a-f-]{36})$/),
    anchor: offset,
    head: offset,
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type CursorMessage = Extract<ClientMessage, { type: 'cursor' }>;
