import { z } from 'zod';

/**
 * Within-document composition: schemas built from other schemas by merge, extend,
 * pick/omit, partial, and a discriminated union assembled from the results.
 */

export const Timestamped = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

export const Identified = z.object({
  id: z.string().regex(/^[A-Z]{3}-[0-9]{6}$/),
});

/** merge: the union of two object schemas. */
export const Record = Identified.merge(Timestamped).extend({
  label: z.string().min(1).max(80),
});

export const ActiveRecord = Record.extend({
  status: z.literal('active'),
  updatedAt: z.string().datetime(),
});

export const ArchivedRecord = Record.extend({
  status: z.literal('archived'),
  archivedAt: z.string().datetime(),
});

/** A discriminated union over two composed schemas. */
export const AnyRecord = z.discriminatedUnion('status', [ActiveRecord, ArchivedRecord]);

/** pick / omit / partial: three more ways one schema derives from another. */
export const RecordSummary = Record.pick({ id: true, label: true });
export const RecordWithoutTimestamps = Record.omit({ createdAt: true, updatedAt: true });
export const RecordPatch = Record.partial().required({ id: true });

/** A generic-style helper applied twice. */
const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
  });

export const RecordPage = page(AnyRecord);
export const SummaryPage = page(RecordSummary);

export const RecordSet = z.object({
  active: z.array(ActiveRecord),
  archived: z.array(ArchivedRecord),
  byId: z.record(z.string(), AnyRecord),
  page: RecordPage.optional(),
});
