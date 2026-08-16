/**
 * Render tests for the "Catalog" side-nav entry (MFI-23.6, #4015).
 *
 * These pin the acceptance criteria: the Catalog entry appears in the
 * Bring in group, links to `/ade/dashboard/catalog`, is tenant-gated
 * like Projects (rendered as a disabled, non-navigable element with no tenant),
 * carries no "Preview" pill, and highlights as active on its own routes.
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

// next/link renders a plain anchor in the test DOM.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import DashboardSideNav from '../src/app/components/ade/dashboard/DashboardSideNav';

const CATALOG_HREF = '/ade/dashboard/catalog';

const withTenant = () => mockUseSession.mockReturnValue({ data: { user: { current_tenant_id: 't-1' } } });
const withoutTenant = () => mockUseSession.mockReturnValue({ data: { user: {} } });

beforeEach(() => {
  mockUsePathname.mockReset();
  mockUseSession.mockReset();
  mockUsePathname.mockReturnValue('/ade/dashboard');
});

describe('DashboardSideNav — Catalog entry (MFI-23.6)', () => {
  it('renders a Catalog entry in the Bring in group with no Preview pill', () => {
    withTenant();
    render(<DashboardSideNav />);

    const catalog = screen.getByText('Catalog');
    expect(catalog).toBeInTheDocument();

    // The "Bring in" heading and the Catalog entry coexist.
    expect(screen.getByText('Bring in')).toBeInTheDocument();

    // Catalog is out of preview — no pill rides alongside the label.
    const item = catalog.closest('li');
    expect(item).not.toBeNull();
    expect(within(item as HTMLElement).queryByText('Preview')).not.toBeInTheDocument();
  });

  it('links to /ade/dashboard/catalog when a tenant is selected', () => {
    withTenant();
    render(<DashboardSideNav />);

    const link = screen.getByText('Catalog').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', CATALOG_HREF);
  });

  it('is tenant-gated: with no tenant it is disabled and not a link', () => {
    withoutTenant();
    render(<DashboardSideNav />);

    const item = screen.getByText('Catalog').closest('li');
    expect(item).not.toBeNull();
    // No anchor when disabled — mirrors Projects' tenant gating.
    expect(within(item as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
    expect(item?.querySelector('.cursor-not-allowed')).not.toBeNull();
  });

  it('highlights as active on the catalog route and its children', () => {
    withTenant();
    const { rerender } = render(<DashboardSideNav />);

    // `border-indigo-200` is applied only to the active entry (the
    // `hover:bg-indigo-500/10` base class would falsely match a tone check).
    let link = screen.getByText('Catalog').closest('a');
    expect(link?.className).not.toContain('border-indigo-200');

    mockUsePathname.mockReturnValue(CATALOG_HREF);
    rerender(<DashboardSideNav />);
    link = screen.getByText('Catalog').closest('a');
    expect(link?.className).toContain('border-indigo-200');

    mockUsePathname.mockReturnValue(`${CATALOG_HREF}/some-item`);
    rerender(<DashboardSideNav />);
    link = screen.getByText('Catalog').closest('a');
    expect(link?.className).toContain('border-indigo-200');
  });
});
