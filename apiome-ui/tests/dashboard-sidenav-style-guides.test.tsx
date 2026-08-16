/**
 * Side-nav Govern group — Style guides entry (GOV-2.1, #4433).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
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

const STYLE_GUIDES_HREF = '/ade/dashboard/style-guides';

const withTenant = () => mockUseSession.mockReturnValue({ data: { user: { current_tenant_id: 't-1' } } });
const withoutTenant = () => mockUseSession.mockReturnValue({ data: { user: {} } });

const activeClass = 'border-indigo-200';

beforeEach(() => {
  mockUsePathname.mockReset();
  mockUseSession.mockReset();
  withTenant();
});

describe('DashboardSideNav — Govern / Style guides', () => {
  it('renders a Govern group with a Style guides entry', () => {
    mockUsePathname.mockReturnValue('/ade/dashboard');
    render(<DashboardSideNav />);

    expect(screen.getByText('Govern')).toBeInTheDocument();
    const link = screen.getByText('Style guides').closest('a');
    expect(link).toHaveAttribute('href', STYLE_GUIDES_HREF);
  });

  it('highlights Style guides on its route', () => {
    mockUsePathname.mockReturnValue(STYLE_GUIDES_HREF);
    render(<DashboardSideNav />);

    const link = screen.getByText('Style guides').closest('a');
    expect(link?.className).toContain(activeClass);
  });

  it('does not highlight Style guides on other routes', () => {
    mockUsePathname.mockReturnValue('/ade/dashboard/projects');
    render(<DashboardSideNav />);

    const link = screen.getByText('Style guides').closest('a');
    expect(link?.className).not.toContain(activeClass);
  });

  it('disables Style guides without a tenant', () => {
    withoutTenant();
    mockUsePathname.mockReturnValue('/ade/dashboard');
    render(<DashboardSideNav />);

    // Disabled items render as a div, not a link.
    expect(screen.getByText('Style guides').closest('a')).toBeNull();
  });
});
