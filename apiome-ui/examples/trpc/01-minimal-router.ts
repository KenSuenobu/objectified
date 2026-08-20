import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();

export const appRouter = t.router({
  ping: t.procedure.input(z.object({ message: z.string() })).query(({ input }) => ({
    echo: input.message,
  })),
});

export type AppRouter = typeof appRouter;
