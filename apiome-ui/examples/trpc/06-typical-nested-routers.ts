import { initTRPC } from '@trpc/server';
import { z } from 'zod';

/** Nested routers three deep: the hierarchy that must become operation groups. */

const t = initTRPC.create();
const p = t.procedure;

export const appRouter = t.router({
  admin: t.router({
    users: t.router({
      list: p.input(z.object({ active: z.boolean().optional() })).query(() => []),
      disable: p.input(z.object({ userId: z.string() })).mutation(() => ({ disabled: true })),
    }),
    audit: t.router({
      search: p
        .input(z.object({ from: z.string().date(), to: z.string().date() }))
        .query(() => []),
    }),
  }),
  catalogue: t.router({
    products: t.router({
      list: p.input(z.object({ category: z.string().optional() })).query(() => []),
      bySku: p.input(z.object({ sku: z.string() })).query(({ input }) => input),
    }),
  }),
  version: p.query(() => ({ version: '3.4.1' })),
});

export type AppRouter = typeof appRouter;
