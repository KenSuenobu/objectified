'use client';

import * as React from 'react';
import { Inbox, Lock } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { BrandMark } from '../brand';
import { Button } from './Button';

/**
 * EmptyState — the Hive "nothing here yet" surface (HIVE-2.5, #5284).
 *
 * Authority: `docs/mockups/assets/hive.css` §14 (`.empty`, `.empty__art`, `--inline`,
 * `--dashed`), `docs/mockups/DESIGN.md` §2 (the hexagon and honey are brand ornament, and
 * empty-state art is one of the two places they belong), §7 and §10 (the voice).
 *
 * ### Why this replaced a gradient orb
 *
 * The app had two empty states: `"No records found"` in muted grey, and a blurred
 * blue-to-indigo orb behind a white-on-indigo icon tile. Neither is the design language —
 * the first tells the reader what the query returned, the second is decoration that says
 * nothing at all. This is the third answer, and the only one DESIGN.md describes: honeycomb
 * art, a title that names the situation, a description that teaches the way out of it, and
 * at most two actions.
 *
 * ```tsx
 * <EmptyState
 *   icon={<FolderOpen />}
 *   title="No projects yet"
 *   description="Create one from a template, or import an existing spec."
 *   action={<Button variant="primary">New project</Button>}
 *   secondaryAction={<Button variant="outline">Import</Button>}
 * />
 * ```
 *
 * ### The three shapes
 *
 * | Variant | Shape | Where |
 * | --- | --- | --- |
 * | `default` | centred column on its own surface, 88 px art | a whole page or panel with nothing in it |
 * | `compact` | the same, tighter, 64 px art | a card body or a tab panel |
 * | `inline` | a left-aligned row, 52 px art, no surface | inside a card, a table cell or a toolbar |
 *
 * `dashed` adds the hairline outline of `hive.css` `.empty--dashed` to any of them — the
 * mockups use it for a *filtered-to-nothing* list, where the dashes say "this box would
 * hold rows" in a way a bare sentence cannot.
 *
 * ### Writing the copy (DESIGN.md §10)
 *
 * Titles are nouns or short statements in sentence case; descriptions answer "what do I do
 * about it?" in **≤ 14 words**; buttons are verbs. `"Nothing published yet — publish a
 * version to see it here."`, never `"No records found."` `tests/hive-feedback-set.test.tsx`
 * measures the defaults this module ships against exactly that rule.
 *
 * ### Sizing and colour
 *
 * Nothing here is a frozen size or a named colour: the art box is `rem`, its inner hexagon
 * and glyph are percentages of it, and the three tones are custom properties swapped by the
 * `.hive-empty-art--*` classes in `globals.css`. Theme, density and the six font scales all
 * reach it without the component knowing they exist.
 */

/** How much room the state takes, and which way it is laid out. */
export type EmptyStateVariant = 'default' | 'compact' | 'inline';

/** What the art says before the words are read. */
export type EmptyStateTone =
  /** Brand ornament — the default, and what DESIGN.md §2 reserves honey for. */
  | 'honey'
  /** Something failed. {@link ErrorState} uses this. */
  | 'danger'
  /** Uneventful: a filtered-out list, a locked page, a state nobody caused. */
  | 'neutral';

/** The element a title is drawn as, for a state that sits under an existing heading. */
export type EmptyStateTitleElement = 'h2' | 'h3' | 'h4' | 'p';

// ---------------------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------------------

/** The art box for each variant, in `rem`, from `hive.css` §14's 88 px / 64 px / 52 px. */
const ART_SIZE: Readonly<Record<EmptyStateVariant, string>> = {
  default: 'size-22',
  compact: 'size-16',
  inline: 'size-13',
};

/** The tone modifier each tone adds to `.hive-empty-art`. Honey is the class's own default. */
const ART_TONE: Readonly<Record<EmptyStateTone, string>> = {
  honey: '',
  danger: 'hive-empty-art--danger',
  neutral: 'hive-empty-art--neutral',
};

