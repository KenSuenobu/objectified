/**
 * The subset boundary, in one file. Everything above the divider is expected to model;
 * everything below it is a declared parsing limit that must never be flattened to `any`.
 */

// ---------------------------------------------------------------- expected to model

export type Primitive = string | number | boolean | null;

export type Literal = 'a' | 'b' | 42 | true;

export interface WithIndexSignature {
  known: string;
  [key: string]: string | number;
}

export interface Nested {
  inner: {
    deep: {
      value: number;
      list: string[];
    };
  };
}

export type Tuple = [id: string, count: number, active?: boolean];

export type VariadicTuple = [string, ...number[]];

export interface Optional {
  required: string;
  optional?: string;
  nullable: string | null;
  maybeBoth?: string | null;
  readonly frozen: string;
}

export type Union = { kind: 'circle'; radius: number } | { kind: 'square'; side: number };

export type Intersection = { id: string } & { createdAt: string };

export enum Role {
  Reader = 'reader',
  Writer = 'writer',
  Admin = 'admin',
}

export const enum Numeric {
  Zero = 0,
  One = 1,
}

export type ArrayForms = string[] | Array<number> | ReadonlyArray<boolean>;

export type RecordForm = Record<string, number>;

export type NestedGenericInstantiation = Map<string, Array<{ id: string }>>;

/** Generic resolved at its instantiation: Page<Order> is modellable. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total: number;
}

export type OrderPage = Page<{ orderId: string; total: number }>;

export interface Extends extends Optional {
  extra: number;
}

// ---------------------------------------------------------------- declared limits

/** Conditional type: out of scope, must be declared, not guessed. */
export type Unwrap<T> = T extends Promise<infer U> ? U : T;

/** Mapped type: out of scope. */
export type Partialised<T> = { [K in keyof T]?: T[K] };

/** Template literal type: out of scope. */
export type EventName = `on${Capitalize<'click' | 'focus'>}`;

/** Unresolved generic: never instantiated in this file. */
export interface Envelope<T> {
  payload: T;
  meta: Record<string, string>;
}

/** Declaration merging: two declarations of one interface. */
export interface Merged {
  first: string;
}
export interface Merged {
  second: number;
}

/** Function and constructor types carry no data shape. */
export type Handler = (input: string, count?: number) => Promise<void>;
export type Factory = new (id: string) => Optional;

/** Symbol and unique symbol keys. */
export declare const brand: unique symbol;
export interface Branded {
  [brand]: true;
  value: string;
}
