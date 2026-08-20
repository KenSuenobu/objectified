import { z } from 'zod';
import { Address } from './shared';
import { OrderLine } from './order-line';

/** Root of the set: composes schemas imported from two sibling modules. */
export const Shipment = z.object({
  shipmentId: z.string().regex(/^SHP-[0-9]{6}$/),
  destination: Address,
  lines: z.array(OrderLine).min(1),
  weightKg: z.number().positive(),
});

export type Shipment = z.infer<typeof Shipment>;
