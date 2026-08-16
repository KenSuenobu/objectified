/**
 * Accessibility contract for the shared top header (DH-3.4, apiome/private-suite#2621).
 *
 * The header is the one piece of chrome every Studio and Authoring route renders, so an
 * a11y defect in it is a defect on every route. The RC1 pre-GA validation run
 * (`docs/releases/RC1_EVIDENCE.md` §4.2) found three axe rules failing with identical
 * selectors on all five §31.1 critical authoring routes, and all three were here:
 *
 *   1. `aria-required-children` (critical) — the tenant switcher's popup carried
 *      `role="menu"` while owning the filter field, and a `searchbox` is not a permitted
 *      child of a menu. The Playwright suite left the menu open (its Escape dismissal did
 *      nothing, see 3), so every route scanned it.
 *   2. `button-name` (critical) — the profile menu trigger's only content is a
 *      decorative avatar plus a `hidden` (`display: none`) name, so it reached assistive
 *      technology with no accessible name at all.
 *   3. `color-contrast` (serious) — the disabled "coming soon" nav item used a colour
 *      pair below 4.5:1 in both colour schemes.
 *
 * These tests pin all three, plus the Escape dismissal the menus lacked. Contrast is
 * asserted through `helpers/tailwind-contrast` because jsdom compiles no stylesheet and
 * axe's own `color-contrast` rule therefore cannot run here.
 */
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

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

// The real product catalog, unentitled — so the nav renders exactly what a signed-in
// user sees, including the not-yet-released entry the contrast assertions measure.
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

import {
  enrichedTenantContext,
  findEnabledTenantTrigger,
  openTenantSwitcher,
  renderTopHeader,
} from './helpers/top-header-fixture';
import {
  textColorToken,
  tokenContrastRatio,
  WCAG_AA_NORMAL_TEXT_MIN,
} from './helpers/tailwind-contrast';

/**
 * The WCAG 2.2 A/AA rule set the release gate runs, so a violation caught here is
 * exactly a violation that would block the Playwright conformance suite
 * (`designer/tests/e2e/authoring-a11y.spec.ts`, UXE-1.4).
 */
const WCAG_22_AA = {
  runOnly: {
    type: 'tag' as const,
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  },
  rules: {
    // jsdom loads no stylesheet and implements no canvas, so this rule can neither
    // measure a colour nor complete — the `colour contrast` block below asserts the
    // same criterion against the compiled Tailwind palette instead.
    'color-contrast': { enabled: false },
  },
};

/** Background the header itself paints, per colour scheme. */
const HEADER_BACKGROUND = { light: 'white', dark: 'slate-900' } as const;

/** Background the switcher popup paints, per colour scheme. */
const MENU_BACKGROUND = { light: 'white', dark: 'slate-800' } as const;

/** Background of the profile menu's theme-value chip, which paints its own. */
const THEME_CHIP_BACKGROUND = { light: 'gray-100', dark: 'gray-700' } as const;

/**
 * Assert an element's resting text colour clears AA against a surface, in both schemes.
 *
 * @param element - The element whose class list picks the colours.
 * @param backgrounds - Surface token behind it, per colour scheme.
 */
