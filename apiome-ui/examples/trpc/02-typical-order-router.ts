import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.context<{ tenantId: string }>().create();

const OrderStatus = z.enum(['new', 'paid', 'shipped', 'cancelled']);

const Order = z.object({
  orderId: z.string().uuid(),
  customerId: z.string(),
  status: OrderStatus,
  total: z.number().nonnegative(),
  placedAt: z.string().datetime(),
});

export const orderRouter = t.router({
  list: t.procedure
    .input(
      z.object({
        status: OrderStatus.optional(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
    )
    .output(z.object({ items: z.array(Order), nextCursor: z.string().nullable() }))
    .query(async ({ input, ctx }) => {
      void ctx;
      void input;
      return { items: [], nextCursor: null };
    }),

  byId: t.procedure
    .input(z.object({ orderId: z.string().uuid() }))
    .output(Order)
    .query(async ({ input }) => {
      throw new TRPCError({ code: 'NOT_FOUND', message: `No order ${input.orderId}` });
    }),

  place: t.procedure
    .input(
      z.object({
        customerId: z.string(),
        lines: z
          .array(z.object({ sku: z.string(), quantity: z.number().int().positive() }))
          .min(1),
      }),
    )
    .output(Order)
    .mutation(async ({ input }) => {
      void input;
      throw new TRPCError({ code: 'NOT_IMPLEMENTED' });
    }),

  cancel: t.procedure
    .input(z.object({ orderId: z.string().uuid(), reason: z.string().max(200).optional() }))
    .output(z.object({ cancelled: z.boolean() }))
    .mutation(async () => ({ cancelled: true })),
});

export type OrderRouter = typeof orderRouter;
