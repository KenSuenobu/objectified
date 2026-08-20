import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();

export const appRouter = t.router({
  list: t.procedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }))
    .output(z.object({ items: z.array(z.object({ id: z.str
