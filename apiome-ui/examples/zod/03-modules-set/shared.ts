import { z } from 'zod';

export const Address = z.object({
  line1: z.string().min(1).max(60),
  line2: z.string().max(60).optional(),
  city: z.string().min(1).max(40),
  postalCode: z.string().min(3).max(10),
  countryCode: z.string().length(2),
});

export const Money = z.object({
  value: z.number().int(),
  currency: z.enum(['EUR', 'GBP', 'USD']),
});
