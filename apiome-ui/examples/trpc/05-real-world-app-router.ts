import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

/**
 * The shape a production tRPC app has: one root router composed of feature routers,
 * a protected procedure builder, shared pagination input, and consistent output schemas.
 */

interface Context {
  session?: { userId: string; tenantId: string; scopes: string[] };
}

const t = initTRPC.context<Context>().create();

const requireSession = t.middleware(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { session: ctx.session } });
});

const publicProcedure = t.procedure;
const protectedProcedure = t.procedure.use(requireSession);

const PageInput = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const Customer = z.object({
  customerId: z.string().regex(/^CUS-[0-9]{6}$/),
  displayName: z.string(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});

const Invoice = z.object({
  invoiceId: z.string().regex(/^INV-[0-9]{8}$/),
  customerId: z.string(),
  issuedOn: z.string().date(),
  total: z.number().nonnegative(),
  currency: z.enum(['EUR', 'GBP', 'USD']),
  status: z.enum(['draft', 'issued', 'paid', 'void']),
});

const customerRouter = t.router({
  list: protectedProcedure
    .input(PageInput.extend({ query: z.string().max(120).optional() }))
    .output(z.object({ items: z.array(Customer), nextCursor: z.string().nullable() }))
    .query(async () => ({ items: [], nextCursor: null })),

  byId: protectedProcedure
    .input(z.object({ customerId: z.string() }))
    .output(Customer)
    .query(async ({ input }) => {
      throw new TRPCError({ code: 'NOT_FOUND', message: input.customerId });
    }),

  create: protectedProcedure
    .input(Customer.omit({ customerId: true, createdAt: true }))
    .output(Customer)
    .mutation(async () => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED' });
    }),
});

const invoiceRouter = t.router({
  list: protectedProcedure
    .input(PageInput.extend({ customerId: z.string().optional(), status: Invoice.shape.status.optional() }))
    .output(z.object({ items: z.array(Invoice), nextCursor: z.string().nullable() }))
    .query(async () => ({ items: [], nextCursor: null })),

  issue: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .output(Invoice)
    .mutation(async () => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED' });
    }),

  void: protectedProcedure
    .input(z.object({ invoiceId: z.string(), reason: z.string().min(3).max(200) }))
    .output(z.object({ voided: z.boolean() }))
    .mutation(async () => ({ voided: true })),
});

const healthRouter = t.router({
  ping: publicProcedure.output(z.object({ ok: z.literal(true) })).query(() => ({ ok: true as const })),
});

export const appRouter = t.router({
  health: healthRouter,
  customer: customerRouter,
  invoice: invoiceRouter,
});

export type AppRouter = typeof appRouter;
