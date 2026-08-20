import { initTRPC } from '@trpc/server';

/*
 * Every procedure validates with a hand-written function rather than a Zod schema, so
 * there is nothing to serialize: FMT-8.3 requires a router like this to be reported as
 * unmodellable input schemas, not to produce operations with empty request bodies.
 */
const t = initTRPC.create();

const asString = (raw: unknown): string => {
  if (typeof raw !== 'string') throw new Error('expected string');
  return raw;
};

const asNumber = (raw: unknown): number => {
  if (typeof raw !== 'number') throw new Error('expected number');
  return raw;
};

export const appRouter = t.router({
  byId: t.procedure.input(asString).query((opts) => ({ id: opts.input })),
  page: t.procedure.input(asNumber).query((opts) => ({ page: opts.input })),
});

export type AppRouter = typeof appRouter;
