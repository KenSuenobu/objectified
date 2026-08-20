import { z } from 'zod';

export const Broken = z.object({
  id: z.string(),
  count: z.number(,
});
