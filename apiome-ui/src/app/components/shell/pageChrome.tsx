'use client';

import * as React from 'react';
import { cn } from '@lib/utils';

/**
 * The page frame that {@link import('./PageHeader').default PageHeader} sits in
 * (HIVE-3.5, #5291).
 *
 * Authority: `docs/mockups/DESIGN.md` §5.3 and `docs/mockups/assets/hive.css` §7.
 *
 * A page in the Hive shell is three elements:
 *
 * ```tsx
 * <Page>
 *   <PageHeader title="Projects" … />
 *   <PageBody>{…}</PageBody>
 * </Page>
 * ```
 *
 * {@link Page} is the element that **scrolls**, which is the reason the three cannot be
 * collapsed into one. `AppShell`'s `<main>` is `overflow-hidden`, so something inside it
 * has to own the scroll; `position: sticky` sticks to the nearest scroll container, so the
 * header has to be inside that same element. A page that puts its header outside the
 * scroller gets a header that scrolls away, which is exactly the bug the sticky header is
 * here to prevent.
 *
 * ### Width is inherited, not passed
 *
 * The content cap is a custom property, `--page-width`, declared at `--page-max` (1440 px)
 * on `html` and re-declared by `narrow` (920 px). Both the header's inner and the body read
 * it, so a page cannot end up with a 1440 px title over a 920 px column by setting one and
 * forgetting the other — see the "Page chrome" section of `globals.css`, which
 * `tests/page-chrome-css.test.ts` pins.
 *
 * Following `sources/repository-new.html`, `narrow` reaches the **body** only: a form's
 * fields want a 920 px measure, while its title bar still spans the page.
 */

/** How wide a page's content is allowed to be (`DESIGN.md` §5.3). */
export type PageWidth = 'default' | 'narrow';

/** The class that re-declares `--page-width` for the body, by width name. */
const PAGE_WIDTH_CLASS: Readonly<Record<PageWidth, string>> = {
  default: '',
  narrow: 'page--narrow',
};

/** Props for {@link Page}. */
export interface PageProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The header and the body, in that order. */
  children: React.ReactNode;
  /**
   * Content cap for the body: `default` is 1440 px, `narrow` is 920 px for form and
   * reading pages. The header spans `default` either way.
   */
  width?: PageWidth;
}

/**
 * The page's scroll container — the element a sticky header sticks to.
 *
 * @param props See {@link PageProps}; every other prop lands on the `<div>`.
 * @returns The scrolling column that holds the header and the body.
 */
export function Page({ children, width = 'default', className, ...rest }: PageProps) {
  return (
    <div className={cn('page', PAGE_WIDTH_CLASS[width], className)} {...rest}>
      {children}
    </div>
  );
}

/** Props for {@link PageBody}. */
export interface PageBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The page's content, in sections separated by the body's own 24 px gap. */
  children: React.ReactNode;
  /**
   * Drop the body's top padding, for content that has to begin against the header — a
   * full-bleed table or a split pane (`hive.css` `.page-body--flush`).
   */
  flush?: boolean;
}

/**
 * The page's content column: capped, centred, and gapped between its sections.
 *
 * @param props See {@link PageBodyProps}; every other prop lands on the `<div>`.
 * @returns The content column.
 */
export function PageBody({ children, flush = false, className, ...rest }: PageBodyProps) {
  return (
    <div className={cn('page-body', flush && 'page-body--flush', className)} {...rest}>
      {children}
    </div>
  );
}
