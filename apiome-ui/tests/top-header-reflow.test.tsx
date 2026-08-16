/**
 * Reflow contract for the shared top header (DH-3.5, apiome/private-suite#2622).
 *
 * WCAG 2.2 AA 1.4.10 asks that content be presentable at 320 CSS pixels without needing to
 * be scrolled sideways. The RC1 pre-GA validation run (`docs/releases/RC1_EVIDENCE.md`
 * §4.3) found every §31.1 critical authoring route scrolling horizontally at that width by
 * 111px — the same overflow, from the same nodes, on all of them, because the cause was
 * this header: the primary nav list was an `inline-flex` row that could neither shrink nor
 * wrap, and `text-center` kept it centred as it overflowed, so it spilled past both edges
 * of a `nav` that had been squeezed to zero width and out of the document.
 *
 * The fix is that the header's three clusters wrap onto as many rows as the viewport
 * needs. These tests pin the decisions that make that work, and the two it must not
 * undo — becoming a horizontal scroller (which would also clip the absolutely positioned
 * suite dropdowns) and growing taller than 48px when everything still fits on one row,
 * which is what `ADE_SUBHEADER_RESERVE_PX` and the `calc(100vh - 48px)` layouts measure
 * from.
 *
 * jsdom compiles no stylesheet, so these are assertions about the utilities the rendered
 * header chose, not about measured geometry — the same division of labour as
 * `helpers/tailwind-contrast.ts`. The authority on rendered reflow is the Playwright check
 * in `private-suite/designer/tests/e2e/authoring-responsive.spec.ts`.
 */
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockUsePathname = jest.fn<string, []>(() => '/ade/dashboard/projects');

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));

jest.mock('@/app/hooks/useDarkMode', () => ({
  useDarkMode: () => false,
}));

jest.mock('@/app/providers/ThemeProvider', () => ({
  useTheme: () => ({ currentTheme: { name: 'Light' }, isSystemTheme: false }),
}));

jest.mock('@/app/components/ade/WhatsNewDialog', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/app/components/ade/preferences/PreferencesDrawerHost', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/app/components/ade/CreateTenantDialog', () => ({
  __esModule: true,
  default: () => null,
}));

// The real product catalog, unentitled — the nav renders exactly what a signed-in user
// sees, which is the row whose width overflowed the document.
jest.mock('@lib/db/commercial-access', () => ({
  getCommercialAccessForSession: jest.fn(async () => ({
    entitledFlags: [],
    homeCards: [],
    navItems: (
      jest.requireActual('../lib/external-links') as typeof import('../lib/external-links')
    ).getCommercialNavItems(new Set<string>()),
  })),
}));

jest.mock('@lib/auth/tenant-membership-context', () => ({
  loadTenantMembershipContext: jest.fn(async () => ({
    tenants: [],
    adminTenantIds: [],
    createTenant: null,
  })),
}));

