import { z } from 'zod';

export const putShareSchema = z
  .object({
    userEmail: z.string().trim().max(254).pipe(z.email()).optional(),
    teamId: z.uuid().optional(),
    role: z.enum(['viewer', 'editor']),
  })
  .refine((input) => (input.userEmail === undefined) !== (input.teamId === undefined), {
    message: 'Send exactly one of userEmail or teamId',
  });

export const shareParamsSchema = z.object({
  id: z.uuid(),
  shareId: z.uuid(),
});

export type PutShareInput = z.infer<typeof putShareSchema>;
