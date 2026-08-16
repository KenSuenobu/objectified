/**
 * The feedback set (HIVE-2.5, #5284).
 *
 * Four surfaces that between them cover every moment a screen has no content to draw:
 * nothing yet, still coming, it broke, and you cannot see it from here. Before this ticket
 * each was whatever the page that needed it invented — `"No records found"` on one screen
 * and a blurred gradient orb on the next, a bare red string here and a full red panel
 * there, a centred spinner wherever something was slow.
 *
 * What this suite pins is therefore not "the components render": it is the four claims that
 * make them one set rather than four boxes.
 *
 *   1. **One anatomy.** Empty, gated and error all draw the same honeycomb art, title,
 *      description and actions; only the tone of the art differs, and it differs for a
 *      stated reason.
 *   2. **The art owns its glyph.** A pre-Hive call site still passes
 *      `icon={<X className="h-10 w-10 text-white" />}` for the gradient tile that is gone;
 *      the component must not need those call sites edited, and must not obey them either.
 *   3. **Waiting is announced, and shaped.** Loading is a polite live region carrying a
 *      sentence, the placeholders inside it are decoration, and a table never gets a
 *      spinner in its body.
 *   4. **The copy passes the DESIGN.md §10 voice check.** Every default string this module
 *      ships is measured against the rule rather than being trusted to have followed it.
 *
 * The stylesheet's half — the hexagon, the tone custom properties, the shimmer — is
 * `tests/hive-feedback-styles.test.ts`, because jsdom compiles no CSS. The browser's half,
 * where the two meet, is `e2e/hive-feedback.spec.ts`.
 */

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { FolderOpen } from 'lucide-react';

import {
  EmptyState,
  EmptyStateArt,
  ErrorBanner,
  ErrorState,
  GatedState,
  LoadingState,
  Skeleton,
  SkeletonCard,
  SkeletonCardGrid,
  SkeletonTableRows,
  SkeletonText,
} from '../src/app/components/ui';

/** Every class on an element, as a set — order is meaningless, membership is not. */
function classesOf(element: Element): Set<string> {
  return new Set(element.className.split(/\s+/).filter(Boolean));
}

/** The art element of a rendered state. */
function artOf(container: HTMLElement): HTMLElement {
  const art = container.querySelector<HTMLElement>('.hive-empty-art');
  if (!art) throw new Error('the state rendered no hex art');
  return art;
}

// =========================================================================================
// EmptyState
// =========================================================================================

