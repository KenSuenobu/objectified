'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';
import {
  STATUS_TONE_SOFT_CLASS,
  statusTone,
  type StatusTone,
} from './statusVocabulary';

/**
 * Badge — the Hive status pill (HIVE-2.1, #5280; vocabulary HIVE-2.4, #5283).
 *
 * Authority: `docs/mockups/assets/hive.css` §11 (`.badge`), `docs/mockups/DESIGN.md` §3.1
 * and §7, gallery §Badges.
 *
 * Two ways to reach the same tones:
 *
 * 1. **`status`** — hand the badge the app's own vocabulary string (`"published"`,
 *    `"degraded"`, `"failed"`) and it picks the tone. This is the API DESIGN.md §7 calls
 *    `.badge[data-status]`; the attribute is written to the DOM as well, so a page can
 *    still style or query off it. A published version is the same green on every screen
 *    because the *string* decides, not whoever wrote the page. The map itself lives in
 *    `statusVocabulary.ts`, shared with the MCP and catalog pills, so adding a state is a
 *    line of data rather than a change to this component.
 * 2. **`variant`** — name the tone outright, for a badge that is not a lifecycle state
 *    (a count, an "Outline" chip, a mono identifier).
 *
 * `status` wins when both are given, because the vocabulary is the point.
 */

/** The tone names a caller may ask for directly — the shared vocabulary's tones. */
export type BadgeTone = StatusTone;

/**
 * The tone a status string resolves to.
 *
 * Kept as a named export because ~all `status` call sites and the HIVE-2.1 suite reach for
 * it under this name; it is {@link statusTone} from the shared vocabulary.
 *
 * @param status A vocabulary string, in any case (`"Published"` and `"published"` agree).
 * @returns The tone name, or `neutral` when the string is not in the vocabulary.
 */
export function badgeToneForStatus(status: string): BadgeTone {
  return statusTone(status);
}

const badgeVariants = cva(
  [
    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full',
    'px-[0.4375rem] text-2xs font-semibold leading-none tracking-[0.01em]',
    '[&_svg]:size-[0.6875rem] [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      /** Tone. The DESIGN.md §7 names, plus the pre-Hive ones as aliases. */
      variant: {
        ...STATUS_TONE_SOFT_CLASS,
        // ---- pre-Hive aliases ---------------------------------------------
        /** Was indigo; the Hive "this is informational" tone is accent. */
        default: STATUS_TONE_SOFT_CLASS.accent,
        /** Was grey. */
        secondary: STATUS_TONE_SOFT_CLASS.neutral,
        /** Was emerald. */
        success: STATUS_TONE_SOFT_CLASS.ok,
        /** Was amber. */
        warning: STATUS_TONE_SOFT_CLASS.warn,
        /** Was red. */
        error: STATUS_TONE_SOFT_CLASS.danger,
      },
      /** Height: 20 px normally, 24 px for a badge that carries an icon or sits alone. */
      size: {
        default: 'h-5',
        lg: 'h-6 px-[0.5625rem] text-xs',
      },
      /** Square corners — for a badge reading as a tag rather than a state. */
      square: { true: 'rounded-xs', false: '' },
      /** Monospace — identifiers, hashes, version strings (respects the `.mono` preference). */
      mono: { true: 'mono font-medium', false: '' },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      square: false,
      mono: false,
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * The app's own status string. Sets `data-status` and picks the tone from the shared
   * vocabulary, overriding `variant`.
   */
  status?: string;
  /** Show a leading dot in the badge's own ink — lifecycle states read faster in a list. */
  dot?: boolean;
  /** A raw status attribute, for markup lifted straight from the mockups. */
  'data-status'?: string;
}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  (
    {
      className,
      variant,
      status,
      size,
      square,
      mono,
      dot = false,
      children,
      'data-status': dataStatus,
      ...props
    },
    ref
  ) => {
    // A raw `data-status` is honoured as well as the typed prop, so markup copied from the
    // mockups (`<Badge data-status="published">`) behaves the same way.
    const rawStatus = status ?? dataStatus;
    const tone = rawStatus ? badgeToneForStatus(rawStatus) : variant;

    return (
      <div
        ref={ref}
        data-status={rawStatus}
        className={cn(badgeVariants({ variant: tone, size, square, mono }), className)}
        {...props}
      >
        {dot && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-current"
            aria-hidden="true"
            data-testid="badge-dot"
          />
        )}
        {children}
      </div>
    );
  }
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
