/**
 * Integration tests for the header tenant switcher (OLO-6.1, #4218).
 *
 * Pin the acceptance criteria: memberships render with per-tenant role badges
 * and license tier chips (from the OLO-6.2 enriched listing), selecting a
 * tenant updates the session without a full reload (session update +
 * router.refresh) and persists the last-active tenant, suspended memberships
 * cannot be activated, and the "Create tenant" entry is cap-aware (enabled
 * under the cap, disabled with upgrade copy at it, hidden for legacy contexts
 * that carry no gate).
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const mockUsePathname = jest.fn<string, []>(() => '/ade/dashboard/projects');
const mockRouterRefresh = jest.fn();
const mockPersistLastActiveTenant = jest.fn<Promise<void>, [string]>(async () => undefined);

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ refresh: mockRouterRefresh, push: jest.fn() }),
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

jest.mock('@/app/components/ade/ThemeSelector', () => ({
  __esModule: true,
  default: () => null,
}));

// The dialog itself is covered by create-tenant-dialog.test.tsx; here a stub
// records that it opened and lets tests drive the created-tenant callback.
jest.mock('@/app/components/ade/CreateTenantDialog', () => ({
  __esModule: true,
  default: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (tenant: { id: string; name: string; slug: string }) => void;
  }) =>
    open ? (
      <div data-testid="create-tenant-dialog-stub">
        <button
          type="button"
          onClick={() => onCreated({ id: 'tenant-new', name: 'New Tenant', slug: 'new-tenant' })}
        >
          finish-create
        </button>
      </div>
    ) : null,
}));

jest.mock('@lib/db/commercial-access', () => ({
  getCommercialAccessForSession: jest.fn(async () => ({ navItems: [] })),
}));

// The default context loader is a server action; TopHeader tests always inject
// loadTenantContext, so the module is stubbed to keep DB imports out of jsdom.
jest.mock('@lib/auth/tenant-membership-context', () => ({
  loadTenantMembershipContext: jest.fn(async () => ({
    tenants: [],
    adminTenantIds: [],
    createTenant: null,
  })),
}));

jest.mock('@lib/auth/last-active-tenant-actions', () => ({
  persistLastActiveTenant: (tenantId: string) => mockPersistLastActiveTenant(tenantId),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import TopHeader, { type TopHeaderTenantContext } from '../src/app/components/ade/TopHeader';
import type { AppSession } from '@lib/auth/better-auth-session-shape';

const CURRENT_TENANT_ID = 'tenant-acme';

const session = {
  user: {
    user_id: 'user-1',
    name: 'Kenji',
    email: 'kenji@example.com',
    current_tenant_id: CURRENT_TENANT_ID,
  },
} as unknown as AppSession;

/** Enriched three-tenant context matching the issue's mockup. */
function enrichedContext(overrides: Partial<TopHeaderTenantContext> = {}): TopHeaderTenantContext {
  return {
    tenants: [
      {
        id: CURRENT_TENANT_ID,
        name: 'acme-corp',
        slug: 'acme-corp',
        role: 'owner',
        status: 'active',
        licenseName: 'Free',
        licenseType: 'free',
      },
      {
        id: 'tenant-globex',
        name: 'globex',
        slug: 'globex',
        role: 'editor',
        status: 'active',
        licenseName: 'Paid',
        licenseType: 'paid',
      },
      {
        id: 'tenant-initech',
        name: 'initech',
        slug: 'initech',
        role: 'viewer',
        status: 'suspended',
        licenseName: 'Free',
        licenseType: 'free',
      },
    ],
    adminTenantIds: new Set([CURRENT_TENANT_ID]),
    createTenant: { allowed: true, used: 3, max: 5 },
    ...overrides,
  };
}

/** Renders the header with an injected session and tenant context. */
function renderHeader(context: TopHeaderTenantContext, update = jest.fn(async () => null)) {
  const loadTenantContext = jest.fn(async () => context);
  const view = render(
    <TopHeader
      loadTenantContext={loadTenantContext}
      sessionBridge={{ session, update: update as never }}
    />
  );
  return { view, update, loadTenantContext };
}

