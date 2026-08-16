/**
 * Where the shell is in force, and what that means for the old chrome (HIVE-3.1, #5287).
 *
 * "Exactly one chrome renders on `/ade/**`" is the ticket's first acceptance criterion, and
 * it is a claim about two components at once: the rail draws itself on the dashboard, and
 * `ConditionalHeader` must draw nothing there. One module answers for both
 * (`components/shell/appShellRoutes`), so the header cannot fall out of step with the
 * layouts as the remaining surfaces migrate (HIVE-3.8, #5294, retires it entirely).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockUsePathname = jest.fn<string, []>();

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

// The header itself is 800 lines of session, tenant and menu plumbing that this suite is
// not about: all that matters is whether it is asked to render at all.
jest.mock('../src/app/components/ade/TopHeader', () => ({
  __esModule: true,
  default: () => <header data-testid="top-header">legacy chrome</header>,
}));

import ConditionalHeader from '../src/app/components/ade/ConditionalHeader';
import {
  APP_SHELL_ROUTE_PREFIXES,
  LAUNCHER_ROUTE,
  isAppShellRoute,
  suppressesTopHeader,
} from '../src/app/components/shell/appShellRoutes';

/** Routes inside the shell — the prefix itself and a page below it. */
const SHELL_ROUTES = APP_SHELL_ROUTE_PREFIXES.flatMap((prefix) => [
  prefix,
  `${prefix}/projects`,
  `${prefix}/versions/sunset-timeline`,
]);

/** Routes that still draw the legacy header: Tools, and the commercial studio surface. */
const HEADER_ROUTES = ['/ade/database', '/ade/database/tables', '/ade/migration', '/ade/studio'];

beforeEach(() => {
  mockUsePathname.mockReset();
});

describe('isAppShellRoute', () => {
  it.each(SHELL_ROUTES)('claims %s', (pathname) => {
    expect(isAppShellRoute(pathname)).toBe(true);
  });

  it.each([...HEADER_ROUTES, LAUNCHER_ROUTE, '/login', '/admin'])('leaves %s alone', (pathname) => {
    expect(isAppShellRoute(pathname)).toBe(false);
  });

  it('does not mistake a sibling route for a descendant', () => {
    expect(isAppShellRoute('/ade/dashboards')).toBe(false);
  });

  it('answers false before a pathname is known', () => {
    expect(isAppShellRoute(null)).toBe(false);
    expect(isAppShellRoute(undefined)).toBe(false);
  });
});

describe('suppressesTopHeader', () => {
  it('covers the launcher as well as the shell', () => {
    expect(suppressesTopHeader(LAUNCHER_ROUTE)).toBe(true);
    for (const pathname of SHELL_ROUTES) expect(suppressesTopHeader(pathname)).toBe(true);
  });

  it('leaves the surfaces that have not migrated with their header', () => {
    for (const pathname of HEADER_ROUTES) expect(suppressesTopHeader(pathname)).toBe(false);
  });
});

describe('ConditionalHeader', () => {
  it.each(SHELL_ROUTES)('renders no second chrome on %s', (pathname) => {
    mockUsePathname.mockReturnValue(pathname);

    const { container } = render(<ConditionalHeader />);

    expect(screen.queryByTestId('top-header')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on the launcher, as it always has', () => {
    mockUsePathname.mockReturnValue(LAUNCHER_ROUTE);
    render(<ConditionalHeader />);

    expect(screen.queryByTestId('top-header')).not.toBeInTheDocument();
  });

  it.each(HEADER_ROUTES)('still renders on %s, which has no rail yet', (pathname) => {
    mockUsePathname.mockReturnValue(pathname);
    render(<ConditionalHeader />);

    expect(screen.getByTestId('top-header')).toBeInTheDocument();
  });
});
