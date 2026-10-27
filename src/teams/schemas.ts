import { z } from 'zod';
import { singleLineText } from '../http/text.js';

export const createTeamSchema = z.object({
  name: singleLineText(1, 100),
});

export const addMemberSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  role: z.enum(['owner', 'member']).default('member'),
});

export const teamParamsSchema = z.object({
  id: z.uuid(),
});

export const memberParamsSchema = teamParamsSchema.extend({
  userId: z.uuid(),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
