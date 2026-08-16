/**
 * `PageHeader`, `Page` and `PageBody` — the page chrome (HIVE-3.5, #5291).
 *
 * The ticket's acceptance criteria split cleanly in two. What the header *renders* — the
 * breadcrumb landmark, the `h1`, the slots, and the one-primary-action rule — is here.
 * What it *measures* — no horizontal scroll at 1280 px, a sticky header that stays legible
 * over scrolled content — is in `e2e/hive-page-header.spec.ts`, because jsdom compiles no
 * stylesheet and has no scroll.
 *
 * The contract between the two is `tests/page-chrome-css.test.ts`, which reads the
 * stylesheet the same way `app-shell-css.test.ts` does.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { Button } from '@/app/components/ui/Button';
import PageHeader, { type PageBreadcrumbItem } from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';

/** A three-step trail whose middle step is a group name rather than a destination. */
const TRAIL: readonly PageBreadcrumbItem[] = [
  { label: 'Acme Corp', href: '/ade/dashboard' },
  { label: 'Build' },
  { label: 'Projects' },
];

/** Silence and capture `console.warn` for the composition-rule assertions. */
function captureWarnings(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    calls.push(args.map(String).join(' '));
  };
  return { calls, restore: () => { console.warn = original; } };
}

describe('PageHeader — structure', () => {
  it('renders the title as the page heading', () => {
    render(<PageHeader title="Projects" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Projects' });
    expect(heading).toBeInTheDocument();
    // Always identified, so a region can be labelled by the page's name without the page
    // having to invent an id.
    expect(heading).toHaveAttribute('id');
    expect(heading.getAttribute('id')).not.toBe('');
  });

  it('uses the caller’s id for the heading when one is given', () => {
    render(<PageHeader title="Projects" titleId="projects-title" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('id', 'projects-title');
  });

  it('renders the description, the badge, the leading mark and the metadata row', () => {
    render(
      <PageHeader
        title="Claims 837P"
        badge={<span data-testid="badge">Active</span>}
        description="Professional healthcare claim interchange."
        leading={<span data-testid="leading">CL</span>}
        meta={<span data-testid="meta">EDI X12</span>}
      />
    );

    expect(screen.getByText('Professional healthcare claim interchange.')).toBeInTheDocument();
    expect(screen.getByTestId('badge')).toBeInTheDocument();
    expect(screen.getByTestId('leading')).toBeInTheDocument();
    expect(screen.getByTestId('meta')).toBeInTheDocument();
    // The badge belongs to the title line — it is the page's status, not a sibling of it.
    expect(screen.getByRole('heading', { level: 1 })).toContainElement(screen.getByTestId('badge'));
  });

  it('omits the optional slots entirely when they are not given', () => {
    const { container } = render(<PageHeader title="Projects" />);

    expect(container.querySelector('.page-header__desc')).toBeNull();
    expect(screen.queryByTestId('page-header-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('page-breadcrumb')).not.toBeInTheDocument();
  });

  it('puts the actions in their own cluster', () => {
    render(
      <PageHeader
        title="Projects"
        actions={
          <>
            <Button variant="outline">Import</Button>
            <Button variant="primary">New project</Button>
          </>
        }
      />
    );

    const cluster = screen.getByTestId('page-header-actions');
    expect(within(cluster).getByRole('button', { name: 'Import' })).toBeInTheDocument();
    expect(within(cluster).getByRole('button', { name: 'New project' })).toBeInTheDocument();
  });

  it('renders a tab row and marks the header as carrying one', () => {
    const { container, rerender } = render(
      <PageHeader title="Claims 837P" tabs={<div data-testid="tabs" role="tablist" />} />
    );

    expect(screen.getByTestId('tabs')).toBeInTheDocument();
    expect(container.querySelector('.page-header')).toHaveClass('page-header--with-tabs');

    // Without tabs the modifier goes, so the row keeps its full bottom padding.
    rerender(<PageHeader title="Claims 837P" />);
    expect(container.querySelector('.page-header')).not.toHaveClass('page-header--with-tabs');
  });

  it('merges caller classes onto the header element', () => {
    const { container } = render(<PageHeader title="Projects" className="border-honey" />);

    const header = container.querySelector('header');
    expect(header).toHaveClass('page-header');
    expect(header).toHaveClass('border-honey');
  });
});

describe('PageHeader — breadcrumb', () => {
  it('is a navigation landmark named Breadcrumb', () => {
    render(<PageHeader title="Projects" breadcrumb={TRAIL} />);

    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('renders a real link for every step that has a destination', () => {
    render(<PageHeader title="Projects" breadcrumb={TRAIL} />);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/ade/dashboard');
    expect(links[0]).toHaveTextContent('Acme Corp');

    // A step without an `href` is a group name, not a destination — it must not be a link.
    expect(within(nav).getByText('Build').tagName).toBe('SPAN');
  });

  it('marks the last step as the current page, link or not', () => {
    const { rerender } = render(<PageHeader title="Projects" breadcrumb={TRAIL} />);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('Projects')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('Build')).not.toHaveAttribute('aria-current');

    rerender(
      <PageHeader
        title="Projects"
        breadcrumb={[{ label: 'Acme Corp', href: '/a' }, { label: 'Projects', href: '/b' }]}
      />
    );
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
  });

  it('renders the steps as an ordered list with a separator between each pair', () => {
    const { container } = render(<PageHeader title="Projects" breadcrumb={TRAIL} />);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(TRAIL.length);
    // One chevron fewer than there are steps, and every one hidden from the reader: the
    // separator is punctuation, and "Acme Corp chevron-right Build" is not a trail.
    const separators = container.querySelectorAll('.page-header__crumbs svg[aria-hidden="true"]');
    expect(separators).toHaveLength(TRAIL.length - 1);
  });

  it('renders nothing for an empty trail', () => {
    render(<PageHeader title="Projects" breadcrumb={[]} />);

    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });
});

describe('PageHeader — the one-primary-action rule', () => {
  it('warns when a header is given two primary actions', () => {
    const warnings = captureWarnings();
    try {
      render(
        <PageHeader
          title="Projects"
          actions={
            <>
              <Button variant="primary">New project</Button>
              {/* No variant: `Button` defaults to `default`, the ink alias of `primary`. */}
              <Button>Import</Button>
            </>
          }
        />
      );
    } finally {
      warnings.restore();
    }

    expect(warnings.calls).toHaveLength(1);
    expect(warnings.calls[0]).toContain('2 primary actions');
  });

  it('accepts one primary among any number of quieter actions', () => {
    const warnings = captureWarnings();
    try {
      render(
        <PageHeader
          title="Projects"
          actions={
            <>
              <Button variant="ghost">Settings</Button>
              <Button variant="soft">Export</Button>
              <Button variant="outline">Import</Button>
              <Button variant="primary">New project</Button>
            </>
          }
        />
      );
    } finally {
      warnings.restore();
    }

    expect(warnings.calls).toEqual([]);
  });

  it('says nothing about a header with no actions at all', () => {
    const warnings = captureWarnings();
    try {
      render(<PageHeader title="Projects" />);
    } finally {
      warnings.restore();
    }

    expect(warnings.calls).toEqual([]);
  });

  it('counts primaries through wrappers, arrays and fragments', () => {
    const warnings = captureWarnings();
    try {
      render(
        <PageHeader
          title="Projects"
          actions={
            <div>
              {[<Button key="a">First</Button>]}
              <>
                <Button variant="default">Second</Button>
              </>
            </div>
          }
        />
      );
    } finally {
      warnings.restore();
    }

    expect(warnings.calls).toHaveLength(1);
    expect(warnings.calls[0]).toContain('2 primary actions');
  });

  it('does not mistake a button’s own contents for further actions', () => {
    const warnings = captureWarnings();
    try {
      render(
        <PageHeader
          title="Projects"
          actions={
            <Button variant="primary">
              <span>New project</span>
            </Button>
          }
        />
      );
    } finally {
      warnings.restore();
    }

    expect(warnings.calls).toEqual([]);
  });

  it('stops at a custom component, which it cannot see inside', () => {
    // The documented limit of the check: a page that packages its cluster is not inspected
    // rather than wrongly reported. Two primaries hide in here and nothing is said.
    const Cluster = () => (
      <>
        <Button variant="primary">New project</Button>
        <Button variant="primary">Import</Button>
      </>
    );

    const warnings = captureWarnings();
    try {
      render(<PageHeader title="Projects" actions={<Cluster />} />);
    } finally {
      warnings.restore();
    }

    expect(warnings.calls).toEqual([]);
  });
});

describe('PageHeader — long titles', () => {
  const LONG =
    'Contoso Health clearinghouse claims interchange — professional 837P, production';

  it('wraps a long title by default rather than clipping it', () => {
    const { container } = render(<PageHeader title={LONG} />);

    const title = container.querySelector('.page-header__title > span');
    expect(title).toHaveClass('break-words');
    expect(title).not.toHaveClass('truncate');
    expect(title).not.toHaveAttribute('title');
  });

  it('clips to one line on request, keeping the full text in a tooltip', () => {
    const { container } = render(<PageHeader title={LONG} truncateTitle />);

    const title = container.querySelector('.page-header__title > span');
    expect(title).toHaveClass('truncate');
    expect(title).toHaveAttribute('title', LONG);
  });

  it('does not invent a tooltip for a title that is not a string', () => {
    const { container } = render(
      <PageHeader title={<span data-testid="composed">Claims 837P</span>} truncateTitle />
    );

    expect(container.querySelector('.page-header__title > span')).not.toHaveAttribute('title');
    expect(screen.getByTestId('composed')).toBeInTheDocument();
  });
});

describe('Page and PageBody', () => {
  it('renders the header and the body inside one scroll container', () => {
    const { container } = render(
      <Page>
        <PageHeader title="Projects" />
        <PageBody>
          <p>Content</p>
        </PageBody>
      </Page>
    );

    const page = container.querySelector('.page');
    expect(page).toBeInTheDocument();
    // Sticky sticks to the nearest scroll container, so the header has to be inside it.
    expect(page).toContainElement(screen.getByTestId('page-header'));
    expect(page?.querySelector('.page-body')).toBeInTheDocument();
  });

  it('narrows the body on request, and not otherwise', () => {
    const { container, rerender } = render(
      <Page>
        <PageBody>Content</PageBody>
      </Page>
    );
    expect(container.querySelector('.page')).not.toHaveClass('page--narrow');

    rerender(
      <Page width="narrow">
        <PageBody>Content</PageBody>
      </Page>
    );
    expect(container.querySelector('.page')).toHaveClass('page--narrow');
  });

  it('drops the body’s top padding when asked to sit flush against the header', () => {
    const { container, rerender } = render(<PageBody>Content</PageBody>);
    expect(container.querySelector('.page-body')).not.toHaveClass('page-body--flush');

    rerender(<PageBody flush>Content</PageBody>);
    expect(container.querySelector('.page-body')).toHaveClass('page-body--flush');
  });

  it('passes any other prop through to the element', () => {
    render(
      <Page id="page" data-testid="page">
        <PageBody aria-label="Projects" data-testid="body">
          Content
        </PageBody>
      </Page>
    );

    expect(screen.getByTestId('page')).toHaveAttribute('id', 'page');
    expect(screen.getByTestId('body')).toHaveAttribute('aria-label', 'Projects');
  });
});

describe('PageHeader — accessibility', () => {
  it('has no axe violations in its fullest form', async () => {
    const { container } = render(
      <main>
        <Page>
          <PageHeader
            breadcrumb={TRAIL}
            title="Claims 837P"
            badge={<span>Active</span>}
            description="Professional healthcare claim interchange."
            meta={<span>EDI X12</span>}
            actions={
              <>
                <Button variant="outline">Export</Button>
                <Button variant="primary">Convert to OpenAPI</Button>
              </>
            }
            tabs={
              <div role="tablist" aria-label="Catalog item sections">
                <button type="button" role="tab" aria-selected="true">
                  Overview
                </button>
              </div>
            }
          />
          <PageBody>
            <p>Content</p>
          </PageBody>
        </Page>
      </main>
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
