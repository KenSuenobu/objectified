/**
 * The rail's workspace switcher (HIVE-3.3, #5289).
 *
 * The ticket is a *move*: every capability the header's tenant pill had — filter over name
 * and slug, role badges, licence chips, suspended memberships, the check on the current
 * workspace, the plan-capped create entry, and the session/cookie/refresh a switch performs
 * — has to survive the journey into the rail. So this suite is written the way the header's
 * own switcher suite is (`top-header-tenant-switcher.test.tsx`): the same three-membership
 * fixture, driven through the real component with `userEvent`, one test per capability.
 *
 * On top of the port, the two things the rail adds: a `role="menu"` walked with the arrow
 * keys, and a row that works with its labels taken away by CSS.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

const mockRouterRefresh = jest.fn();
const mockPersistLastActiveTenant = jest.fn<Promise<void>, [string]>(async () => undefined);
const mockUpdate = jest.fn<Promise<void>, [unknown]>(async () => undefined);
const mockUseSession = jest.fn<{ data: unknown; update: unknown }, []>();

jest.mock('next/navigation', () => ({
  usePathname: () => '/ade/dashboard',
  useRouter: () => ({ refresh: mockRouterRefresh, push: jest.fn() }),
}));

jest.mock('@lib/auth/session-client', () => ({
  AuthSessionProvider: ({ children }: { children: unknown }) => children,
  useAuthSession: () => mockUseSession(),
}));

// The default loader is a server action; every test injects `loadContext`, so the module is
// stubbed to keep the DB imports out of jsdom.
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

// The dialog has its own suite (`create-tenant-dialog.test.tsx`); here a stub records that
// it opened and lets a test drive the created-workspace callback.
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
          onClick={() => onCreated({ id: 't-new', name: 'New Workspace', slug: 'new-workspace' })}
        >
          finish-create
        </button>
      </div>
    ) : null,
}));

import WorkspaceSwitcher, {
  formatWorkspaceMeta,
} from '../src/app/components/shell/WorkspaceSwitcher';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import type { TenantMembershipContextPayload } from '../lib/auth/tenant-membership-context';

/** The workspace the fixture session is already in. */
const CURRENT_ID = 't-acme';

/**
 * Three memberships: the active one, a switchable one, and a suspended one — a row of every
 * state the switcher draws differently, each with its own role and licence tier.
 *
 * @param overrides Fields to replace, e.g. a different create gate.
 * @returns The payload an injected loader resolves to.
 */
function membershipContext(
  overrides: Partial<TenantMembershipContextPayload> = {}
): TenantMembershipContextPayload {
  return {
    tenants: [
      {
        id: CURRENT_ID,
        name: 'Acme Corp',
        slug: 'acme-corp',
        role: 'owner',
        status: 'active',
        licenseName: 'Free',
        licenseType: 'free',
      },
      {
        id: 't-globex',
        name: 'Globex Labs',
        slug: 'globex',
        role: 'editor',
        status: 'active',
        licenseName: 'Team',
        licenseType: 'paid',
      },
      {
        id: 't-initech',
        name: 'Initech',
        slug: 'initech',
        role: 'viewer',
        status: 'suspended',
        licenseName: 'Free',
        licenseType: 'free',
      },
    ],
    adminTenantIds: [CURRENT_ID],
    createTenant: { allowed: true, used: 3, max: 5 },
    ...overrides,
  };
}

/** Options for {@link renderSwitcher}. */
interface RenderOptions {
  /** Membership payload the injected loader resolves to. */
  context?: TenantMembershipContextPayload;
  /** Make the loader reject, to check the switcher degrades rather than breaks. */
  fail?: boolean;
  /** Whether the rail is drawing icon-only. */
  iconRail?: boolean;
  /** Workspace the session is active in; `null` for a signed-in user who has none. */
  tenantId?: string | null;
}

/**
 * Mount the switcher over a mocked session and let its loader settle.
 *
 * @param options See {@link RenderOptions}.
 * @returns The render result, the injected loader and the `onTenantSelected` spy.
 */