jest.mock('@lib/auth/last-active-tenant-actions', () => ({
  persistLastActiveTenant: jest.fn(async () => undefined),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { enrichedTenantContext, renderTopHeader } from './helpers/top-header-fixture';

/** Utilities that turn an element into something the reader has to drag sideways. */
const SCROLLER_UTILITIES = [
  'overflow-auto',
  'overflow-scroll',
  'overflow-x-auto',
  'overflow-x-scroll',
];

/**
 * The header element, once its tenant memberships have settled.
 *
 * @returns The rendered `<header>`.
 */
async function renderHeader(): Promise<HTMLElement> {
  renderTopHeader(enrichedTenantContext());
  const header = document.querySelector('header');
  expect(header).not.toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Switch tenant' })).toBeEnabled());
  return header as HTMLElement;
}

/** The primary nav's list of destinations. */
function navList(header: HTMLElement): HTMLElement {
  const list = header.querySelector('nav[aria-label="Main navigation"] ul');
  expect(list).not.toBeNull();
  return list as HTMLElement;
}

describe('top header reflow (DH-3.5 apiome/private-suite#2622)', () => {
  it('wraps its clusters instead of overflowing them', async () => {
    const header = await renderHeader();

    // The whole point: three clusters that no longer fit side by side take another row.
    expect(header).toHaveClass('flex-wrap');
    // Both axes get a gap once there is more than one row.
    expect(header).toHaveClass('gap-x-3', 'gap-y-1');
  });

  it('keeps the 48px bar the rest of the app measures from when nothing wraps', async () => {
    const header = await renderHeader();

    // `min-h-12`, not `h-12`: a fixed height cannot grow for a second row, and a header
    // with vertical padding would be 49px unwrapped — 1px of drift in every layout that
    // subtracts 48px from the viewport.
    expect(header).toHaveClass('min-h-12');
    expect(header).not.toHaveClass('h-12');
    expect(header.className).not.toMatch(/\bpy-\d/);
  });

  it('never becomes a horizontal scroller', async () => {
    const header = await renderHeader();

    // Scrolling the nav sideways would satisfy the document-level reflow check and fail
    // the criterion it stands for — and a scroll container clips the suite dropdowns,
    // which are positioned outside their trigger.
    for (const element of [header, header.querySelector('nav[aria-label="Main navigation"]')!]) {
      for (const utility of SCROLLER_UTILITIES) {
        expect(element).not.toHaveClass(utility);
      }
    }
  });

  it('gives the nav its own row at narrow widths and a shared one from sm up', async () => {
    const header = await renderHeader();
    const nav = header.querySelector('nav[aria-label="Main navigation"]') as HTMLElement;

    // A full basis is what makes flex break the line; `order-last` puts that line under
    // the logo and the account cluster rather than between them.
    expect(nav).toHaveClass('basis-full', 'order-last');
    expect(nav).toHaveClass('sm:basis-80', 'sm:order-none');
    // It must still be able to give up width to its neighbours on a single row.
    expect(nav).toHaveClass('min-w-0', 'flex-1');
  });

  it('lets the destinations themselves wrap, and no longer centres them by overflowing', async () => {
    const header = await renderHeader();
    const list = navList(header);

    expect(list).toHaveClass('flex', 'flex-wrap', 'justify-center');
    // `inline-flex` sized the list to its content and refused to wrap; `text-center` on
    // the nav then centred the overflow instead of containing it.
    expect(list).not.toHaveClass('inline-flex');
    expect(list.parentElement).not.toHaveClass('text-center');
  });

  it('keeps the logo cluster at its natural width so it cannot be squeezed over the account controls', async () => {
    const header = await renderHeader();
    // The wordmark is `BrandMark` since HIVE-1.5: one wrapper, named for assistive
    // technology, with the two theme variants of the artwork stacked inside it.
    const logo = header.querySelector('.brand-wordmark')?.parentElement;

    expect(logo).not.toBeNull();
    expect(logo).toHaveClass('shrink-0');
  });

  it('anchors its popups to the header, not their trigger, while the clusters can wrap', async () => {
    const header = await renderHeader();

    // Each popup is wider than the space between its trigger and the edge it aligns to,
    // so anchoring to the trigger puts part of it off-viewport at narrow widths — the
    // suite dropdown off the right (it is 36rem wide and centred), the right-aligned
    // tenant and profile popups off the left. `static` hands the containing block to the
    // header, whose padding box is the viewport. Each returns to trigger-anchoring at the
    // width where it starts fitting.
    const suiteItem = header.querySelector('nav[aria-label="Main navigation"] li');
    expect(suiteItem).toHaveClass('static', 'lg:relative');
    expect(suiteItem).not.toHaveClass('relative');

    const tenantTrigger = screen.getByRole('button', { name: 'Switch tenant' });
    expect(tenantTrigger.parentElement).toHaveClass('static', 'sm:relative');

    const profileTrigger = screen.getByRole('button', { name: /^Account menu/ });
    expect(profileTrigger.parentElement).toHaveClass('static', 'sm:relative');
  });

  it('keeps the account cluster at the end of whatever row it lands on', async () => {
    const header = await renderHeader();
    const cluster = screen.getByRole('button', { name: 'Switch tenant' }).parentElement
      ?.parentElement;

    // Right-aligned popups are only on-viewport if their trigger is; `justify-between`
    // puts a lone wrapped item at the start of its row, so the margin has to say it.
    expect(cluster).toHaveClass('ms-auto');
    expect(cluster?.parentElement).toBe(header);
  });

  it('still renders every destination — reflow may not cost functionality', async () => {
    await renderHeader();

    // 1.4.10 is "without loss of information or functionality", so nothing may be hidden
    // away at narrow widths in the name of fitting.
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Control Panel' })).toBeInTheDocument();
  });
});
