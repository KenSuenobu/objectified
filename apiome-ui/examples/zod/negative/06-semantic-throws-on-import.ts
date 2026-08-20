import { z } from 'zod';

/*
 * Evaluating this module throws at import time. FMT-8.2 runs module evaluation in a
 * sandbox with no network and a hard time budget: this fixture proves the failure is
 * reported as a clean job failure rather than taking the worker down.
 */
const config = JSON.parse(process.env.SCHEMA_CONFIG as string);

if (!config.enabled) {
  throw new Error('SCHEMA_CONFIG is required to build these schemas');
}

export const Order = z.object({
  orderId: z.string(),
  limit: z.number().max(config.maxLines),
});
