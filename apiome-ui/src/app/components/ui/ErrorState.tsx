'use client';

import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { Alert, AlertDescription, AlertTitle } from './Alert';
import { Button } from './Button';
import { EmptyState, type EmptyStateProps, type EmptyStateVariant } from './EmptyState';

/**
 * ErrorState / ErrorBanner — "what happened, and what to do" (HIVE-2.5, #5284).
 *
 * Authority: `docs/mockups/DESIGN.md` §8 (*"Error = inline banner with retry"*), §10
 * (*"Errors: what happened + what to do"*), and the mockups' two spellings of a failure:
 * an `.empty--inline` with a Retry button where a panel would have been
 * (`sources/mcp-analytics.html`), and a `.banner--danger` where the page still has content
 * to show (`sources/mcp-servers.html`).
 *
 * Which of the two to use is the whole decision:
 *
 * | | Use | Because |
 * | --- | --- | --- |
 * | {@link ErrorState} | the thing that failed **is** the content | there is nothing behind it to look at |
 * | {@link ErrorBanner} | the page still works, one part of it did not | a full-height error would hide what did load |
 *
 * ### Why it is built on `EmptyState`
 *
 * A failure and an emptiness are the same shape — art, a sentence, a way forward — and the
 * app had them as two unrelated boxes: a red-tinted panel with a `red-100` icon tile on one
 * side, a blue gradient orb on the other. Sharing the anatomy is what makes the four
 * feedback surfaces read as one family; only the tone of the art differs, and it differs
 * because DESIGN.md §2 will not let honey mean "something is wrong".
 *
 * ### Announcing it
 *
 * Both carry `role="alert"`, which is an assertive live region: a failure that arrives after
 * the page has settled has to interrupt, or a screen-reader user is left waiting on content
 * that is never coming.
 */

/** The retry label the whole app uses, so the verb is learnable. */
const RETRY_LABEL = 'Try again';

export interface ErrorStateProps
  extends Omit<EmptyStateProps, 'title' | 'tone' | 'action' | 'brand'> {
  /** What happened, in sentence case. Defaults to the app-wide phrasing. */
  title?: string;
  /**
   * Why, and what to do — typically the caught error's message.
   *
   * A message the reader cannot act on ("Request failed with status code 500") is worth
   * pairing with one they can: *"The insight service is unavailable — try again in a
   * moment."*
   */
  description?: React.ReactNode;
  /** Replace the warning glyph. */
  icon?: React.ReactNode;
  /** Renders the retry button, wired to this handler. */
  onRetry?: () => void;
  /** Label for the retry button. */
  retryLabel?: string;
  /** A further way out — "Open the log", "Contact support". */
  action?: React.ReactNode;
}

/**
 * The failure that replaces the content.
 *
 * @param props See {@link ErrorStateProps}; everything {@link EmptyState} takes passes through.
 * @returns The state, in an assertive live region.
 */
export const ErrorState = React.forwardRef<HTMLDivElement, ErrorStateProps>(
  (
    {
      title = 'Something went wrong',
      description,
      icon,
      onRetry,
      retryLabel = RETRY_LABEL,
      action,
      variant = 'default',
      ...props
    },
    ref
  ) => (
    <EmptyState
      ref={ref}
      role="alert"
      tone="danger"
      icon={icon ?? <AlertTriangle />}
      title={title}
      description={description}
      variant={variant}
      action={
        onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden />
            {retryLabel}
          </Button>
        ) : (
          action
        )
      }
      secondaryAction={onRetry ? action : undefined}
      {...props}
    />
  )
);
ErrorState.displayName = 'ErrorState';

export interface ErrorBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** What happened — a short clause, not a stack frame. */
  title?: string;
  /** What to do about it. */
  description?: React.ReactNode;
  /** Renders the retry button, wired to this handler. */
  onRetry?: () => void;
  /** Label for the retry button. */
  retryLabel?: string;
  /** A further action, rendered beside retry. */
  action?: React.ReactNode;
  /** Show a dismiss affordance, and what to do when it is pressed. */
  onClose?: () => void;
}

/**
 * The failure that sits above content that still works — DESIGN.md §8's "inline banner with
 * retry".
 *
 * The pattern it replaces is a bare red string: `{error && <p className="text-red-600">
 * {error}</p>}`, which says what happened and never what to do. Passing `onRetry` is
 * therefore the normal case, not the decorated one.
 *
 * ```tsx
 * {error ? <ErrorBanner title="Couldn't load projects." description={error} onRetry={reload} /> : null}
 * ```
 *
 * @param props See {@link ErrorBannerProps}.
 * @returns A danger-tinted `Alert` carrying the two sentences and the way out.
 */
export const ErrorBanner = React.forwardRef<HTMLDivElement, ErrorBannerProps>(
  (
    { className, title, description, onRetry, retryLabel = RETRY_LABEL, action, onClose, ...props },
    ref
  ) => (
    <Alert
      ref={ref}
      variant="danger"
      onClose={onClose}
      className={cn(className)}
      actions={
        onRetry || action ? (
          <>
            {onRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw aria-hidden />
                {retryLabel}
              </Button>
            ) : null}
            {action}
          </>
        ) : undefined
      }
      {...props}
    >
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {description ? <AlertDescription>{description}</AlertDescription> : null}
    </Alert>
  )
);
ErrorBanner.displayName = 'ErrorBanner';

/** Re-exported so a caller can type an error surface without importing two modules. */
export type { EmptyStateVariant as ErrorStateVariant };
