import { z } from 'zod';

export const Beacon = z.object({
  id: z.string(),
  seenAt: z.number().int(),
});
