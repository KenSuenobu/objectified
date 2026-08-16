'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';

/**
 * Badge — the Hive status pill (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §11 (`.badge`), `docs/mockups/DESIGN.md` §7,
 * gallery §Badges.
 *
 * Two ways to reach the same tones:
 *
 * 1. **`status`** — hand the badge the app's own vocabulary string (`"published"`,
 *    `"degraded"`, `"failed"`) and it picks the tone. This is the API DESIGN.md §7 calls
 *    `.badge[data-status]`; the attribute is written to the DOM as well, so a page can
 *    still style or query off it. A published version is the same green on every screen
 *    because the *string* decides, not whoever wrote the page. HIVE-2.4 grows this map
 *    into the app-wide vocabulary; the tones here are hive.css §11 as it stands.
 * 2. **`variant`** — name the tone outright, for a badge that is not a lifecycle state
 *    (a count, an "Outline" chip, a mono identifier).
 *
 * `status` wins when both are given, because the vocabulary is the point.
 */

/** Tone classes shared by the `variant` map and the `status` map below. */
const TONE = {
  neutral: 'bg-neutral-soft text-neutral-fg',
  ok: 'bg-ok-soft text-ok-fg',
  warn: 'bg-warn-soft text-warn-fg',
  danger: 'bg-danger-soft text-danger-fg',
  accent: 'bg-accent-soft text-accent-fg',
  honey: 'bg-honey-soft text-honey-fg',
  violet: 'bg-violet-soft text-violet-fg',
  orange: 'bg-orange-soft text-orange-fg',
  rose: 'bg-rose-soft text-rose-fg',
  outline: 'bg-transparent text-fg-subtle shadow-[inset_0_0_0_1px_var(--border-strong)]',
  ink: 'bg-fg text-surface',
} as const;

/** The tone names a caller may ask for directly. */
export type BadgeTone = keyof typeof TONE;

/**
 * Lifecycle, health, severity and maturity strings the app already uses, mapped to a tone.
 *
 * Mirrors the `.badge[data-status="…"]` rules of hive.css §11 one for one. Anything not
 * listed falls back to `neutral`, which is the honest answer for a state the design
 * language has not been told about yet.
 */
const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  // Nothing has happened yet.
  draft: 'neutral',
  pending: 'neutral',
  unknown: 'neutral',
  // In flight, or needs a look.
  review: 'warn',
  warning: 'warn',
  warn: 'warn',
  degraded: 'warn',
  running: 'warn',
  // Good.
  published: 'ok',
  ok: 'ok',
  pass: 'ok',
  passed: 'ok',
  active: 'ok',
  healthy: 'ok',
  verified: 'ok',
  success: 'ok',
  completed: 'ok',
  public: 'ok',
  // On the way out.
  deprecated: 'orange',
  sunsetting: 'orange',
  // Bad.
  sunset: 'danger',
  error: 'danger',
  failed: 'danger',
  down: 'danger',
  revoked: 'danger',
  blocked: 'danger',
  breaking: 'danger',
  // Informational.
  info: 'accent',
  hint: 'accent',
  preview: 'accent',
  beta: 'accent',
  // Set aside.
  archived: 'outline',
  disabled: 'outline',
  // Marked by a person.
  new: 'honey',
  pinned: 'honey',
  starred: 'honey',
  // Scope.
  private: 'violet',
};

/**
 * The tone a status string resolves to.
 *
 * @param status A vocabulary string, in any case (`"Published"` and `"published"` agree).
 * @returns The tone name, or `neutral` when the string is not in the vocabulary.
 */
export function badgeToneForStatus(status: string): BadgeTone {
  return STATUS_TONE[status.trim().toLowerCase()] ?? 'neutral';
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
        ...TONE,
        // ---- pre-Hive aliases ---------------------------------------------
        /** Was indigo; the Hive "this is informational" tone is accent. */
        default: TONE.accent,
        /** Was grey. */
        secondary: TONE.neutral,
        /** Was emerald. */
        success: TONE.ok,
        /** Was amber. */
        warning: TONE.warn,
        /** Was red. */
        error: TONE.danger,
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
