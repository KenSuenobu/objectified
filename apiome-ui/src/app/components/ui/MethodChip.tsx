'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';

/**
 * MethodChip — the HTTP verb chip (HIVE-2.4, #5283).
 *
 * Authority: `docs/mockups/assets/hive.css` §11 (`.method`), `docs/mockups/DESIGN.md` §3.1
 * ("HTTP methods … fixed hues"), gallery §Status vocabulary.
 *
 * A verb's colour is an **identity**, not a state: `GET` is the same blue on the paths canvas,
 * in an operation list and in a diff, in every one of the nine themes. That is the opposite of
 * how `Badge` works, and it is deliberate — a status tone tracks the theme so it keeps its
 * contrast on a new surface, while a verb hue that tracked the theme would stop being
 * recognisable. So the hues are fixed hex in `globals.css` under `.method--*`, one of the
 * three places the raw-hex allow-list permits a literal.
 *
 * Colour is never the only signal: the chip always prints the verb itself.
 */

/** The verbs the design language gives a hue of their own. */
export const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
  'connect',
] as const;

/** One of the recognised HTTP verbs, lower-cased. */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Normalise a raw method token to a recognised verb.
 *
 * @param method The raw method string, in any case and with any surrounding space.
 * @returns The lower-cased verb, or `null` when the token is empty or is not a verb the
 *   design language has a hue for (the chip still renders it, in the neutral hue).
 */
export function normalizeHttpMethod(method: string | null | undefined): HttpMethod | null {
  if (!method || !method.trim()) return null;
  const value = method.trim().toLowerCase();
  return (HTTP_METHODS as readonly string[]).includes(value) ? (value as HttpMethod) : null;
}

export interface MethodChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The raw HTTP method (`"get"`, `"GET"`, `"Post"`). */
  method: string | null | undefined;
  /**
   * `false` drops the fixed 46 px minimum width, for a chip inside a dense inline run where
   * a column of aligned verbs would be noise rather than help. Default `true` — in a list of
   * operations the aligned left edge is most of the value.
   */
  block?: boolean;
}

/**
 * Render the HTTP method chip, or `null` when there is no method.
 *
 * A recognised verb gets its fixed hue; an unrecognised but present token keeps its raw text
 * on the neutral chip, so a non-standard verb is shown rather than silently dropped.
 */
export const MethodChip = React.forwardRef<HTMLSpanElement, MethodChipProps>(
  ({ method, block = true, className, ...props }, ref) => {
    const verb = normalizeHttpMethod(method);
    if (!verb && !method?.trim()) return null;

    const raw = method!.trim();
    return (
      <span
        ref={ref}
        data-method={verb ?? raw.toLowerCase()}
        data-testid="method-chip"
        className={cn('method', `method--${verb ?? 'unknown'}`, !block && 'method--fit', className)}
        {...props}
      >
        {raw.toUpperCase()}
      </span>
    );
  },
);
MethodChip.displayName = 'MethodChip';
