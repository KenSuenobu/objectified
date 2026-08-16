'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import { cn } from '@lib/utils';

/**
 * `PageHeader` — the one header a page in the Hive shell draws (HIVE-3.5, #5291).
 *
 * Authority: `docs/mockups/DESIGN.md` §5.3, `docs/mockups/assets/hive.css` §7, and the
 * page mockups that use it (`build/projects.html`, `sources/catalog-item.html`,
 * `sources/repository-new.html`).
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Acme Corp › Build › Projects                    [Import] [+ New] N   │  breadcrumb + actions
 * │ Projects                                                             │  24px/600/-0.02em
 * │ 4 projects · avg quality 84 · 3 active · 1 deleted                   │  ≤14-word description
 * │ ── Overview ── Versions 6 ── Lint 2 ─────────────────────────────────│  optional tab row
 * └──────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Before this component every screen hand-rolled the same bar: a white `<header>`, an `h2`
 * with a lucide icon beside it, a subtitle, and a right-hand cluster of buttons. Forty-one
 * files drew one, no two of them at the same size or with the same spacing, and a long
 * project name pushed the buttons off the right edge because nothing in that markup
 * stopped it.
 *
 * ```tsx
 * <Page>
 *   <PageHeader
 *     breadcrumb={[{ label: 'Acme Corp', href: '/ade/dashboard' }, { label: 'Projects' }]}
 *     title="Projects"
 *     description="4 projects · avg quality 84 · 3 active · 1 deleted"
 *     actions={
 *       <>
 *         <Button variant="outline"><Upload aria-hidden />Import</Button>
 *         <Button variant="primary" kbd="N"><Plus aria-hidden />New project</Button>
 *       </>
 *     }
 *   />
 *   <PageBody>{…}</PageBody>
 * </Page>
 * ```
 *
 * ### Why long titles cannot push the actions off screen
 *
 * Two rules, both in the `.page-header__row` block of `globals.css` rather than here: the
 * row wraps, and the title block carries `min-width: 0`. The second is the one that is easy
 * to leave out — a flex item's automatic minimum size is its *content*, so without it a
 * long unbroken title holds the row open at its intrinsic width and the document scrolls
 * sideways. With both, a four-action cluster drops to its own line before either side is
 * squeezed. `e2e/hive-page-header.spec.ts` measures exactly that at 1280 px.
 *
 * ### One primary action
 *
 * DESIGN.md §7 gives a screen one primary button, in ink; everything else is
 * `outline`/`soft`/`ghost` or lives behind an overflow menu. That is a rule about
 * *composition*, so it cannot be a type — but it can be checked. In development this
 * component walks the `actions` tree and warns when it finds more than one primary
 * {@link Button} (a `Button` with no `variant` is primary: `default` is the ink alias).
 * The walk stops at anything it does not recognise, so a page that wraps its cluster in a
 * component of its own is simply not checked rather than wrongly reported.
 *
 * ### The `<header>` element
 *
 * A `<header>` descended from `<main>` is *not* a `banner` landmark (HTML-AAM), so this
 * does not compete with the shell's own chrome for the landmark a screen-reader user
 * navigates by. It is the page's header in the ordinary sense: an `h1`, its trail, and the
 * actions that belong to the whole page.
 *
 * ### Not in scope here
 *
 * The migration of the app's existing screens onto this component is each page's own
 * ticket — Epics 5–9, every one of which lists `3.5` in its dependencies. This ticket
 * builds the header, the frame it sits in ({@link import('./pageChrome') Page} /
 * `PageBody`) and the gallery route that measures both.
 */

/**
 * One step of the breadcrumb trail.
 *
 * The last item is the current page: it is marked `aria-current="page"` whether or not it
 * carries an `href`, because the trail's last step is where the reader already is.
 */
export interface PageBreadcrumbItem {
  /** What the reader sees, e.g. `"Projects"`. */
  label: string;
  /** Where it goes. Omitted for a step that is not a destination (a group name). */
  href?: string;
}

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** The page's name, as its `h1`. Usually a string; a node for a title with inline parts. */
  title: React.ReactNode;
  /** The trail above the title. Rendered as a `Breadcrumb` navigation landmark. */
  breadcrumb?: readonly PageBreadcrumbItem[];
  /** A status badge beside the title — `<Badge status="published" />` and the like. */
  badge?: React.ReactNode;
  /** One line under the title. DESIGN.md §5.3 asks for 14 words or fewer. */
  description?: React.ReactNode;
  /**
   * The right-hand cluster. **One** primary action; the rest secondary, ghost, or behind an
   * overflow menu. The cluster wraps, so it never squeezes the title.
   */
  actions?: React.ReactNode;
  /** An optional underline tab row beneath the title block (`ui/Tabs`, or a route strip). */
  tabs?: React.ReactNode;
  /** Something to the left of the whole title block — a detail page's hex avatar. */
  leading?: React.ReactNode;
  /** A row beneath the description, for format pills and other page-level metadata. */
  meta?: React.ReactNode;
  /**
   * Clip the title to one line with an ellipsis instead of wrapping it.
   *
   * For a detail page whose title is a user-supplied name that the breadcrumb repeats
   * anyway; a string title also gets a `title` attribute so the full text stays reachable.
   * A long title never overflows either way — this only chooses between one line and
   * several.
   */
  truncateTitle?: boolean;
  /**
   * `id` of the `h1`, for a region that wants to be labelled by the page's name. Generated
   * when not given, so the attribute is always there to point at.
   */
  titleId?: string;
  /** Extra classes on the `<header>`. */
  className?: string;
}

