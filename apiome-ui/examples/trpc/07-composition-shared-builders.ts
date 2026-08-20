import { initTRPC } from '@trpc/server';
import { z } from 'zod';

/**
 * Within-document composition: shared input/output schemas reused across procedures,
 * procedure builders composed from middleware, and routers merged into one surface.
 */

interface Ctx {
  tenantId: string;
  scopes: string[];
}

const t = initTRPC.context<Ctx>().create();

/* ------------------------------------------------------------------ schemas */

const PageInput = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const Identified = z.object({ id: z.string().regex(/^[A-Z]{3}-[0-9]{6}$/) });

const Record = Identified.extend({
  label: z.string().min(1),
  createdAt: z.string().datetime(),
});

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/* ------------------------------------------------------------------ builders */

const withScope = (scope: string) =>
  t.middleware(({ ctx, next }) => {
    if (!ctx.scopes.includes(scope)) throw new Error('FORBIDDEN');
    return next({ ctx });
  });

const readProcedure = t.procedure.use(withScope('records.read'));
const writeProcedure = t.procedure.use(withScope('records.write'));

/* ------------------------------------------------------------------ routers */

const queryRouter = t.router({
  list: readProcedure
    .input(PageInput.extend({ label: z.string().optional() }))
    .output(page(Record))
    .query(() => ({ items: [], nextCursor: null })),

  byId: readProcedure.input(Identified).output(Record).query(({ input }) => ({
    id: input.id,
    label: '',
    createdAt: new Date(0).toISOString(),
  })),
});

const mutationRouter = t.router({
  create: writeProcedure
    .input(Record.omit({ id: true, createdAt: true }))
    .output(Record)
    .mutation(() => ({ id: 'ABC-000001', label: '', createdAt: new Date(0).toISOString() })),

  patch: writeProcedure
    .input(Identified.merge(Record.partial().omit({ id: true })))
    .output(Record)
    .mutation(() => ({ id: 'ABC-000001', label: '', createdAt: new Date(0).toISOString() })),
});

/** Router composition: two feature routers merged under one root. */
export const appRouter = t.router({
  records: t.router({
    read: queryRouter,
    write: mutationRouter,
  }),
});

export type AppRouter = typeof appRouter;
