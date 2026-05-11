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
