import { z } from 'zod';

const isoDate = (limits?: { futureMs?: number; pastMs?: number }) =>
  z
    .string()
    .datetime()
    .transform((s) => new Date(s))
    .superRefine((d, ctx) => {
      const now = Date.now();
      if (limits?.futureMs !== undefined && d.getTime() > now + limits.futureMs) {
        ctx.addIssue({ code: 'custom', message: 'date is in the future beyond skew tolerance' });
      }
      if (limits?.pastMs !== undefined && d.getTime() < now - limits.pastMs) {
        ctx.addIssue({ code: 'custom', message: 'date is too far in the past' });
      }
    });

const Seconds = z.number().int().min(0).max(86_400);

export const createTimeEntryInput = z.object({
  projectId: z.string().min(1),
  startedAt: isoDate({ futureMs: 60_000, pastMs: 7 * 24 * 60 * 60 * 1000 }),
});
export type CreateTimeEntryInput = z.infer<typeof createTimeEntryInput>;

export const updateTimeEntryInput = z
  .object({
    endedAt: isoDate({ futureMs: 60_000 }).optional(),
    totalActiveSeconds: Seconds.optional(),
    totalIdleSeconds: Seconds.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'must include at least one field',
  });
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntryInput>;

export const listTimeEntriesQuery = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: isoDate().optional(),
  to: isoDate().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type ListTimeEntriesQuery = z.infer<typeof listTimeEntriesQuery>;
