import { z } from 'zod';

export const Money = z.object({
  value: z.number().int(),
  currency: z.enum(['EUR', 'GBP', 'USD']),
});

export const Address = z.object({
  line1: z.string(),
  city: z.string(),
  postalCode: z.string(),
  countryCode: z.string().length(2),
});