function expectReadableOnBoth(
  element: HTMLElement,
  backgrounds: { light: string; dark: string }
): void {
  const measured = (['light', 'dark'] as const).map((scheme) => {
    const token = textColorToken(element.className, scheme);
    return {
      scheme,
      on: backgrounds[scheme],
      token: token ?? '(none set)',
      // An element that sets no colour for a scheme inherits an unknown one, which is a
      // finding in its own right — score it 0 so it lands in the failure list.
      ratio: token ? Number(tokenContrastRatio(token, backgrounds[scheme]).toFixed(2)) : 0,
    };
  });

  // Asserting on the failures (rather than per scheme) puts the offending token, surface
  // and measured ratio straight into the diff.
  expect(measured.filter((m) => m.ratio < WCAG_AA_NORMAL_TEXT_MIN)).toEqual([]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TopHeader accessibility (DH-3.4)', () => {
  it('has no WCAG 2.2 A/AA violations at rest', async () => {
    const { view } = renderTopHeader(enrichedTenantContext());
    await findEnabledTenantTrigger();

    expect(await axe(view.container, WCAG_22_AA)).toHaveNoViolations();
  });

  it('gives the profile menu trigger an accessible name', async () => {
    renderTopHeader(enrichedTenantContext());

    const trigger = await screen.findByRole('button', { name: 'Account menu for Kenji' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('names the profile menu trigger even when the session carries no name', async () => {
    renderTopHeader(enrichedTenantContext(), jest.fn(async () => null), {
      user: { user_id: 'user-1', email: 'kenji@example.com' },
    } as never);

    expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('has no violations with the tenant switcher open', async () => {
    const user = userEvent.setup();
    const { view } = renderTopHeader(enrichedTenantContext());
    await openTenantSwitcher(user);

    expect(await axe(view.container, WCAG_22_AA)).toHaveNoViolations();
  });

  it('keeps the filter field outside the menu it filters', async () => {
    const user = userEvent.setup();
    renderTopHeader(enrichedTenantContext());
    const menu = await openTenantSwitcher(user);

    const filter = screen.getByRole('searchbox', { name: 'Filter tenants' });
    expect(menu).not.toContainElement(filter);
    // Every menu item is still owned by the menu, through its presentational wrappers.
    for (const item of screen.getAllByRole('menuitem')) {
      expect(menu).toContainElement(item);
    }
  });

  it('has no violations with the profile menu open', async () => {
    const user = userEvent.setup();
    const { view } = renderTopHeader(enrichedTenantContext());
    await user.click(await screen.findByRole('button', { name: 'Account menu for Kenji' }));

    expect(screen.getByRole('menu', { name: 'Profile menu' })).toBeInTheDocument();
    expect(await axe(view.container, WCAG_22_AA)).toHaveNoViolations();
  });

  it('renders no empty menu when the filter matches nothing', async () => {
    const user = userEvent.setup();
    const { view } = renderTopHeader(enrichedTenantContext({ createTenant: null }));
    await openTenantSwitcher(user);

    await user.type(screen.getByRole('searchbox', { name: 'Filter tenants' }), 'zzz');

    expect(screen.getByText('No matching tenants')).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'Your tenants' })).not.toBeInTheDocument();
    expect(await axe(view.container, WCAG_22_AA)).toHaveNoViolations();
  });

  it('keeps the menu when only the create-tenant entry survives the filter', async () => {
    const user = userEvent.setup();
    renderTopHeader(enrichedTenantContext());
    await openTenantSwitcher(user);

    await user.type(screen.getByRole('searchbox', { name: 'Filter tenants' }), 'zzz');

    const menu = screen.getByRole('menu', { name: 'Your tenants' });
    expect(menu).toContainElement(screen.getByTestId('create-tenant-entry'));
  });

  it('closes the tenant switcher on Escape and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    renderTopHeader(enrichedTenantContext());
    const trigger = await findEnabledTenantTrigger();
    await user.click(trigger);

    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Your tenants' })).not.toBeInTheDocument()
    );
    expect(trigger).toHaveFocus();
  });

  it('closes the tenant switcher on Escape typed inside the filter field', async () => {
    const user = userEvent.setup();
    renderTopHeader(enrichedTenantContext());
    const trigger = await findEnabledTenantTrigger();
    await user.click(trigger);

    const filter = screen.getByRole('searchbox', { name: 'Filter tenants' });
    await user.click(filter);
    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Your tenants' })).not.toBeInTheDocument()
    );
    expect(trigger).toHaveFocus();
  });

  it('closes the profile menu on Escape and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    renderTopHeader(enrichedTenantContext());
    const trigger = await screen.findByRole('button', { name: 'Account menu for Kenji' });
    await user.click(trigger);

    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()
    );
    expect(trigger).toHaveFocus();
  });

  describe('colour contrast (WCAG 2.2 AA 1.4.3)', () => {
    it('keeps the disabled "coming soon" nav item readable in both schemes', async () => {
      renderTopHeader(enrichedTenantContext());
      await findEnabledTenantTrigger();

      // The built-in catalog ships at least one not-yet-released product, which the nav
      // renders shaded rather than linked; there is no role to query it by.
      const comingSoon = document.querySelector<HTMLElement>('[title="Coming soon"]');
      expect(comingSoon).not.toBeNull();
      expectReadableOnBoth(comingSoon!, HEADER_BACKGROUND);
    });

    it('keeps a suspended membership row readable in both schemes', async () => {
      const user = userEvent.setup();
      renderTopHeader(enrichedTenantContext());
      await openTenantSwitcher(user);

      expectReadableOnBoth(screen.getByRole('menuitem', { name: /initech/ }), MENU_BACKGROUND);
    });

    it('keeps the profile menu’s theme chip readable in both schemes', async () => {
      const user = userEvent.setup();
      renderTopHeader(enrichedTenantContext());
      await user.click(await screen.findByRole('button', { name: 'Account menu for Kenji' }));

      expectReadableOnBoth(screen.getByTestId('theme-menu-value'), THEME_CHIP_BACKGROUND);
    });

    it('keeps the create-tenant entry readable when the cap disables it', async () => {
      const user = userEvent.setup();
      renderTopHeader(enrichedTenantContext({ createTenant: { allowed: false, used: 1, max: 1 } }));
      await openTenantSwitcher(user);

      expectReadableOnBoth(screen.getByTestId('create-tenant-entry'), MENU_BACKGROUND);
    });
  });
});
