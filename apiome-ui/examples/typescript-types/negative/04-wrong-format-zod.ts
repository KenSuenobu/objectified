import { z } from 'zod';

export const OrderLine = z.object({
  sku: z.string(),
  quantity: z.number().int().positive(),
});

export const Order = z.object({
  orderId: z.string(),
  status: z.enum(['new', 'paid', 'shipped', 'cancelled']),
  lines: z.array(OrderLine).nonempty(),
});
