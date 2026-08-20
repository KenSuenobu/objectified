import { z } from 'zod';

/**
 * Above the divider: constructs with a JSON Schema analogue, which must become canonical
 * constraints. Below it: constructs that have none, which FMT-8.2 requires declared as
 * limits rather than dropped.
 */

// ---------------------------------------------------------------- modellable

export const Strings = z.object({
  plain: z.string(),
  bounded: z.string().min(2).max(64),
  exact: z.string().length(8),
  pattern: z.string().regex(/^[a-z0-9-]+$/),
  email: z.string().email(),
  url: z.string().url(),
  uuid: z.string().uuid(),
  isoDate: z.string().date(),
  isoDateTime: z.string().datetime({ offset: true }),
  startsWith: z.string().startsWith('acme-'),
  endsWith: z.string().endsWith('.json'),
  includes: z.string().includes('::'),
});

export const Numbers = z.object({
  int: z.number().int(),
  positive: z.number().positive(),
  range: z.number().gte(0).lte(100),
  exclusive: z.number().gt(0).lt(1),
  multiple: z.number().multipleOf(0.25),
  big: z.bigint(),
});

export const Collections = z.object({
  list: z.array(z.string()).min(1).max(10),
  tuple: z.tuple([z.string(), z.number(), z.boolean()]),
  variadic: z.tuple([z.string()]).rest(z.number()),
  set: z.set(z.string()),
  map: z.map(z.string(), z.number()),
  record: z.record(z.string(), z.number()),
  literalUnion: z.union([z.literal('a'), z.literal('b'), z.literal(42)]),
});

export const Shape = z.object({
  nested: z.object({ inner: z.object({ value: z.number() }) }),
  optional: z.string().optional(),
  nullable: z.string().nullable(),
  nullish: z.string().nullish(),
  withDefault: z.string().default('unset'),
  catchAll: z.object({ known: z.string() }).catchall(z.string()),
  strict: z.object({ only: z.string() }).strict(),
  passthrough: z.object({ known: z.string() }).passthrough(),
  merged: z.object({ a: z.string() }).merge(z.object({ b: z.number() })),
  extended: z.object({ a: z.string() }).extend({ c: z.boolean() }),
  partial: z.object({ a: z.string(), b: z.number() }).partial(),
  required: z.object({ a: z.string().optional() }).required(),
  intersection: z.intersection(z.object({ id: z.string() }), z.object({ ts: z.number() })),
  lazyTree: z.lazy((): z.ZodTypeAny => Shape),
});

export const Discriminated = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('circle'), radius: z.number().positive() }),
  z.object({ kind: z.literal('square'), side: z.number().positive() }),
  z.object({ kind: z.literal('rect'), width: z.number(), height: z.number() }),
]);

export const NativeEnum = z.nativeEnum({ Reader: 'reader', Writer: 'writer' } as const);

// ---------------------------------------------------------------- declared limits

/** refine: an arbitrary predicate with no schema analogue. */
export const Refined = z
  .object({ start: z.number(), end: z.number() })
  .refine((v) => v.end > v.start, { message: 'end must be after start', path: ['end'] });

/** superRefine: multiple predicates, still arbitrary code. */
export const SuperRefined = z.object({ a: z.number(), b: z.number() }).superRefine((v, ctx) => {
  if (v.a + v.b > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sum too large' });
  }
});

/** transform: changes the output type at runtime. */
export const Transformed = z.string().transform((s) => s.trim().toLowerCase());

/** preprocess: runs before parsing. */
export const Preprocessed = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number());

/** brand: a nominal type that exists only in the type system. */
export const Branded = z.string().uuid().brand<'OrderId'>();

/** effects on a pipeline. */
export const Piped = z.string().pipe(z.coerce.number().int());

/** custom: an escape hatch with no structure at all. */
export const Custom = z.custom<`${number}-${number}`>((v) => typeof v === 'string');

/** function schemas describe behaviour, not data. */
export const Fn = z.function().args(z.string(), z.number().optional()).returns(z.promise(z.void()));

/** promise-wrapped values. */
export const Async = z.promise(z.object({ ready: z.boolean() }));
