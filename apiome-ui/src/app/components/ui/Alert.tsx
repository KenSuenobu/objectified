'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, Sparkles, X } from 'lucide-react';

/**
 * Alert — the Hive banner (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §17 (`.banner`), `docs/mockups/DESIGN.md` §7,
 * gallery §Feedback.
 *
 * A tinted strip, not a bordered box: leading icon, title and body, and an optional row of
 * actions pinned to the trailing edge. The tint *is* the severity, so the six tones are the
 * whole vocabulary — `info` · `ok` · `warn` · `danger` · `honey` · `neutral`.
 */
const alertVariants = cva(
  'relative flex w-full items-start gap-2.5 rounded-md px-3.5 py-2.5 text-sm',
  {
    variants: {
      variant: {
        /** Accent tint — something the reader should know. */
        info: 'bg-accent-soft text-accent-fg',
        /** Green tint — something finished, and it worked. */
        ok: 'bg-ok-soft text-ok-fg',
        /** Amber tint — something needs attention but nothing is broken. */
        warn: 'bg-warn-soft text-warn-fg',
        /** Red tint — something failed, or is about to. */
        danger: 'bg-danger-soft text-danger-fg',
        /** Honey tint — a brand moment (a tip, a new capability). */
        honey: 'bg-honey-soft text-honey-fg',
        /** Untinted — a note with no severity at all. */
        neutral: 'bg-subtle text-fg-muted',

        // ---- pre-Hive aliases -------------------------------------------------
        /** Was a white bordered box; reads as `neutral`. */
        default: 'bg-subtle text-fg-muted',
        /** Was emerald. */
        success: 'bg-ok-soft text-ok-fg',
        /** Was amber. */
        warning: 'bg-warn-soft text-warn-fg',
        /** Was red. */
        error: 'bg-danger-soft text-danger-fg',
      },
      /** Edge-to-edge, square — a banner spanning the top of a page or a panel. */
      bar: { true: 'rounded-none px-[var(--page-pad)] py-2', false: '' },
    },
    defaultVariants: {
      variant: 'default',
      bar: false,
    },
  }
);

/** The glyph each tone leads with. Aliases resolve to the same icon as their tone. */
const iconMap = {
  info: Info,
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: AlertCircle,
  honey: Sparkles,
  neutral: Info,
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
} as const;

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  /** Show a dismiss button, and what to do when it is pressed. */
  onClose?: () => void;
  /**
   * Buttons for the trailing edge — "Retry", "View log", "Dismiss".
   *
   * DESIGN.md §8: an error is "what happened + what to do", and this is the "what to do".
   */
  actions?: React.ReactNode;
  /** Replace the leading glyph, or pass `null` for a banner that carries none. */
  icon?: React.ReactNode;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'default', bar, children, actions, icon, onClose, ...props }, ref) => {
    const IconComponent = iconMap[variant || 'default'];
    const leading =
      icon === undefined ? <IconComponent className="mt-px size-4 shrink-0" aria-hidden="true" /> : icon;

    return (
      <div
        ref={ref}
        role="alert"
        className={cn(alertVariants({ variant, bar }), className)}
        {...props}
      >
        {leading}
        <div className="min-w-0 flex-1">{children}</div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none"
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </button>
        )}
      </div>
    );
  }
);
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('font-semibold leading-snug tracking-[-0.005em]', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('opacity-90 [&_p]:leading-normal', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription, alertVariants };
