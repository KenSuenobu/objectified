/**
 * The sidebar renders from the navigation model (HIVE-3.2, #5288).
 *
 * The acceptance criterion is "no component hard-codes a nav item", which is
 * only really provable from the outside: drive the model, and assert the DOM
 * follows. Every expectation below is derived from `lib/platform-nav.ts` rather
 * than written out, so a destination added to the model without a matching
 * sidebar entry — or a label typed into the component — fails here.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockUsePathname = jest.fn<string, []>();
const mockUseSession = jest.fn<{ data: unknown }, []>();

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

jest.mock('@lib/auth/session-client', () => ({
  AuthSessionProvider: ({ children }: { children: unknown }) => children,
  signOut: jest.fn(),
  useAuthSession: () => mockUseSession(),
}));

jest.mock('@/app/hooks/useDarkMode', () => ({
  useDarkMode: () => false,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import DashboardSideNav from '../src/app/components/ade/dashboard/DashboardSideNav';
import {
  PLATFORM_NAV_GROUPS,
  PLATFORM_USER_MENU_ITEMS,
  platformNavGatedReason,
  type PlatformNavItem,
} from '../lib/platform-nav';

/** Every destination the sidebar is expected to render, in model order. */
const ALL_ITEMS: PlatformNavItem[] = [
  ...PLATFORM_NAV_GROUPS.flatMap((group) => group.items),
  ...PLATFORM_USER_MENU_ITEMS,
];

/** Headings the model asks for, in model order. */
const GROUP_LABELS = PLATFORM_NAV_GROUPS.map((group) => group.label).filter(
  (label): label is string => Boolean(label)
);

const withTenant = () =>
  mockUseSession.mockReturnValue({ data: { user: { current_tenant_id: 't-1' } } });
const withoutTenant = () => mockUseSession.mockReturnValue({ data: { user: {} } });

beforeEach(() => {
  mockUsePathname.mockReset();
  mockUseSession.mockReset();
  mockUsePathname.mockReturnValue('/ade/dashboard');
});

describe('DashboardSideNav — rendered from the navigation model', () => {
  it('renders every modelled destination, once, with its href', () => {
    withTenant();
    render(<DashboardSideNav />);

    for (const navItem of ALL_ITEMS) {
      const label = screen.getByText(navItem.label);
      expect(label.closest('a')).toHaveAttribute('href', navItem.href);
    }

    // Nothing beyond the model (plus the Preferences button) is in the list.
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href')).sort()).toEqual(
      ALL_ITEMS.map((navItem) => navItem.href).sort()
    );
  });

  it('renders the model group headings, and none of the pre-Hive ones', () => {
    withTenant();
    render(<DashboardSideNav />);

    for (const label of GROUP_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const retired of ['Administration', 'Access & IAM', 'Specifications', 'Governance']) {
      expect(screen.queryByText(retired)).not.toBeInTheDocument();
    }
  });

  it('renders the Preview pill only where the model asks for one', () => {
    withTenant();
    render(<DashboardSideNav />);

    for (const navItem of ALL_ITEMS) {
      const row = screen.getByText(navItem.label).closest('li') as HTMLElement;
      if (navItem.pill) {
        expect(within(row).getByText(navItem.pill)).toBeInTheDocument();
      } else {
        expect(within(row).queryByText('Preview')).not.toBeInTheDocument();
      }
    }
  });

  it('gates exactly the workspace-scoped destinations, and explains why', () => {
    withoutTenant();
    render(<DashboardSideNav />);

    for (const navItem of ALL_ITEMS) {
      const row = screen.getByText(navItem.label).closest('li') as HTMLElement;
      if (navItem.requiresTenant) {
        expect(within(row).queryByRole('link')).not.toBeInTheDocument();
        const gated = row.querySelector('[aria-disabled="true"]');
        expect(gated).not.toBeNull();
        expect(gated).toHaveAttribute('title', platformNavGatedReason(navItem.label));
      } else {
        expect(within(row).getByRole('link')).toHaveAttribute('href', navItem.href);
      }
    }
  });

  it('marks the current destination with aria-current', () => {
    withTenant();
    mockUsePathname.mockReturnValue('/ade/dashboard/catalog/c-1');
    render(<DashboardSideNav />);

    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current'));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/ade/dashboard/catalog');
    expect(current[0]).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the preferences button beneath the modelled destinations', () => {
    withTenant();
    render(<DashboardSideNav />);

    expect(screen.getByTestId('sidenav-preferences')).toBeInTheDocument();
  });
});