async function renderSwitcher({
  context = membershipContext(),
  fail = false,
  iconRail = false,
  tenantId = CURRENT_ID,
}: RenderOptions = {}) {
  mockUseSession.mockReturnValue({
    data: {
      user: { user_id: 'u-1', name: 'Ada Lovelace', current_tenant_id: tenantId ?? undefined },
    },
    update: mockUpdate,
  });
  const loadContext = fail
    ? jest.fn(async () => {
        throw new Error('offline');
      })
    : jest.fn(async () => context);
  const onTenantSelected = jest.fn();

  const view = render(
    <TooltipProvider delayDuration={0}>
      <WorkspaceSwitcher
        iconRail={iconRail}
        loadContext={loadContext as never}
        onTenantSelected={onTenantSelected}
      />
    </TooltipProvider>
  );

  // The row stops advertising a first load once the memberships have arrived.
  await waitFor(() => expect(screen.getByTestId('rail-workspace')).toBeEnabled());
  return { view, loadContext, onTenantSelected };
}

/**
 * Open the switcher menu.
 *
 * @param user The `userEvent` session driving the interaction.
 * @returns The opened `role="menu"` element.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByTestId('rail-workspace'));
  return screen.getByRole('menu', { name: 'Your workspaces' });
}

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` forgets the calls but keeps the implementations, and two tests below
  // install a rejecting and a never-settling `update` — so both doubles are re-armed here
  // rather than leaking into whatever runs next.
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue(undefined);
  mockPersistLastActiveTenant.mockReset();
  mockPersistLastActiveTenant.mockResolvedValue(undefined);
});

describe('WorkspaceSwitcher — the rail row', () => {
  it('names the active workspace and its role and plan', async () => {
    await renderSwitcher();

    const row = screen.getByTestId('rail-workspace');
    expect(row).toHaveTextContent('Acme Corp');
    expect(row).toHaveTextContent('Owner · Free');
    // The action is announced for a reader who cannot see the chevron — and is the whole of
    // the accessible name once the collapsed rail has taken the label away.
    expect(row).toHaveAccessibleName(/switch workspace/i);
  });

  it('says so plainly when the session has no workspace', async () => {
    await renderSwitcher({ tenantId: null });

    const row = screen.getByTestId('rail-workspace');
    expect(row).toHaveTextContent('No workspace');
    expect(row).toHaveTextContent('Choose a workspace');
  });

  it('stays usable when the membership call fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    await renderSwitcher({ fail: true });

    expect(screen.getByTestId('rail-workspace')).toHaveTextContent('No workspace');
    // Still opens: the failure cost the list, not the control.
    await user.click(screen.getByTestId('rail-workspace'));
    expect(screen.getByRole('searchbox', { name: 'Filter workspaces' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('holds the name\'s place while the first load runs, rather than denying the workspace', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { user_id: 'u-1', current_tenant_id: CURRENT_ID } },
      update: mockUpdate,
    });
    // A loader the test resolves by hand, so the first-load state can be observed.
    let resolveContext: (context: TenantMembershipContextPayload) => void = () => {};
    const loadContext = jest.fn(
      () =>
        new Promise<TenantMembershipContextPayload>((resolve) => {
          resolveContext = resolve;
        })
    );

    render(
      <TooltipProvider>
        <WorkspaceSwitcher iconRail={false} loadContext={loadContext as never} />
      </TooltipProvider>
    );

    const row = screen.getByTestId('rail-workspace');
    // "No workspace" would be a claim the switcher cannot yet make; a skeleton is not.
    expect(row).not.toHaveTextContent('No workspace');
    expect(row).toHaveTextContent('Loading…');
    expect(row).toBeDisabled();

    await act(async () => {
      resolveContext(membershipContext());
    });

    expect(screen.getByTestId('rail-workspace')).toHaveTextContent('Acme Corp');
  });

  it('renders nothing at all without a session', () => {
    mockUseSession.mockReturnValue({ data: null, update: mockUpdate });

    const { container } = render(
      <TooltipProvider>
        <WorkspaceSwitcher iconRail={false} loadContext={jest.fn() as never} />
      </TooltipProvider>
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('describes the row in a tooltip when the rail is icon-only', async () => {
    await renderSwitcher({ iconRail: true });

    screen.getByTestId('rail-workspace').focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Acme Corp — switch workspace');
  });

  it('still opens its menu from the collapsed rail', async () => {
    const user = userEvent.setup();
    await renderSwitcher({ iconRail: true });

    const menu = await openMenu(user);

    expect(within(menu).getByTestId(`workspace-option-${CURRENT_ID}`)).toBeInTheDocument();
  });
});

describe('WorkspaceSwitcher — the menu', () => {
  it('opens and closes from the trigger, and says so on the trigger', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    const trigger = screen.getByTestId('rail-workspace');

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await openMenu(user);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByTestId('workspace-menu').id);

    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('lists every membership with its own role badge and licence chip', async () => {
    const user = userEvent.setup();
    await renderSwitcher();

    const menu = await openMenu(user);

    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(
      within(menu)
        .getAllByTestId('tenant-role-badge')
        .map((badge) => badge.textContent)
    ).toEqual(['owner', 'editor', 'viewer']);
    expect(
      within(menu)
        .getAllByTestId('tenant-license-chip')
        .map((chip) => chip.textContent)
    ).toEqual(['· Free', '· Team', '· Free']);
  });

  it('marks the current workspace as the checked one', async () => {
    const user = userEvent.setup();
    await renderSwitcher();

    const menu = await openMenu(user);

    const checked = within(menu)
      .getAllByRole('menuitemradio')
      .filter((row) => row.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute('data-testid', `workspace-option-${CURRENT_ID}`);
  });

  it('shows a suspended membership, explains it, and refuses the switch', async () => {
    const user = userEvent.setup();
    await renderSwitcher();

    const menu = await openMenu(user);
    const suspended = within(menu).getByTestId('workspace-option-t-initech');

    expect(suspended).toHaveAttribute('aria-disabled', 'true');
    expect(suspended).toHaveAttribute(
      'title',
      'Your membership in this workspace is suspended'
    );
    expect(suspended).toHaveTextContent('Suspended');
    await user.click(suspended);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('keeps a suspended membership reachable from the keyboard', async () => {
    const user = userEvent.setup();
    await renderSwitcher();

    const menu = await openMenu(user);
    const suspended = within(menu).getByTestId('workspace-option-t-initech');

    // `aria-disabled`, not `disabled`: the row a reader most needs explained is the one they
    // must be able to focus to hear the explanation.
    expect(suspended).not.toBeDisabled();
    suspended.focus();
    expect(suspended).toHaveFocus();
  });

  it('falls back to the legacy Admin badge for name-only rows', async () => {
    const user = userEvent.setup();
    await renderSwitcher({
      context: {
        tenants: [
          { id: CURRENT_ID, name: 'Acme Corp' },
          { id: 't-globex', name: 'Globex Labs' },
        ],
        adminTenantIds: [CURRENT_ID],
        createTenant: null,
      },
    });

    const menu = await openMenu(user);

    expect(within(menu).getByText('Admin')).toBeInTheDocument();
    expect(within(menu).getAllByTestId('tenant-role-badge')).toHaveLength(1);
    expect(within(menu).queryAllByTestId('tenant-license-chip')).toHaveLength(0);
  });
});

describe('WorkspaceSwitcher — filtering', () => {
  it('filters on the name', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);

    await user.type(screen.getByRole('searchbox', { name: 'Filter workspaces' }), 'globex');

    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
    expect(screen.getByTestId('workspace-option-t-globex')).toBeInTheDocument();
  });

  it('filters on the slug as well as the name', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);

    // "acme-corp" is the slug of a workspace named "Acme Corp"; the hyphen only appears in
    // the slug, so a match proves the slug was searched.
    await user.type(screen.getByRole('searchbox', { name: 'Filter workspaces' }), 'acme-c');

    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
    expect(screen.getByTestId(`workspace-option-${CURRENT_ID}`)).toBeInTheDocument();
  });

  it('says when nothing matches, and owns no empty menu while it does', async () => {
    const user = userEvent.setup();
    await renderSwitcher({ context: membershipContext({ createTenant: null }) });
    await openMenu(user);

    await user.type(screen.getByRole('searchbox', { name: 'Filter workspaces' }), 'zzz');

    expect(screen.getByText('No matching workspaces')).toBeInTheDocument();
    // An empty `role="menu"` is itself an `aria-required-children` violation.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('forgets the query between openings', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);
    await user.type(screen.getByRole('searchbox', { name: 'Filter workspaces' }), 'globex');

    await user.keyboard('{Escape}');
    await openMenu(user);

    expect(screen.getByRole('searchbox', { name: 'Filter workspaces' })).toHaveValue('');
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
  });
});

describe('WorkspaceSwitcher — switching', () => {
  it('updates the session, writes the last-active cookie and refreshes', async () => {
    const user = userEvent.setup();
    const { onTenantSelected } = await renderSwitcher();
    await openMenu(user);

    await user.click(screen.getByTestId('workspace-option-t-globex'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ current_tenant_id: 't-globex' }));
    await waitFor(() => expect(mockPersistLastActiveTenant).toHaveBeenCalledWith('t-globex'));
    expect(mockRouterRefresh).toHaveBeenCalled();
    expect(onTenantSelected).toHaveBeenCalledWith('t-globex');
  });

  it('closes the menu and returns focus to the trigger after a switch', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);

    await user.click(screen.getByTestId('workspace-option-t-globex'));

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByTestId('rail-workspace')).toHaveFocus();
  });

  it('names the chosen workspace before the session round-trip finishes', async () => {
    const user = userEvent.setup();
    // An update that never settles: the row must not wait for it to show the answer.
    mockUpdate.mockImplementation(() => new Promise<void>(() => {}));
    await renderSwitcher();
    await openMenu(user);

    await user.click(screen.getByTestId('workspace-option-t-globex'));

    await waitFor(() =>
      expect(screen.getByTestId('rail-workspace')).toHaveTextContent('Globex Labs')
    );
    expect(screen.getByTestId('rail-workspace')).toHaveTextContent('Editor · Team');
  });

  it('puts the menu away when the current workspace is chosen again, and changes nothing', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);

    await user.click(screen.getByTestId(`workspace-option-${CURRENT_ID}`));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('keeps the row on the old workspace when the switch fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    mockUpdate.mockRejectedValue(new Error('session offline'));
    await renderSwitcher();
    await openMenu(user);

    await user.click(screen.getByTestId('workspace-option-t-globex'));

    await waitFor(() =>
      expect(screen.getByTestId('rail-workspace')).toHaveTextContent('Acme Corp')
    );
    expect(mockRouterRefresh).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('WorkspaceSwitcher — creating a workspace', () => {
  it('offers the entry with the cap it is spending, and opens the dialog', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);

    const entry = screen.getByTestId('create-tenant-entry');
    expect(entry).toHaveTextContent('Create workspace');
    expect(entry).toHaveTextContent('3/5');
    expect(entry).not.toHaveAttribute('aria-disabled');

    await user.click(entry);

    expect(screen.getByTestId('create-tenant-dialog-stub')).toBeInTheDocument();
    // The trigger is the element the dialog will hand focus back to when it closes.
    expect(screen.getByTestId('rail-workspace')).toHaveFocus();
  });

  it('refuses and explains at the cap', async () => {
    const user = userEvent.setup();
    await renderSwitcher({
      context: membershipContext({ createTenant: { allowed: false, used: 1, max: 1 } }),
    });
    await openMenu(user);

    const entry = screen.getByTestId('create-tenant-entry');
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    expect(entry).toHaveAttribute(
      'title',
      'Workspace limit reached (1 of 1 used) — upgrade your plan to create more'
    );

    await user.click(entry);
    expect(screen.queryByTestId('create-tenant-dialog-stub')).not.toBeInTheDocument();
  });

  it('hides the entry when the context carries no gate', async () => {
    const user = userEvent.setup();
    await renderSwitcher({ context: membershipContext({ createTenant: null }) });
    await openMenu(user);

    expect(screen.queryByTestId('create-tenant-entry')).not.toBeInTheDocument();
  });

  it('activates a newly created workspace and spends a slot of the cap', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);
    await user.click(screen.getByTestId('create-tenant-entry'));

    await user.click(screen.getByRole('button', { name: 'finish-create' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ current_tenant_id: 't-new' }));
    await waitFor(() => expect(mockPersistLastActiveTenant).toHaveBeenCalledWith('t-new'));
    expect(mockRouterRefresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('rail-workspace')).toHaveTextContent('New Workspace')
    );

    await openMenu(user);
    expect(screen.getByTestId('create-tenant-entry')).toHaveTextContent('4/5');
    expect(screen.getByTestId('workspace-option-t-new')).toBeInTheDocument();
  });
});

describe('WorkspaceSwitcher — the keyboard', () => {
  it('walks into the menu from the filter field and around it with the arrows', async () => {
    const user = userEvent.setup();
    await renderSwitcher({ context: membershipContext({ createTenant: null }) });
    await openMenu(user);

    // The filter takes focus on open, so typing is always the query.
    expect(screen.getByRole('searchbox', { name: 'Filter workspaces' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId(`workspace-option-${CURRENT_ID}`)).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('workspace-option-t-globex')).toHaveFocus();

    // Wraps at both ends rather than dead-ending.
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByTestId(`workspace-option-${CURRENT_ID}`)).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('workspace-option-t-initech')).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByTestId(`workspace-option-${CURRENT_ID}`)).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByTestId('workspace-option-t-initech')).toHaveFocus();
  });

  it('walks up from the filter field into the last item', async () => {
    const user = userEvent.setup();
    await renderSwitcher({ context: membershipContext({ createTenant: null }) });
    await openMenu(user);

    await user.keyboard('{ArrowUp}');

    expect(screen.getByTestId('workspace-option-t-initech')).toHaveFocus();
  });

  it('reaches the create entry with the arrows too', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);

    await user.keyboard('{ArrowDown}{End}');

    expect(screen.getByTestId('create-tenant-entry')).toHaveFocus();
  });

  it('keeps exactly one item in the tab order, and moves it with the caret', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    const menu = await openMenu(user);

    const tabbable = () =>
      within(menu)
        .getAllByRole('menuitemradio')
        .concat(screen.getByTestId('create-tenant-entry'))
        .filter((item) => item.getAttribute('tabindex') === '0');

    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAttribute('data-testid', `workspace-option-${CURRENT_ID}`);

    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAttribute('data-testid', 'workspace-option-t-globex');
  });

  it('closes on Escape and gives the trigger its focus back', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-workspace')).toHaveFocus();
  });

  it('closes on Escape from the filter field as well', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    await openMenu(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-workspace')).toHaveFocus();
  });

  it('closes once focus tabs out of it, so a menu is never left behind the caret', async () => {
    const user = userEvent.setup();
    await renderSwitcher({ context: membershipContext({ createTenant: null }) });
    // Somewhere for the caret to land — in the app that is the rest of the rail.
    render(<button type="button">next stop</button>);
    await openMenu(user);
    // Into the menu, then onto its last item: the arrow keys are handled by the menu
    // element, so the walk has to start with the step off the filter field.
    await user.keyboard('{ArrowDown}{End}');

    await user.tab();

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'next stop' })).toHaveFocus();
  });

  it('closes when a click lands outside, leaving focus where it went', async () => {
    const user = userEvent.setup();
    await renderSwitcher();
    render(<button type="button">elsewhere</button>);
    await openMenu(user);

    await user.click(screen.getByRole('button', { name: 'elsewhere' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-workspace')).not.toHaveFocus();
  });
});

describe('WorkspaceSwitcher — the meta line', () => {
  it('reads role then plan for an enriched membership', () => {
    expect(
      formatWorkspaceMeta({ id: 't', name: 'n', role: 'owner', licenseName: 'Team' }, false)
    ).toBe('Owner · Team');
  });

  it('treats an unlicensed workspace as Free, the tier the guard enforces', () => {
    expect(formatWorkspaceMeta({ id: 't', name: 'n', role: 'viewer' }, false)).toBe(
      'Viewer · Free'
    );
  });

  it('claims no plan for a row with no enrichment', () => {
    expect(formatWorkspaceMeta({ id: 't', name: 'n' }, false)).toBe('Choose a workspace');
  });

  it('says it is loading only while there is nothing to describe', () => {
    expect(formatWorkspaceMeta(undefined, true)).toBe('Loading…');
    expect(formatWorkspaceMeta({ id: 't', name: 'n', role: 'owner' }, true)).toBe('Owner · Free');
  });
});

/**
 * Relative luminance of an `#rrggbb` colour, per WCAG 2.1 §relative-luminance.
 *
 * @param hex A six- or three-digit hex colour.
 * @returns Its relative luminance, 0–1.
 */
