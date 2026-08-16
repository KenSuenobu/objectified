'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';

/**
 * Button — the Hive control (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §8 (`.btn`), `docs/mockups/DESIGN.md` §7, and
 * the gallery in `docs/mockups/foundations/design-system.html` §Buttons.
 *
 * Everything here is a *token* reference — `bg-ink`, `shadow-control`, `--control-h` — so a
 * theme swap (HIVE-1.2) and a density or font-size preference (HIVE-1.3) reach the button
 * without it knowing they exist. The pre-Hive palette classes (`bg-indigo-600`,
 * `dark:ring-offset-slate-900`) could not: they named a colour rather than a role.
 *
 * The palette in one line: **one primary per screen, in ink.** `accent` is for the second
 * action that still has to be seen, `soft`/`ghost` for everything else, `danger` for
 * destruction, and `honey` only for brand moments (DESIGN.md §2 — honey is ornament).
 */

/** Shared geometry, motion and interaction state — hive.css `.btn`. */
const BUTTON_BASE = [
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap',
  'rounded-md text-sm font-medium leading-none tracking-[0.01em] no-underline',
  'transition-[background-color,box-shadow,color,transform] duration-[var(--dur-fast)] ease-out',
  // The 3 px azure focus ring is the app-wide `*:focus-visible` rule in globals.css, which
  // is unlayered and so cannot be expressed here; all this has to do is drop the outline.
  'focus-visible:outline-none',
  'active:translate-y-px',
  'disabled:pointer-events-none disabled:opacity-50',
  'aria-disabled:pointer-events-none aria-disabled:opacity-50',
  // DESIGN.md §3.5: a glyph inside a button is 15 px — subordinate to its label — and in
  // `rem`, so it keeps that proportion at every font scale.
  '[&_svg]:size-[var(--icon-button)] [&_svg]:shrink-0',
].join(' ');

/** Ink fill — the one primary action on a screen. */
const VARIANT_PRIMARY = 'bg-ink text-ink-fg shadow-control-solid hover:bg-ink-hover';
/** Azure fill — a second action that still has to be seen (publish, connect). */
const VARIANT_ACCENT = 'bg-accent text-fg-on-accent shadow-control-solid hover:bg-accent-hover';
/** Surface + inset hairline — the default secondary control. */
const VARIANT_OUTLINE = 'bg-surface text-fg shadow-control hover:bg-subtle';
/** Tinted, borderless — a quieter secondary, and the one toolbars use. */
const VARIANT_SOFT = 'bg-subtle text-fg hover:bg-inset';
/** Chromeless until hovered — icon buttons, row actions, dismissals. */
const VARIANT_GHOST =
  'bg-transparent text-fg-muted hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] hover:text-fg';
/** Red fill — destruction, confirmed. */
const VARIANT_DANGER =
  'bg-danger text-fg-on-accent shadow-control-solid hover:bg-[color-mix(in_srgb,var(--danger)_88%,black)]';
/** Red tint — destruction offered, not yet confirmed. */
const VARIANT_DANGER_SOFT =
  'bg-danger-soft text-danger-fg hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)]';
/** Green fill — the pre-Hive `success` button, re-pointed at the `ok` role. */
const VARIANT_SUCCESS =
  'bg-ok text-fg-on-accent shadow-control-solid hover:bg-[color-mix(in_srgb,var(--ok)_88%,black)]';
/** Honey fill — brand moments only (onboarding, upgrade, celebration). */
const VARIANT_HONEY =
  'bg-honey text-honey-ink shadow-control-solid hover:bg-[color-mix(in_srgb,var(--honey)_88%,black)]';
/** No chrome at all — a button that has to read as a link. */
const VARIANT_LINK = 'h-auto bg-transparent p-0 text-accent hover:underline';

const buttonVariants = cva(BUTTON_BASE, {
  variants: {
    /**
     * Role, not colour. The first eight names are the DESIGN.md §7 vocabulary; the five
     * below them are the pre-Hive names, kept as aliases so no consumer needs an edit.
     */
    variant: {
      primary: VARIANT_PRIMARY,
      accent: VARIANT_ACCENT,
      outline: VARIANT_OUTLINE,
      soft: VARIANT_SOFT,
      ghost: VARIANT_GHOST,
      danger: VARIANT_DANGER,
      'danger-soft': VARIANT_DANGER_SOFT,
      honey: VARIANT_HONEY,
      link: VARIANT_LINK,

      // ---- pre-Hive aliases -------------------------------------------------
      /** Was indigo; the Hive primary is ink. */
      default: VARIANT_PRIMARY,
      /** Was a grey fill; reads as `soft`. */
      secondary: VARIANT_SOFT,
      /** Was red; reads as `danger`. */
      destructive: VARIANT_DANGER,
      /** Was emerald; reads as the `ok` role. */
      success: VARIANT_SUCCESS,
    },
    /**
     * Height, from the density-aware `--control-h*` metrics (DESIGN.md §3.3).
     *
     * Spelled `h-[var(--control-h)]` rather than with globals.css's `h-control` utility on
     * purpose: `tailwind-merge` only recognises a height it can parse, so `h-control` and a
     * caller's `h-8` would *both* survive `cn()` and the winner would be decided by CSS
     * source order. The arbitrary form is the same value and still overridable, which is
     * what "no consumer needs edits" requires of a primitive. Pages keep using the named
     * utilities — they are not merged against anything.
     */
    size: {
      sm: 'h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs',
      default: 'h-[var(--control-h)] px-3',
      lg: 'h-[var(--control-h-lg)] px-4 text-base',
      icon: 'size-[var(--control-h)] p-0',
    },
    /** Fully rounded — filter and view controls that sit among chips. */
    pill: {
      true: 'rounded-full',
      false: '',
    },
  },
  compoundVariants: [
    // `link` has no box, so it must not be given one by a size.
    { variant: 'link', size: 'default', className: 'h-auto px-0' },
    { variant: 'link', size: 'sm', className: 'h-auto px-0' },
    { variant: 'link', size: 'lg', className: 'h-auto px-0' },
  ],
  defaultVariants: {
    variant: 'default',
    size: 'default',
    pill: false,
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the single child element *as* the button, merging the button classes onto it. */
  asChild?: boolean;
  /**
   * A keyboard shortcut to show at the trailing edge, e.g. `"N"` or `"⌘K"`.
   *
   * Rendered as a `.kbd` chip, which the "Show keyboard hints" preference (HIVE-1.4) hides
   * globally. It is `aria-hidden`: the shortcut is an affordance for sighted pointer users,
   * and the button's own label is what assistive technology should read.
   */
  kbd?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, pill, asChild, kbd, children, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, pill, className }));
    const shortcut = kbd ? (
      <span className="kbd ml-1" aria-hidden="true">
        {kbd}
      </span>
    ) : null;

    // asChild: render the single child element as the button (like Radix's Slot),
    // merging the button classes onto it so an <a>/<Link> *is* the styled control —
    // not a plain child nested inside a <button> (invalid, and it loses the flex layout).
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        className?: string;
        children?: React.ReactNode;
      }>;
      return React.cloneElement(child, {
        ...props,
        className: cn(classes, child.props.className),
        children: shortcut ? (
          <>
            {child.props.children}
            {shortcut}
          </>
        ) : (
          child.props.children
        ),
      });
    }
    return (
      <button className={classes} ref={ref} {...props}>
        {children}
        {shortcut}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