export interface EmptyStateArtProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The glyph on top of the hexagons. A Lucide element; sized and coloured by the art. */
  icon?: React.ReactNode;
  /** Draw the Apiome bee instead of a glyph — for a first-run or brand moment. */
  brand?: boolean;
  /** Which of the three sizes to draw. */
  variant?: EmptyStateVariant;
  /** Which tone the hexagons and the glyph take. */
  tone?: EmptyStateTone;
}

/**
 * The honeycomb art of `hive.css` §14: two stacked hexagons with a glyph on top.
 *
 * Exported because {@link ErrorState} and the loading states draw the same ornament — one
 * definition is what keeps the four feedback surfaces recognisably one family.
 *
 * The second hexagon is dropped for the `inline` size, exactly as the mockups do: at 52 px
 * the two rings read as noise rather than as depth.
 *
 * @param props See {@link EmptyStateArtProps}.
 * @returns The art, hidden from assistive technology — the title carries the meaning.
 */
export const EmptyStateArt = React.forwardRef<HTMLDivElement, EmptyStateArtProps>(
  ({ className, icon, brand = false, variant = 'default', tone = 'honey', ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden
      className={cn('hive-empty-art', ART_TONE[tone], ART_SIZE[variant], className)}
      {...props}
    >
      <span className="hive-empty-art__hex" />
      {variant === 'inline' ? null : <span className="hive-empty-art__hex--inner" />}
      {/* Both branches end in an `<svg>`, which is what the `.hive-empty-art > svg` rule
          sizes and colours — so neither the bee nor a Lucide glyph carries a size here. */}
      {brand ? <BrandMark variant="glyph" decorative /> : (icon ?? <Inbox />)}
    </div>
  )
);
EmptyStateArt.displayName = 'EmptyStateArt';

// ---------------------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------------------

/** Outer layout per variant: the mockup's `.empty` column, or its `--inline` row. */
const SHELL: Readonly<Record<EmptyStateVariant, string>> = {
  default: 'flex flex-col items-center gap-2 px-6 py-12 text-center',
  compact: 'flex flex-col items-center gap-2 px-5 py-8 text-center',
  inline: 'flex flex-row items-start gap-4 p-5 text-left',
};

/** Title type per variant — `--fs-lg` for a block state, body size for an inline one. */
const TITLE: Readonly<Record<EmptyStateVariant, string>> = {
  default: 'text-lg',
  compact: 'text-lg',
  inline: 'text-sm',
};

/** Description type per variant. The `46ch` cap is `hive.css` `.empty__desc`. */
const DESCRIPTION: Readonly<Record<EmptyStateVariant, string>> = {
  default: 'max-w-[46ch] text-sm',
  compact: 'max-w-[46ch] text-sm',
  inline: 'max-w-[46ch] text-xs',
};

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * The glyph in the hex art. A Lucide element — the art sizes and colours it, so the
   * element needs no classes of its own.
   */
  icon?: React.ReactNode;
  /** Draw the Apiome bee instead of a glyph (first run, onboarding, a launcher). */
  brand?: boolean;
  /** What the situation is, in sentence case. DESIGN.md §10. */
  title: string;
  /** What to do about it, in ≤ 14 words. */
  description?: React.ReactNode;
  /** The one thing to do next — a verb, in a primary `Button`. */
  action?: React.ReactNode;
  /** A second, quieter way out. Rendered beside `action`. */
  secondaryAction?: React.ReactNode;
  /** Which of the three shapes to draw. */
  variant?: EmptyStateVariant;
  /** Which tone the art takes. */
  tone?: EmptyStateTone;
  /** Add the dashed outline — "rows would go here", for a filtered-to-nothing list. */
  dashed?: boolean;
  /**
   * Draw the state on its own card surface.
   *
   * On by default for the block variants, which usually stand alone on a page, and off for
   * `inline`, which by definition already sits on someone else's surface.
   */
  surface?: boolean;
  /** The element the title is drawn as. `p` keeps a state out of the heading outline. */
  titleAs?: EmptyStateTitleElement;
}

