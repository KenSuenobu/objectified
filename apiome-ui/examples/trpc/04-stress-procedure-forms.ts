import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';

/**
 * Every procedure form and builder shape, including the ones with no canonical analogue:
 * middleware-derived context, non-Zod validators, and subscriptions.
 */

interface Ctx {
  userId?: string;
  tenantId: string;
}

const t = initTRPC.context<Ctx>().meta<{ scope?: string }>().create();

const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new Error('UNAUTHORIZED');
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

const publicProcedure = t.procedure;
const protectedProcedure = t.procedure.use(isAuthed);

export const stressRouter = t.router({
  // query with input and output
  read: publicProcedure
    .input(z.object({ id: z.string() }))
    .output(z.object({ id: z.string(), value: z.number() }))
    .query(({ input }) => ({ id: input.id, value: 1 })),

  // query with no input at all
  status: publicProcedure.output(z.object({ ok: z.boolean() })).query(() => ({ ok: true })),

  // mutation with meta and a middleware-protected builder
  write: protectedProcedure
    .meta({ scope: 'lab.write' })
    .input(z.object({ id: z.string(), value: z.number().int() }))
    .mutation(({ input }) => input),

  // chained input refinement: two .input() calls merge
  chained: publicProcedure
    .input(z.object({ a: z.string() }))
    .input(z.object({ b: z.number() }))
    .query(({ input }) => input),

  // subscription: no request/response pair, an event stream
  onUpdate: publicProcedure
    .input(z.object({ channel: z.string() }))
    .subscription(({ input }) =>
      observable<{ channel: string; at: number }>((emit) => {
        const handle = setInterval(() => emit.next({ channel: input.channel, at: 0 }), 1000);
        return () => clearInterval(handle);
      }),
    ),

  // non-Zod validator: a hand-written function, which has no schema to extract
  handWritten: publicProcedure
    .input((raw: unknown) => {
      if (typeof raw !== 'string') throw new Error('expected string');
      return raw;
    })
    .query((opts) => ({ length: opts.input.length })),

  // a nested router inline
  nested: t.router({
    inner: publicProcedure.input(z.object({ deep: z.boolean() })).query(({ input }) => input),
  }),
});

export type StressRouter = typeof stressRouter;
