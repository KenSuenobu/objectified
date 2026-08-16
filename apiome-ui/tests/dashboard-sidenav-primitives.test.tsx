/**
 * Render tests for the "Primitives & types" side-nav entry.
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

const PRIMITIVES_HREF = '/ade/dashboard/primitives';

const withTenant = () => mockUseSession.mockReturnValue({ data: { user: { current_tenant_id: 't-1' } } });
const withoutTenant = () => mockUseSession.mockReturnValue({ data: { user: {} } });

beforeEach(() => {
  mockUsePathname.mockReset();
  mockUseSession.mockReset();
  mockUsePathname.mockReturnValue('/ade/dashboard');
});

describe('DashboardSideNav — Primitives & types entry', () => {
  it('renders under Build and not under Data Management', () => {
    withTenant();
    render(<DashboardSideNav />);

    expect(screen.getByText('Primitives & types')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.queryByText('Data Management')).not.toBeInTheDocument();
  });

  it('links to /ade/dashboard/primitives when a tenant is selected', () => {
    withTenant();
    render(<DashboardSideNav />);

    const link = screen.getByText('Primitives & types').closest('a');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', PRIMITIVES_HREF);
  });

  it('is tenant-gated: with no tenant it is disabled and not a link', () => {
    withoutTenant();
    render(<DashboardSideNav />);

    const item = screen.getByText('Primitives & types').closest('li');
    expect(item).not.toBeNull();
    expect(within(item as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
    expect(item?.querySelector('.cursor-not-allowed')).not.toBeNull();
  });

  it('highlights as active on the primitives route and its children', () => {
    withTenant();
    const { rerender } = render(<DashboardSideNav />);

    let link = screen.getByText('Primitives & types').closest('a');
    expect(link?.className).not.toContain('border-indigo-200');

    mockUsePathname.mockReturnValue(PRIMITIVES_HREF);
    rerender(<DashboardSideNav />);
    link = screen.getByText('Primitives & types').closest('a');
    expect(link?.className).toContain('border-indigo-200');

    mockUsePathname.mockReturnValue(`${PRIMITIVES_HREF}/some-id`);
    rerender(<DashboardSideNav />);
    link = screen.getByText('Primitives & types').closest('a');
    expect(link?.className).toContain('border-indigo-200');
  });
});
