import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { Address } from './schemas';

const t = initTRPC.create();

export const customerRouter = t.router({
  byId: t.procedure
    .input(z.object({ customerId: z.string() }))
    .output(z.object({ customerId: z.string(), address: Address.optional() }))
    .query(({ input }) => ({ customerId: input.customerId })),
});