function relativeLuminance(hex: string): number {
  const full = hex.replace('#', '');
  const expanded = full.length === 3 ? [...full].map((c) => c + c).join('') : full;
  const channels = [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Contrast ratio between two colours.
 *
 * @param a One colour.
 * @param b The other.
 * @returns The WCAG contrast ratio, 1–21.
 */
function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

describe('WorkspaceSwitcher — quiet text', () => {
  /**
   * Every theme block in `globals.css`, as the three tokens the switcher's quiet text is
   * read against. jsdom applies no stylesheet, so the ratios are computed from the source.
   */
  const themes = (() => {
    const css = readFileSync(join(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8');
    const read = (token: string) =>
      [...css.matchAll(new RegExp(`--color-${token}:\\s*(#[0-9A-Fa-f]{6})`, 'g'))].map((m) => m[1]);
    const surfaces = read('surface');
    const rails = read('rail');
    const muted = read('fg-muted');
    return surfaces.map((surface, index) => ({
      surface,
      rail: rails[index],
      muted: muted[index],
    }));
  })();

  it('reads every theme block, so a new theme cannot slip past this', () => {
    // The light base, the dark block and the six named themes that restate these tokens.
    expect(themes.length).toBeGreaterThanOrEqual(8);
    for (const theme of themes) {
      expect(theme.rail).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(theme.muted).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('clears WCAG AA on the menu surface and on the rail, in every theme', () => {
    // The switcher's meta line, licence chips, cap counter, section label and disabled rows
    // are all `--fg-muted` rather than the quieter `--fg-subtle` DESIGN.md §3.2 nominates
    // for section labels — because `--fg-subtle` measures under 4.5:1 against both of these
    // backgrounds in most of the themes, and every one of those strings is meant to be read.
    for (const theme of themes) {
      expect(contrastRatio(theme.muted, theme.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.muted, theme.rail)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('WorkspaceSwitcher — accessibility', () => {
  it('has no axe violations with the menu closed', async () => {
    const { view } = await renderSwitcher();

    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('has no axe violations with the menu open', async () => {
    const user = userEvent.setup();
    const { view } = await renderSwitcher();
    await openMenu(user);

    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('has no axe violations when the filter matches nothing', async () => {
    const user = userEvent.setup();
    const { view } = await renderSwitcher();
    await openMenu(user);
    await user.type(screen.getByRole('searchbox', { name: 'Filter workspaces' }), 'zzz');

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
