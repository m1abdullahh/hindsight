import { z } from 'zod';

const Name = z.string().trim().min(1).max(100);
const Description = z.string().trim().max(2000).nullable().optional();
const Interval = z.number().int().min(1).max(60);
const Cents = z.number().int().min(0).max(1_000_000_00);

export const createProjectInput = z.object({
  name: Name,
  description: Description,
  screenshotIntervalMinutes: Interval.default(10),
  blurScreenshots: z.boolean().default(false),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const updateProjectInput = z
  .object({
    name: Name.optional(),
    description: Description,
    screenshotIntervalMinutes: Interval.optional(),
    blurScreenshots: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'must include at least one field',
  });
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

export const listProjectsQuery = z.object({
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuery>;

export const createAssignmentInput = z.object({
  userId: z.string().min(1),
  hourlyRateCents: Cents.optional(),
});
export type CreateAssignmentInput = z.infer<typeof createAssignmentInput>;

export const updateAssignmentInput = z
  .object({
    hourlyRateCents: Cents.nullable().optional(),
  })
  .refine((v) => v.hourlyRateCents !== undefined, {
    message: 'must include at least one field',
  });
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentInput>;
