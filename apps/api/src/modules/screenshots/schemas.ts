import { z } from 'zod';

const isoDate = z
  .string()
  .datetime()
  .transform((s) => new Date(s));

const ContentType = z.enum(['image/jpeg', 'image/png', 'image/webp']);
const NonNegInt = (max: number) => z.number().int().min(0).max(max);

export const presignInput = z.object({
  timeEntryId: z.string().min(1),
  capturedAt: isoDate,
  monitorIndex: z.number().int().min(0).max(15),
  contentType: ContentType,
});
export type PresignInput = z.infer<typeof presignInput>;

export const confirmInput = z.object({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  activeWindowTitle: z.string().max(500).nullable().optional(),
  activeApp: z.string().max(200).nullable().optional(),
  keyboardEventsCount: NonNegInt(1_000_000),
  mouseEventsCount: NonNegInt(1_000_000),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
});
export type ConfirmInput = z.infer<typeof confirmInput>;

export const listScreenshotsQuery = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type ListScreenshotsQuery = z.infer<typeof listScreenshotsQuery>;
