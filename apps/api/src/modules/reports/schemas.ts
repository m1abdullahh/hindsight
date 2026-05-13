import { z } from 'zod';

const isoDate = z
  .string()
  .datetime()
  .transform((s) => new Date(s));

export const timeTotalsQuery = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type TimeTotalsQuery = z.infer<typeof timeTotalsQuery>;

// Same filter shape as time-totals; response shape differs (per-day buckets).
export const timeTotalsByDayQuery = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type TimeTotalsByDayQuery = z.infer<typeof timeTotalsByDayQuery>;