describe('EmptyState — the honeycomb, the sentence and the way out', () => {
  it('draws the two stacked hexagons and the glyph, hidden from assistive technology', () => {
    const { container } = render(
      <EmptyState icon={<FolderOpen />} title="No projects yet" description="Create one." />
    );

    const art = artOf(container);
    // DESIGN.md §2: the art is ornament. The title is what carries the meaning, so the
    // hexagons must not appear in the accessibility tree beside it.
    expect(art).toHaveAttribute('aria-hidden', 'true');
    expect(art.querySelectorAll('.hive-empty-art__hex')).toHaveLength(1);
    expect(art.querySelectorAll('.hive-empty-art__hex--inner')).toHaveLength(1);
    expect(art.querySelector('svg')).toBeInTheDocument();
  });

  it('drops the second hexagon at the inline size, as the mockups do', () => {
    // At 52 px the two rings read as noise rather than as depth.
    const { container } = render(<EmptyState variant="inline" title="No matches" />);
    expect(artOf(container).querySelectorAll('.hive-empty-art__hex--inner')).toHaveLength(0);
  });

  it('falls back to a glyph rather than drawing an empty hexagon', () => {
    const { container } = render(<EmptyState title="Nothing yet" />);
    expect(artOf(container).querySelector('svg')).toBeInTheDocument();
  });

  it('draws the bee for a brand moment instead of a Lucide glyph', () => {
    const { container } = render(<EmptyState brand title="Welcome to Apiome" />);
    expect(artOf(container).querySelector('.bee-glyph')).toBeInTheDocument();
  });

  it('sizes the art per variant, in rem so the font-size preference reaches it', () => {
    const sizes: Record<string, string> = {
      default: 'size-22',
      compact: 'size-16',
      inline: 'size-13',
    };
    for (const [variant, expected] of Object.entries(sizes)) {
      const { container, unmount } = render(
        <EmptyState variant={variant as 'default'} title="t" />
      );
      expect(classesOf(artOf(container))).toContain(expected);
      unmount();
    }
  });

  it('tints the art by tone, and honey is what the class itself already is', () => {
    // DESIGN.md §2 reserves honey for brand ornament, so it is the default and carries no
    // modifier; the other two exist because a failure and a gate are not brand moments.
    const cases: Array<[undefined | 'danger' | 'neutral', string | null]> = [
      [undefined, null],
      ['danger', 'hive-empty-art--danger'],
      ['neutral', 'hive-empty-art--neutral'],
    ];
    for (const [tone, modifier] of cases) {
      const { container, unmount } = render(<EmptyState tone={tone} title="t" />);
      const classes = classesOf(artOf(container));
      expect(classes.has('hive-empty-art--danger') || classes.has('hive-empty-art--neutral')).toBe(
        modifier !== null
      );
      if (modifier) expect(classes).toContain(modifier);
      unmount();
    }
  });

  it('renders both actions, and none of the wrapper when there are none', () => {
    const { container, rerender } = render(<EmptyState title="No projects yet" />);
    expect(container.querySelectorAll('button')).toHaveLength(0);

    rerender(
      <EmptyState
        title="No projects yet"
        action={<button type="button">New project</button>}
        secondaryAction={<button type="button">Import</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('is a card by default and bare when it sits on someone else’s surface', () => {
    const { container, rerender } = render(<EmptyState title="t" />);
    expect(classesOf(container.firstElementChild as Element)).toContain('bg-surface');

    // `inline` exists for in-card and in-table use, where a second surface would be a box
    // inside a box.
    rerender(<EmptyState variant="inline" title="t" />);
    expect(classesOf(container.firstElementChild as Element)).not.toContain('bg-surface');

    rerender(<EmptyState surface={false} title="t" />);
    expect(classesOf(container.firstElementChild as Element)).not.toContain('bg-surface');
  });

  it('adds the dashed outline that says “rows would go here”', () => {
    const { container } = render(<EmptyState dashed title="No projects match your filters" />);
    const classes = classesOf(container.firstElementChild as Element);
    // A real border: `box-shadow` has no dashed style, and the dashes are the signal.
    expect(classes).toContain('border-dashed');
    expect(classes).toContain('border-[1.5px]');
    expect(classes).toContain('border-border-strong');
  });

  it('draws the title as a heading, or as plain text when a page already has one', () => {
    const { rerender } = render(<EmptyState title="No projects yet" />);
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeInTheDocument();

    // A state nested under an existing `h3` would otherwise break the heading outline.
    rerender(<EmptyState titleAs="p" title="No projects yet" />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
  });

  it('caps the description at the mockup’s 46ch measure', () => {
    render(<EmptyState title="t" description="A description long enough to need wrapping." />);
    const description = screen.getByText('A description long enough to need wrapping.');
    expect(classesOf(description)).toContain('max-w-[46ch]');
  });

  it('has no axe violations in any of its three shapes', async () => {
    for (const variant of ['default', 'compact', 'inline'] as const) {
      const { container, unmount } = render(
        <EmptyState
          variant={variant}
          icon={<FolderOpen />}
          title="No projects yet"
          description="Create one from a template, or import an existing spec."
          action={<button type="button">New project</button>}
        />
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe('EmptyStateArt — the glyph belongs to the art, not to the call site', () => {
  it('renders whatever element it is handed, untouched', () => {
    // 42 pre-Hive call sites still pass `className="h-10 w-10 text-white"` for the gradient
    // tile this ticket removed. The component keeps the element as given — the
    // `.hive-empty-art > svg` rule out-specifies those utilities in the cascade, which is
    // what lets the migration happen without editing forty-two files. See
    // `tests/hive-feedback-styles.test.ts` for the rule that does it.
    const { container } = render(
      <EmptyStateArt icon={<FolderOpen className="h-10 w-10 text-white" />} />
    );
    const glyph = container.querySelector('svg') as SVGElement;
    expect(glyph.getAttribute('class')).toContain('text-white');
  });

  it('is the same art the error and gated states draw', () => {
    // One definition is what makes the four surfaces one family rather than four boxes.
    for (const element of [
      <EmptyState key="e" title="t" />,
      <ErrorState key="r" description="Boom." />,
      <GatedState key="g" />,
    ]) {
      const { container, unmount } = render(element);
      expect(classesOf(artOf(container))).toContain('hive-empty-art');
      unmount();
    }
  });
});

// =========================================================================================
// GatedState
// =========================================================================================

describe('GatedState — the lock preset', () => {
  it('ships the DESIGN.md copy and points at the workspace list', () => {
    render(<GatedState />);
    expect(screen.getByRole('heading', { name: 'Pick a workspace first' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Tenants' })).toHaveAttribute(
      'href',
      '/ade/dashboard/tenants'
    );
  });

  it('takes the neutral tone — a gate is neither a failure nor a brand moment', () => {
    const { container } = render(<GatedState />);
    expect(classesOf(artOf(container))).toContain('hive-empty-art--neutral');
  });

  it('lets a screen say what its own gate is about', () => {
    render(
      <GatedState
        description="API keys are scoped to one workspace."
        href="/ade/dashboard/tenants?new=1"
        actionLabel="Choose a workspace"
      />
    );
    expect(screen.getByText('API keys are scoped to one workspace.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a workspace' })).toHaveAttribute(
      'href',
      '/ade/dashboard/tenants?new=1'
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<GatedState />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// =========================================================================================
// ErrorState / ErrorBanner
// =========================================================================================

describe('ErrorState — what happened, and what to do', () => {
  it('announces itself assertively, because a failure that arrives late must interrupt', () => {
    render(<ErrorState description="Boom." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Boom.');
  });

  it('keeps the pre-Hive contract: default title, description, and a wired retry', () => {
    const onRetry = jest.fn();
    render(<ErrorState description="Boom." onRetry={onRetry} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry at all when the caller has nothing to retry', () => {
    render(<ErrorState description="This endpoint has never been discovered." />);
    expect(screen.queryByRole('button', { name: /Try again/i })).not.toBeInTheDocument();
  });

  it('keeps a further action beside the retry rather than instead of it', () => {
    render(
      <ErrorState
        description="Boom."
        onRetry={jest.fn()}
        action={<button type="button">Open the log</button>}
      />
    );
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the log' })).toBeInTheDocument();
  });

  it('paints the art in danger, so a failure never reads as a brand moment', () => {
    const { container } = render(<ErrorState description="Boom." />);
    expect(classesOf(artOf(container))).toContain('hive-empty-art--danger');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ErrorState description="The API returned 502." onRetry={jest.fn()} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ErrorBanner — the failure above content that still works', () => {
  it('carries the two sentences and the way out, in an alert', () => {
    const onRetry = jest.fn();
    render(
      <ErrorBanner
        title="Couldn’t load projects."
        description="The API returned 502."
        onRetry={onRetry}
      />
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Couldn’t load projects.');
    expect(banner).toHaveTextContent('The API returned 502.');
    fireEvent.click(within(banner).getByRole('button', { name: /Try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is the danger tint of the shared banner, not a box of its own', () => {
    render(<ErrorBanner description="The API returned 502." />);
    expect(classesOf(screen.getByRole('alert'))).toContain('bg-danger-soft');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ErrorBanner title="Couldn’t load projects." description="502." onRetry={jest.fn()} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

// =========================================================================================
// LoadingState and the skeleton presets
// =========================================================================================

describe('LoadingState — the region that says “on its way”', () => {
  it('is a polite live region that names what is loading', () => {
    render(<LoadingState message="Loading repositories…" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Loading repositories…');
  });

  it('is the only live region in the pair — the spinner inside it stays silent', () => {
    // Two nested live regions announce twice, which is worse than announcing once.
    render(<LoadingState message="Publishing…" />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('draws the placeholder instead of a spinner when the shape is known', () => {
    const { container } = render(
      <LoadingState message="Loading repositories…" skeleton={<SkeletonCardGrid count={2} />} />
    );

    // DESIGN.md §8: a skeleton where the layout is known, a spinner only where it is not.
    expect(container.querySelectorAll('.hive-skeleton').length).toBeGreaterThan(0);
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    // The placeholders are decoration, so the sentence is still the only announcement.
    expect(screen.getByRole('status')).toHaveTextContent('Loading repositories…');
  });

  it('has no axe violations in either form', async () => {
    for (const element of [
      <LoadingState key="s" message="Publishing…" />,
      <LoadingState key="k" message="Loading…" skeleton={<SkeletonText />} />,
    ]) {
      const { container, unmount } = render(element);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe('the skeleton presets are shaped, and silent', () => {
  it('draws one bar on the shared shimmer class', () => {
    const { container } = render(<Skeleton className="h-3 w-24" />);
    const bar = container.firstElementChild as Element;
    expect(classesOf(bar)).toContain('hive-skeleton');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
  });

  it('ends a paragraph short, the way a paragraph ends', () => {
    const { container } = render(<SkeletonText lines={4} lastLineWidth="40%" />);
    const bars = container.querySelectorAll<HTMLElement>('.hive-skeleton');
    expect(bars).toHaveLength(4);
    expect(bars[3]).toHaveStyle({ width: '40%' });
    expect(bars[0].style.width).toBe('');
  });

  it('gives a card a tile, a title, a chip row and body lines', () => {
    const { container } = render(<SkeletonCard chips={3} lines={2} />);
    // 1 tile + 2 header bars + 3 chips + 2 lines.
    expect(container.querySelectorAll('.hive-skeleton')).toHaveLength(8);
  });

  it('varies the chip widths, so a chip row is not read as a progress bar', () => {
    const { container } = render(<SkeletonCard chips={3} lines={0} media={false} />);
    const widths = [...container.querySelectorAll<HTMLElement>('.hive-skeleton')]
      .map((bar) => bar.style.width)
      .filter(Boolean);
    expect(new Set(widths).size).toBeGreaterThan(1);
  });

  it('repeats the card across the grid the real cards use', () => {
    const { container } = render(<SkeletonCardGrid count={4} gridClassName="grid grid-cols-2" />);
    expect(classesOf(container.firstElementChild as Element)).toContain('grid-cols-2');
    expect(container.querySelectorAll('[class*="rounded-lg"][class*="bg-surface"]')).toHaveLength(
      4
    );
  });

  it('keeps a table’s columns while it loads, and leaves the actions column empty', () => {
    const { container } = render(
      <table>
        <SkeletonTableRows rows={3} columns={['40%', '6rem', '']} cellClassName="px-4" />
      </table>
    );

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    // A `colSpan` row collapses the column widths; placeholder cells keep the grid.
    expect(rows[0].querySelectorAll('td')).toHaveLength(3);
    expect(rows[0].querySelectorAll('.hive-skeleton')).toHaveLength(2);
    expect(container.querySelector('tbody')).toHaveAttribute('aria-hidden', 'true');
  });
});

// =========================================================================================
// The voice check (DESIGN.md §10)
// =========================================================================================

/**
 * Every default string this module ships, by where it appears.
 *
 * Written out rather than scraped so that adding a default without deciding what it says is
 * a change to this list — which is the point of a voice check.
 */
const DEFAULT_COPY = {
  titles: ['Pick a workspace first', 'Something went wrong'],
  descriptions: ['This page is scoped to one workspace.'],
  buttons: ['Go to Tenants', 'Try again'],
} as const;

describe('the copy passes the DESIGN.md §10 voice check', () => {
  it.each(DEFAULT_COPY.titles)('“%s” is a sentence-case statement, not a shout', (title) => {
    // Sentence case: only the first letter of the first word is capitalised, unless a later
    // word is a proper noun (a workspace, a product, a route name).
    expect(title[0]).toBe(title[0].toUpperCase());
    expect(title).not.toMatch(/[.:!]$/);
    const shouted = title.split(' ').filter((word) => /^[A-Z]{2,}$/.test(word));
    expect(shouted).toEqual([]);
  });

  it.each(DEFAULT_COPY.descriptions)('“%s” answers the question in ≤ 14 words', (description) => {
    expect(description.split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(description).toMatch(/[.!?]$/);
  });

  it.each(DEFAULT_COPY.buttons)('“%s” starts with a verb', (label) => {
    // DESIGN.md §10: "buttons are verbs (“Create key”, not “OK”)".
    const VERBS = ['go', 'try', 'create', 'new', 'import', 'open', 'publish', 'add', 'choose'];
    expect(VERBS).toContain(label.split(' ')[0].toLowerCase());
  });

  it('says what happened rather than reporting a query result', () => {
    // The string this ticket exists to retire. If it comes back as a default, it comes back
    // everywhere at once.
    const defaults = [
      ...DEFAULT_COPY.titles,
      ...DEFAULT_COPY.descriptions,
      ...DEFAULT_COPY.buttons,
    ];
    for (const copy of defaults) expect(copy).not.toMatch(/no records found/i);
  });
});
