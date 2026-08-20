import { initTRPC } from '@trpc/server';

// A router with no procedures: tRPC is initialised and a router is exported, but it
// declares no callable surface at all.
const t = initTRPC.create();

export const appRouter = t.router({});

export type AppRouter = typeof appRouter;
