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

// Admin-entered "manual time" for a member: a project, a calendar day, and a
// duration. The day is a plain YYYY-MM-DD (no timezone games — the server
// anchors it to noon UTC so it lands on the intended day in every timezone).
// Duration is 1 second .. 24 hours, mirroring the per-entry Seconds bound.
export const createManualTimeEntryInput = z.object({
  projectId: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .refine((s) => !Number.isNaN(new Date(`${s}T12:00:00.000Z`).getTime()), 'invalid calendar date')
    .superRefine((s, ctx) => {
      const day = new Date(`${s}T12:00:00.000Z`).getTime();
      if (day > Date.now() + 24 * 60 * 60 * 1000) {
        ctx.addIssue({ code: 'custom', message: 'date is in the future' });
      }
      if (day < Date.now() - 365 * 24 * 60 * 60 * 1000) {
        ctx.addIssue({ code: 'custom', message: 'date is more than a year in the past' });
      }
    }),
  durationSeconds: z.number().int().min(1).max(86_400),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateManualTimeEntryInput = z.infer<typeof createManualTimeEntryInput>;

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
