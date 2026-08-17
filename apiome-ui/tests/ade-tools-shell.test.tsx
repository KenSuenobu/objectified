/**
 * Tools renders inside the one chrome (HIVE-3.8, #5294).
 *
 * `/ade/database` and `/ade/migration` were the last two `/ade` routes still drawing the
 * pre-Hive `TopHeader`: a 48px bar, with each tool's own toolbar `position: fixed` at
 * `top: 48` beneath it and the page column sized `calc(100vh - 48px)` to match. #5294 retired
 * that header, and its acceptance criterion is explicit — *"`/ade` (launcher) still renders
 * without a rail; every other `/ade/**` route renders with one"*. So Tools joins the shell.
 *
 * Two things are asserted, because the layout change has two halves. The rail is a *render*
 * question and is driven here. Whether the toolbars are still fixed is not — jsdom applies no
 * stylesheet and the values are inline — so that half is read from the source, which is also
 * where a regression would be written.
 *
 * The tools' own internals are stubbed. `DatabaseHeader`, `TablesSidebar` and their migration
 * counterparts are version-scoped page furniture that fetch on mount; they survive the
 * retirement untouched (the issue keeps `components/sidebar/*` for Tools until 9.1), and none
 * of them is what this suite is about.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_ROOT = join(__dirname, '..');

// The layouts pull the global stylesheet in for their route segment. ts-jest cannot parse
// CSS, and apiome-ui's jest maps only `*.module.css` — deliberately, because
// `tests/helpers/tailwind-contrast.ts` reads the real `tailwindcss/theme.css` as data.
jest.mock('../src/app/globals.css', () => ({}), { virtual: true });

const mockUsePathname = jest.fn<string, []>();

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock('@lib/auth/session-client', () => ({
  AuthSessionProvider: ({ children }: { children: unknown }) => children,
  signOut: jest.fn(),
  useAuthSession: () => ({
    data: { user: { user_id: 'user-1', name: 'Ada', email: 'ada@example.com', current_tenant_id: 'tenant-1' } },
  }),
}));

jest.mock('@lib/db/commercial-access', () => ({
  getCommercialAccessForSession: jest.fn(async () => ({ navItems: [] })),
}));

jest.mock('@lib/auth/tenant-membership-context', () => ({
  loadTenantMembershipContext: jest.fn(async () => ({
    tenants: [{ id: 'tenant-1', name: 'Acme', role: 'admin' }],
    adminTenantIds: ['tenant-1'],
    createTenant: null,
  })),
}));

jest.mock('@lib/auth/sign-out-client', () => ({ signOutEverywhere: jest.fn() }));

jest.mock('@lib/auth/last-active-tenant-actions', () => ({
  persistLastActiveTenant: jest.fn(async () => undefined),
}));

jest.mock('@/app/components/ade/CreateTenantDialog', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('next-themes', () => ({ useTheme: () => ({ setTheme: jest.fn() }) }));

// The data browser's own furniture: a version-scoped toolbar and tables list.
jest.mock('../src/app/ade/database/DatabaseContext', () => ({
  DatabaseProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDatabase: () => ({ selectedProjectId: 'project-1', selectedVersionId: 'version-1' }),
}));
jest.mock('../src/app/ade/database/components/DatabaseHeader', () => ({
  __esModule: true,
  default: () => <div data-testid="database-toolbar" />,
}));
jest.mock('../src/app/ade/database/components/TablesSidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="tables-sidebar" />,
}));

// And the migration tool's.
jest.mock('../src/app/ade/migration/MigrationContext', () => ({
  MigrationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMigration: () => ({ fromVersionId: 'version-1', toVersionId: 'version-2' }),
}));
jest.mock('../src/app/ade/migration/components/MigrationHeader', () => ({
  __esModule: true,
  default: () => <div data-testid="migration-toolbar" />,
}));
jest.mock('../src/app/ade/migration/components/MigrationSidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="migration-sidebar" />,
}));

import DatabaseLayout from '../src/app/ade/database/layout';
import MigrationLayout from '../src/app/ade/migration/layout';

/**
 * Install the `matchMedia` jsdom lacks; the rail asks it whether it is icon-only.
 */
function mockMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMatchMedia();
  window.localStorage.clear();
});

describe('Tools routes render inside AppShell', () => {
  it('gives /ade/database the rail, around its own furniture', async () => {
    mockUsePathname.mockReturnValue('/ade/database');

    render(
      <DatabaseLayout>
        <div data-testid="database-page" />
      </DatabaseLayout>
    );

    await waitFor(() => expect(screen.getByTestId('app-rail')).toBeInTheDocument());
    expect(screen.getByTestId('database-page')).toBeInTheDocument();
    // The tool keeps its own toolbar and tables list; the rail is *added*, not swapped in.
    expect(screen.getByTestId('database-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('tables-sidebar')).toBeInTheDocument();
  });

  it('gives /ade/migration the rail, around its own furniture', async () => {
    mockUsePathname.mockReturnValue('/ade/migration');

    render(
      <MigrationLayout>
        <div data-testid="migration-page" />
      </MigrationLayout>
    );

    await waitFor(() => expect(screen.getByTestId('app-rail')).toBeInTheDocument());
    expect(screen.getByTestId('migration-page')).toBeInTheDocument();
    expect(screen.getByTestId('migration-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('migration-sidebar')).toBeInTheDocument();
  });

  it('puts the page inside the shell’s main region, not beside it', async () => {
    mockUsePathname.mockReturnValue('/ade/database');

    render(
      <DatabaseLayout>
        <div data-testid="database-page" />
      </DatabaseLayout>
    );

    await waitFor(() => expect(screen.getByTestId('app-rail')).toBeInTheDocument());
    // `#main-content` is the shell's skip-link target. A page rendered as a sibling of the
    // rail rather than a descendant of main would still "have a rail" and be wrong.
    const main = document.getElementById('main-content');
    expect(main).not.toBeNull();
    expect(main).toContainElement(screen.getByTestId('database-page'));
  });
});

describe('the Tools toolbars are in normal flow', () => {
  // Read rather than rendered: the positioning is inline style, and jsdom composites nothing.
  it.each([
    ['database', 'src/app/ade/database/components/DatabaseHeader.tsx'],
    ['migration', 'src/app/ade/migration/components/MigrationHeader.tsx'],
  ])('the %s toolbar is not fixed to the viewport', (_tool, file) => {
    const code = readFileSync(join(APP_ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    expect(code).not.toMatch(/position:\s*['"]fixed['"]/);
  });

  it.each([
    ['database', 'src/app/ade/database/layout.tsx'],
    ['migration', 'src/app/ade/migration/layout.tsx'],
  ])('the %s layout reserves no space for a bar above it', (_tool, file) => {
    const code = readFileSync(join(APP_ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    expect(code).not.toMatch(/marginTop/);
    expect(code).not.toMatch(/100vh/);
  });
});
