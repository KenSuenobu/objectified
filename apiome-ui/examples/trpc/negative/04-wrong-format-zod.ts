import { z } from 'zod';

export const Order = z.object({
  orderId: z.string().uuid(),
  status: z.enum(['new', 'paid', 'shipped', 'cancelled']),
  total: z.number().nonnegative(),
});

export const NewOrder = Order.omit({ orderId: true });
