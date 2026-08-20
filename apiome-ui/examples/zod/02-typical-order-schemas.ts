import { z } from 'zod';

/** The constraints a plain TypeScript type cannot carry: this is why Zod is worth reading. */

export const OrderStatus = z.enum(['new', 'paid', 'shipped', 'cancelled']);

export const OrderLine = z.object({
  sku: z.string().regex(/^[A-Z]{3}-[0-9]{4}$/),
  quantity: z.number().int().positive().max(9999),
  unitPrice: z.number().nonnegative(),
  discount: z.number().min(0).max(1).optional(),
});

export const Order = z.object({
  orderId: z.string().uuid(),
  customerId: z.string().min(3).max(20),
  status: OrderStatus.default('new'),
  placedAt: z.string().datetime(),
  lines: z.array(OrderLine).min(1).max(200),
  total: z.number().nonnegative(),
  currency: z.string().length(3),
  note: z.string().max(500).nullable().optional(),
  contactEmail: z.string().email(),
});

export const NewOrder = Order.pick({ customerId: true, lines: true, note: true });

export type Order = z.infer<typeof Order>;
export type NewOrder = z.infer<typeof NewOrder>;