/** Opens the switcher menu once tenants finish loading. */
async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole('button', { name: 'Switch tenant' });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  return screen.getByRole('menu', { name: 'Your tenants' });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TopHeader tenant switcher (OLO-6.1)', () => {
  it('renders role badges and license tier chips per membership', async () => {
    const user = userEvent.setup();
    renderHeader(enrichedContext());
    await openSwitcher(user);

    const badges = screen.getAllByTestId('tenant-role-badge');
    expect(badges.map((badge) => badge.textContent)).toEqual(['owner', 'editor', 'viewer']);

    const chips = screen.getAllByTestId('tenant-license-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(['· Free', '· Paid', '· Free']);
  });

  it('switches tenant via session update, persists last-active, and refreshes', async () => {
    const user = userEvent.setup();
    const { update } = renderHeader(enrichedContext());
    await openSwitcher(user);

    await user.click(screen.getByRole('menuitem', { name: /globex/ }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ current_tenant_id: 'tenant-globex' })
    );
    await waitFor(() =>
      expect(mockPersistLastActiveTenant).toHaveBeenCalledWith('tenant-globex')
    );
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it('disables a suspended membership instead of offering the switch', async () => {
    const user = userEvent.setup();
    const { update } = renderHeader(enrichedContext());
    await openSwitcher(user);

    const suspendedRow = screen.getByRole('menuitem', { name: /initech/ });
    expect(suspendedRow).toBeDisabled();
    expect(suspendedRow).toHaveAttribute(
      'title',
      'Your membership in this tenant is suspended'
    );
    await user.click(suspendedRow);
    expect(update).not.toHaveBeenCalled();
  });

  it('offers Create tenant when under the cap and opens the dialog', async () => {
    const user = userEvent.setup();
    renderHeader(enrichedContext());
    await openSwitcher(user);

    const entry = screen.getByTestId('create-tenant-entry');
    expect(entry).toBeEnabled();
    await user.click(entry);
    expect(screen.getByTestId('create-tenant-dialog-stub')).toBeInTheDocument();
  });

  it('activates a newly created tenant in the session', async () => {
    const user = userEvent.setup();
    const { update } = renderHeader(enrichedContext());
    await openSwitcher(user);
    await user.click(screen.getByTestId('create-tenant-entry'));

    await user.click(screen.getByRole('button', { name: 'finish-create' }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ current_tenant_id: 'tenant-new' })
    );
    await waitFor(() =>
      expect(mockPersistLastActiveTenant).toHaveBeenCalledWith('tenant-new')
    );
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it('disables Create tenant with cap-aware copy at the limit', async () => {
    const user = userEvent.setup();
    renderHeader(enrichedContext({ createTenant: { allowed: false, used: 1, max: 1 } }));
    await openSwitcher(user);

    const entry = screen.getByTestId('create-tenant-entry');
    expect(entry).toBeDisabled();
    expect(entry).toHaveAttribute(
      'title',
      'Tenant limit reached (1 of 1 used) — upgrade your plan to create more'
    );
  });

  it('hides Create tenant when the context carries no gate (legacy/studio)', async () => {
    const user = userEvent.setup();
    renderHeader(enrichedContext({ createTenant: null }));
    await openSwitcher(user);
    expect(screen.queryByTestId('create-tenant-entry')).not.toBeInTheDocument();
  });

  it('falls back to the legacy Admin badge for name-only rows', async () => {
    const user = userEvent.setup();
    renderHeader({
      tenants: [
        { id: CURRENT_TENANT_ID, name: 'acme-corp' },
        { id: 'tenant-globex', name: 'globex' },
      ],
      adminTenantIds: new Set([CURRENT_TENANT_ID]),
      createTenant: null,
    });
    await openSwitcher(user);

    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.queryAllByTestId('tenant-role-badge')).toHaveLength(0);
    expect(screen.queryAllByTestId('tenant-license-chip')).toHaveLength(0);
  });

  it('filters tenants by slug as well as name', async () => {
    const user = userEvent.setup();
    renderHeader(enrichedContext());
    await openSwitcher(user);

    await user.type(screen.getByRole('searchbox', { name: 'Filter tenants' }), 'glob');
    expect(screen.getByRole('menuitem', { name: /globex/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /initech/ })).not.toBeInTheDocument();
  });
});
