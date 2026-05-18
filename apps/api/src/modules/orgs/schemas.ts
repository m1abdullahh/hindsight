import { z } from 'zod';

export const updateOrgInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});
export type UpdateOrgInput = z.infer<typeof updateOrgInput>;

export const updateMemberInput = z
  .object({
    role: z.enum(['owner', 'admin', 'member']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'must include at least one of role, status',
  });
export type UpdateMemberInput = z.infer<typeof updateMemberInput>;

// Min 12 chars matches acceptInviteInput so direct-add and invite-accept share
// the same floor; HIBP runs in the service to reject commodity weak passwords.
export const addMemberDirectInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'member']),
  password: z.string().min(12).max(128),
});
export type AddMemberDirectInput = z.infer<typeof addMemberDirectInput>;
