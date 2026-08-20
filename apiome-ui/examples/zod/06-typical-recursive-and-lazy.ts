import { z } from 'zod';

/** Recursive schemas: the case a naive extractor loops on. */

export interface Category {
  name: string;
  slug: string;
  children: Category[];
}

export const Category: z.ZodType<Category> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    children: z.array(Category),
  }),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

export const CommentThread = z.lazy(() =>
  z.object({
    id: z.string().uuid(),
    body: z.string().max(4000),
    postedAt: z.string().datetime(),
    replies: z.array(CommentThread).max(50),
  }),
);
