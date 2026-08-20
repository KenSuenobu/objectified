import { z } from 'zod';
import { Money } from './shared';

export const OrderLine = z.object({
  sku: z.string().regex(/^[A-Z]{3}-[0-9]{4}$/),
  quantity: z.number().int().positive(),
  unitPrice: Money,
});