/**
 * The Hive empty state.
 *
 * @param props See {@link EmptyStateProps}.
 * @returns The art, the title, the description and up to two actions.
 */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      className,
      icon,
      brand = false,
      title,
      description,
      action,
      secondaryAction,
      variant = 'default',
      tone = 'honey',
      dashed = false,
      surface,
      titleAs: TitleTag = 'h3',
      ...props
    },
    ref
  ) => {
    const isInline = variant === 'inline';
    const onSurface = surface ?? !isInline;
    const actions = action || secondaryAction ? (
      <div
        className={cn(
          'flex flex-wrap items-center gap-2',
          isInline ? 'mt-2' : 'mt-2.5 justify-center'
        )}
      >
        {action}
        {secondaryAction}
      </div>
    ) : null;

    const body = (
      <>
        <TitleTag className={cn('font-semibold tracking-[-0.01em] text-fg', TITLE[variant])}>
          {title}
        </TitleTag>
        {description ? (
          <p className={cn('text-fg-muted', DESCRIPTION[variant])}>{description}</p>
        ) : null}
        {actions}
      </>
    );

    return (
      <div
        ref={ref}
        className={cn(
          SHELL[variant],
          'rounded-lg',
          onSurface && 'bg-surface shadow-sm',
          // A real dashed `border`, not an inset shadow: a shadow cannot be dashed, and the
          // dashes are the whole point — `hive.css` §14 `.empty--dashed` draws them at
          // 1.5 px so they still read against the hairline colour.
          dashed && 'border-[1.5px] border-dashed border-border-strong',
          className
        )}
        {...props}
      >
        <EmptyStateArt icon={icon} brand={brand} variant={variant} tone={tone} />
        {isInline ? <div className="flex min-w-0 flex-1 flex-col gap-1">{body}</div> : body}
      </div>
    );
  }
);
EmptyState.displayName = 'EmptyState';

// ---------------------------------------------------------------------------------------
// GatedState
// ---------------------------------------------------------------------------------------

/** Where a reader goes to pick a workspace. */
const TENANTS_HREF = '/ade/dashboard/tenants';

export interface GatedStateProps extends Omit<EmptyStateProps, 'icon' | 'title' | 'tone'> {
  /** Override the headline. Keep it a statement of what is missing, not an apology. */
  title?: string;
  /** Where the action goes. Defaults to the workspace list. */
  href?: string;
  /** The action's label — a verb phrase naming the destination. */
  actionLabel?: string;
}

/**
 * GatedState — the lock preset of {@link EmptyState} (DESIGN.md §5.2, gallery §Feedback).
 *
 * Roughly a dozen screens are scoped to one workspace and cannot draw anything until one is
 * chosen. Each had grown its own amber card — `"No tenant selected"` over a yellow gradient,
 * with the palette classes spelled out — and the twelve had drifted into eleven different
 * shades of amber and four different sentences.
 *
 * This is the one of them the design language describes: the same hex art as every other
 * empty state, in the neutral tone (a gate is not a failure and not a brand moment), and one
 * primary action pointing at the workspace list.
 *
 * ```tsx
 * if (!currentTenantId) return <GatedState description="API keys are scoped to a workspace." />;
 * ```
 *
 * @param props See {@link GatedStateProps}; everything {@link EmptyState} takes passes through.
 * @returns The locked empty state.
 */
export const GatedState = React.forwardRef<HTMLDivElement, GatedStateProps>(
  (
    {
      title = 'Pick a workspace first',
      description = 'This page is scoped to one workspace.',
      href = TENANTS_HREF,
      actionLabel = 'Go to Tenants',
      action,
      ...props
    },
    ref
  ) => (
    <EmptyState
      ref={ref}
      icon={<Lock />}
      tone="neutral"
      title={title}
      description={description}
      action={
        action ?? (
          <Button variant="primary" asChild>
            <a href={href}>{actionLabel}</a>
          </Button>
        )
      }
      {...props}
    />
  )
);
GatedState.displayName = 'GatedState';
