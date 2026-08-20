import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { Money } from './schemas';

const t = initTRPC.create();

export const orderRouter = t.router({
  list: t.procedure
    .input(z.object({ status: z.enum(['new', 'paid']).optional() }))
    .output(z.array(z.object({ orderId: z.string(), total: Money })))
    .query(() => []),

  place: t.procedure
    .input(z.object({ sku: z.string(), quantity: z.number().int().positive() }))
    .output(z.object({ orderId: z.string(), total: Money }))
    .mutation(() => ({ orderId: 'ORD-1', total: { value: 0, currency: 'EUR' as const } })),
});
