import { z } from 'zod';

const Email = z.string().trim().toLowerCase().email();

export const createInviteInput = z.object({
  email: Email,
  role: z.enum(['admin', 'member']),
});
export type CreateInviteInput = z.infer<typeof createInviteInput>;

export const acceptInviteInput = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(128).optional(),
  name: z.string().trim().min(1).max(100).optional(),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteInput>;