/** Accessible name of the breadcrumb landmark, which the acceptance criteria fix. */
const BREADCRUMB_LABEL = 'Breadcrumb';

/** The `Button` variants that draw the ink fill — i.e. that read as *the* primary action. */
const PRIMARY_VARIANTS: ReadonlySet<string> = new Set(['primary', 'default']);

/**
 * How many primary {@link Button}s a slot contains.
 *
 * Walks the element tree rather than the DOM, because the rule is about what the page
 * *wrote*: a `Button` is recognised by identity, and its own children are labels rather
 * than further actions, so the walk does not descend into one. Anything else it descends
 * into by `children`, which covers fragments, arrays and plain wrapper elements — and
 * stops at a custom component, whose children are not this module's to inspect.
 *
 * @param node The `actions` slot, or any part of it.
 * @returns The number of primary buttons found.
 */
function countPrimaryActions(node: React.ReactNode): number {
  let found = 0;

  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;

    const props = child.props as { variant?: string; children?: React.ReactNode };

    if (child.type === Button) {
      // `variant` unset is the ink fill: `Button`'s default variant is `default`, the
      // pre-Hive alias of `primary`. An unstyled `<Button>` is therefore a primary one.
      if (props.variant === undefined || PRIMARY_VARIANTS.has(props.variant)) found += 1;
      return;
    }

    found += countPrimaryActions(props.children);
  });

  return found;
}

/**
 * The breadcrumb trail.
 *
 * The one deliberate departure from `hive.css` §7: the trail is `--fg-muted`, not the
 * `--fg-subtle` the mockup paints it. At the crumb line's 12 px, `--fg-subtle` measures
 * 3.1:1 against the canvas — under the 4.5:1 WCAG AA asks of normal text — and a trail is
 * meant to be read. HIVE-3.3 made the same call for the rail's quiet text;
 * `tests/page-chrome-css.test.ts` holds the ratio for every theme.
 *
 * @param props.items The steps, outermost first.
 * @returns A `Breadcrumb` navigation landmark, or `null` when there is no trail.
 */
function PageBreadcrumb({ items }: { items: readonly PageBreadcrumbItem[] }) {
  if (items.length === 0) return null;

  return (
    <nav
      aria-label={BREADCRUMB_LABEL}
      data-testid="page-breadcrumb"
      className="page-header__crumbs mb-1.5 text-xs text-fg-muted"
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && <ChevronRight aria-hidden className="shrink-0" />}
              {item.href ? (
                <Link
                  href={item.href}
                  aria-current={isLast ? 'page' : undefined}
                  className="rounded-sm text-fg-muted transition-colors duration-[var(--dur-fast)] hover:text-fg"
                >
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The page header.
 *
 * @param props See {@link PageHeaderProps}.
 * @returns The sticky header: breadcrumb, title, description, actions and optional tabs.
 */
export default function PageHeader({
  title,
  breadcrumb,
  badge,
  description,
  actions,
  tabs,
  leading,
  meta,
  truncateTitle = false,
  titleId,
  className,
}: PageHeaderProps) {
  const generatedId = React.useId();
  const headingId = titleId ?? generatedId;

  // In an effect rather than in render: a warning emitted while rendering fires again on
  // every re-render and once more during server rendering, which turns one composition
  // mistake into a stream of identical lines. Erased from production builds entirely.
  React.useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;

    const primaries = countPrimaryActions(actions);
    if (primaries > 1) {
      console.warn(
        `PageHeader: ${primaries} primary actions. DESIGN.md §7 gives a screen one primary ` +
          'button, in ink — make the others `outline`, `soft` or `ghost`, or move them into ' +
          'an overflow menu.'
      );
    }
  }, [actions]);

  return (
    <header
      data-testid="page-header"
      className={cn('page-header', tabs && 'page-header--with-tabs', className)}
    >
      <div className="page-header__inner">
        <div className="page-header__row">
          {/* The title block. It stays a wrapper even with no `leading` slot, because
              `.page-header__row > :first-child` is where its `min-width: 0` comes from —
              the declaration that stops a long title scrolling the document sideways. */}
          <div className={cn('flex items-start', leading ? 'gap-4' : undefined)}>
            {leading}
            <div className="min-w-0">
              {breadcrumb && <PageBreadcrumb items={breadcrumb} />}

              {/* `.page-header__title` carries the type, not a `text-3xl`: the unlayered
                  `h1` rule at the foot of `globals.css` would outrank a utility class. */}
              <h1 id={headingId} className="page-header__title">
                <span
                  className={cn('min-w-0', truncateTitle ? 'truncate' : 'break-words')}
                  title={truncateTitle && typeof title === 'string' ? title : undefined}
                >
                  {title}
                </span>
                {badge}
              </h1>

              {description && <p className="page-header__desc">{description}</p>}

              {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
            </div>
          </div>

          {actions && (
            <div
              data-testid="page-header-actions"
              className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5"
            >
              {actions}
            </div>
          )}
        </div>

        {tabs}
      </div>
    </header>
  );
}
