'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';

/**
 * Card — the Hive panel (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §12 (`.card`), `docs/mockups/DESIGN.md` §7,
 * gallery §Cards.
 *
 * A card is a *surface*, not a box: the default is the surface colour lifted by one step of
 * elevation, with no border at all. `flat` swaps the lift for a hairline (panels inside
 * panels), `soft` drops both (a tinted region), and `honey` is the brand moment.
 *
 * Padding comes from `--card-pad`, which the density preference swaps, spelled as an
 * arbitrary value so a caller's own `p-4` still wins through `cn()`.
 */
const cardVariants = cva('rounded-lg bg-surface text-fg transition-[box-shadow,transform] duration-[var(--dur-base)] ease-out', {
  variants: {
    variant: {
      /** Surface + soft shadow — the default panel. */
      default: 'shadow-sm',
      /** Hairline instead of elevation — a panel nested inside another surface. */
      flat: 'shadow-[inset_0_0_0_1px_var(--border)]',
      /** Tinted, flush — a region of a page rather than an object on it. */
      soft: 'bg-subtle shadow-none',
      /** Brand moment: honey wash into the surface (checklists, tips, onboarding). */
      honey: 'bg-[linear-gradient(135deg,var(--honey-soft),var(--bg-surface)_70%)] shadow-sm',
    },
    /** Lifts on hover — only for a card that is itself clickable. */
    hover: {
      true: 'hover:-translate-y-px hover:shadow-md',
      false: '',
    },
    /** The whole card is a link: inherit ink, never underline. */
    link: {
      true: 'block text-inherit no-underline hover:no-underline',
      false: '',
    },
    /** Chosen, in a list of choices — an accent hairline plus its tint. */
    selected: {
      true: 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]',
      false: '',
    },
  },
  defaultVariants: {
    variant: 'default',
    hover: false,
    link: false,
    selected: false,
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, hover, link, selected, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(cardVariants({ variant, hover, link, selected }), className)}
      {...props}
    />
  )
);
Card.displayName = 'Card';

/** The card's title row: `--card-pad` across, a hairline under it. */
const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex flex-col gap-1.5 border-b border-border p-[var(--card-pad)]',
      className
    )}
    {...props}
  />
));
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn('text-base font-semibold leading-snug tracking-[-0.01em] text-fg', className)}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm text-fg-muted', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

/** The card's content slot. */
const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('p-[var(--card-pad)]', className)} {...props} />
));
CardContent.displayName = 'CardContent';

/** Alias for {@link CardContent} under the name hive.css and DESIGN.md §7 use. */
const CardBody = CardContent;

/** The card's footer: metadata on the left, one action on the right. */
const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex items-center justify-between gap-3 border-t border-border',
      'px-[var(--card-pad)] py-3 text-sm text-fg-muted',
      className
    )}
    {...props}
  />
));
CardFooter.displayName = 'CardFooter';

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  CardBody,
  cardVariants,
};
