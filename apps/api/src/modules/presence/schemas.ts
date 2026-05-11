import { z } from 'zod';

export const presenceQuery = z.object({}).passthrough();
export type PresenceQuery = z.infer<typeof presenceQuery>;
