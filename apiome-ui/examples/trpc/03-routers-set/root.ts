import { initTRPC } from '@trpc/server';
import { orderRouter } from './order-router';
import { customerRouter } from './customer-router';

const t = initTRPC.create();

/** Root of the set: the routers it merges live in sibling modules. */
export const appRouter = t.router({
  order: orderRouter,
  customer: customerRouter,
});

export type AppRouter = typeof appRouter;
