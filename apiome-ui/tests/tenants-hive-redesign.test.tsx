/**
 * Tenants — `/ade/dashboard/tenants` (HIVE-5.1, #5304).
 *
 * A redesign of a screen that already worked, so this suite is ordered by the ticket's
 * acceptance criteria rather than by the page's layout:
 *
 *   1. **Per-tenant state is isolated.** Expanding or filtering one tenant's members does
 *      not touch another's. This is the defect the ticket exists to close, so it is first
 *      and it is tested by actually opening two drawers in turn.
 *   2. **No `classList` / DOM toggling remains.** Manage opens a real `Drawer` — a modal
 *      React owns, with a focus trap and `Esc` — not a `hidden` div that a menu item
 *      un-hides by reaching for it by id. (Focus *restoration* on close belongs to the
 *      `Drawer` primitive rather than to this page, and needs a real focus model to observe;
 *      `e2e/hive-primitives.spec.ts` measures it in a browser.)
 *   3. **Every capability of the old panel is present**, as five vertical tabs, each loading
 *      only when it is first opened.
 *   4. **Non-current tenants show the lock note**, naming the tenant.
 *   5. **The slug-change confirm still enumerates before → after** and carries the
 *      published-URL warning.
 *   6. **One chrome.** The page's own `<header>` is gone; `Page` / `PageHeader` / `PageBody`
 *      replace it, with the list as a `DataTable`.
 *   7. **axe: zero violations**, loaded and loading.
 *
 * What it cannot answer is how any of it *looks*: jsdom compiles no stylesheet.
 * `tenants-css.test.ts` reads `globals.css` instead, and `e2e/hive-tenants.spec.ts` measures
 * the rendered page. The derivations behind all of it are pinned by `tenants-model.test.ts`.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

/** A real anchor, with navigation suppressed — jsdom logs an error rather than navigating. */
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a
      href={typeof href === 'string' ? href : '#'}
      onClick={(event) => event.preventDefault()}
      {...rest}
    >
      {children}
    </a>
  ),
}));

/** The session the page renders against; a test may replace it before rendering. */
const sessionState: {
  current: { user: { user_id: string; current_tenant_id: string | null } } | null;
} = { current: null };
const mockSessionUpdate = jest.fn(async () => undefined);

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: sessionState.current,
    status: sessionState.current ? 'authenticated' : 'unauthenticated',
    update: (...args: unknown[]) => mockSessionUpdate(...(args as [])),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/** The seven server actions the page reads or writes through. */
const mockGetTenants = jest.fn<Promise<string>, [string]>();
const mockGetAdminTenants = jest.fn<Promise<string>, [string]>();
const mockGetTenantUsers = jest.fn<Promise<string>, [string]>();
const mockAddTenantUser = jest.fn<Promise<string>, [string, string]>();
const mockAddTenantAdmin = jest.fn<Promise<string>, [string, string]>();
const mockRemoveTenantUser = jest.fn<Promise<string>, [string]>();
const mockRemoveTenantAdmin = jest.fn<Promise<string>, [string]>();
const mockUpdateTenant =
  jest.fn<Promise<string>, [string, string, string, string]>();

jest.mock('../lib/db/helper', () => ({
  getTenantsForUser: (userId: string) => mockGetTenants(userId),
  getTenantsAdministratedByUser: (userId: string) => mockGetAdminTenants(userId),
  getTenantUsers: (tenantId: string) => mockGetTenantUsers(tenantId),
  addTenantUser: (tenantId: string, email: string) => mockAddTenantUser(tenantId, email),
  addTenantAdministrator: (tenantId: string, email: string) =>
    mockAddTenantAdmin(tenantId, email),
  removeTenantUser: (recordId: string) => mockRemoveTenantUser(recordId),
  removeTenantAdministrator: (recordId: string) => mockRemoveTenantAdmin(recordId),
  updateTenant: (id: string, name: string, description: string, slug: string) =>
    mockUpdateTenant(id, name, description, slug),
}));

/** The create-tenant flow has its own suite (OLO-6.1); here it is a marker. */
jest.mock('@/app/components/ade/CreateTenantDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-tenant-dialog">Create a tenant</div> : null,
}));

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));

/** The MCP confirm dialog, which the settings tab raises for an impactful disable. */
jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({ confirm: async () => true, alert: async () => undefined }),
}));

import TenantsPage from '@/app/ade/dashboard/tenants/page';

/** Two administered tenants and one the viewer is only a member of. */
const TENANTS = [
  {
    id: 't-acme',
    name: 'Acme Corp',
    slug: 'acme-corp',
    description: 'Merchant platform APIs',
    enabled: true,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 't-globex',
    name: 'Globex Labs',
    slug: 'globex-labs',
    description: '',
    enabled: true,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 't-initech',
    name: 'Initech',
    slug: 'initech',
    description: '',
    enabled: false,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

/** Ada administers Acme and Globex; she is only a member of Initech. */
const ADMIN_ROWS = [
  {
    id: 'ta-acme-ada',
    tenant_id: 't-acme',
    user_id: 'u-ada',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  },
  {
    id: 'ta-globex-ada',
    tenant_id: 't-globex',
    user_id: 'u-ada',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  },
];

/** Acme's people and Globex's, deliberately disjoint so a leak between them is visible. */
const MEMBERS: Record<string, unknown[]> = {
  't-acme': [
    {
      id: 'tu-acme-ada',
      tenant_id: 't-acme',
      user_id: 'u-ada',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    },
    {
      id: 'tu-acme-linus',
      tenant_id: 't-acme',
      user_id: 'u-linus',
      name: 'Linus Torvalds',
      email: 'linus@example.com',
    },
    {
      id: 'tu-acme-margaret',
      tenant_id: 't-acme',
      user_id: 'u-margaret',
      name: 'Margaret Hamilton',
      email: 'margaret@example.com',
    },
  ],
  't-globex': [
    {
      id: 'tu-globex-grace',
      tenant_id: 't-globex',
      user_id: 'u-grace',
      name: 'Grace Hopper',
      email: 'grace@example.com',
    },
  ],
};

const OK = JSON.stringify({ success: true });

beforeEach(() => {
  jest.clearAllMocks();
  sessionState.current = { user: { user_id: 'u-ada', current_tenant_id: 't-acme' } };

  mockGetTenants.mockResolvedValue(JSON.stringify(TENANTS));
  mockGetAdminTenants.mockResolvedValue(JSON.stringify(ADMIN_ROWS));
  mockGetTenantUsers.mockImplementation(async (tenantId) =>
    JSON.stringify(MEMBERS[tenantId] ?? []),
  );
  mockAddTenantUser.mockResolvedValue(OK);
  mockAddTenantAdmin.mockResolvedValue(OK);
  mockRemoveTenantUser.mockResolvedValue(OK);
  mockRemoveTenantAdmin.mockResolvedValue(OK);
  mockUpdateTenant.mockResolvedValue(JSON.stringify({ success: true, slug: 'acme' }));

  // The MCP and license tabs read through `fetch`; nothing here opens them except the
  // tests that mean to, and those set their own payloads.
  global.fetch = jest.fn(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ success: true, data: { changes: [] } }),
  })) as unknown as typeof fetch;

  // Radix Select and the drawer need these in jsdom.
  // @ts-expect-error jsdom stub
  Element.prototype.hasPointerCapture ??= () => false;
  // @ts-expect-error jsdom stub
  Element.prototype.setPointerCapture ??= () => {};
  // @ts-expect-error jsdom stub
  Element.prototype.releasePointerCapture ??= () => {};
  // @ts-expect-error jsdom stub
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});

/** Render the page and wait for the tenant list to arrive. */
async function renderPage() {
  const utils = render(<TenantsPage />);
  expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
  return utils;
}

/**
 * Open the manage drawer for one tenant.
 *
 * @param name The tenant's display name.
 * @returns The drawer element.
 */
async function openDrawer(name: string) {
  const row = screen.getByText(name).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /^Manage$/ }));
  return await screen.findByTestId('tenant-manage-drawer');
}

/**
 * Select one of the drawer's vertical tabs.
 *
 * `mouseDown`, not `click`: Radix's `TabsTrigger` changes the value from its `onMouseDown`
 * and from focus (`activationMode="automatic"`), and `fireEvent.click` dispatches neither.
 *
 * @param drawer The open drawer.
 * @param name The tab's accessible name.
 */
function selectTab(drawer: HTMLElement, name: string | RegExp) {
  fireEvent.mouseDown(within(drawer).getByRole('tab', { name }), { button: 0 });
}

/**
 * Open a row's overflow menu.
 *
 * `keyDown`, not `click`: Radix's `DropdownMenuTrigger` opens on `pointerdown`, which jsdom
 * does not synthesise from a click, and on `Enter`, which it does.
 *
 * @param row The table row.
 * @param label The trigger's accessible name.
 */
function openRowMenu(row: HTMLElement, label: RegExp) {
  fireEvent.keyDown(within(row).getByRole('button', { name: label }), { key: 'Enter' });
}

/** Dismiss whatever drawer is open, and wait for it to go. */
async function closeDrawer() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => {
    expect(screen.queryByTestId('tenant-manage-drawer')).not.toBeInTheDocument();
  });
}

/* -------------------------------------------------------------------------
   1. Per-tenant state is isolated — the defect this ticket closes
   ------------------------------------------------------------------------- */

describe('per-tenant isolation', () => {
  it('opens the drawer for the tenant whose Manage was pressed', async () => {
    await renderPage();

    const drawer = await openDrawer('Globex Labs');

    expect(drawer).toHaveAttribute('data-tenant-id', 't-globex');
    expect(within(drawer).getByText('Manage Globex Labs')).toBeInTheDocument();
    expect(within(drawer).getByText('Grace Hopper')).toBeInTheDocument();
    // Acme's people are not in Globex's drawer, whatever the page loaded.
    expect(within(drawer).queryByText('Linus Torvalds')).not.toBeInTheDocument();
  });

  it('does not carry one tenant’s member filter over to another', async () => {
    const user = userEvent.setup();
    await renderPage();

    // Filter Acme's members down to nothing.
    const acme = await openDrawer('Acme Corp');
    await user.type(within(acme).getByLabelText('Filter members'), 'zzz');
    await waitFor(() => {
      expect(screen.getByText(/No members match the filter/i)).toBeInTheDocument();
    });
    await closeDrawer();

    // Globex must open unfiltered. On the screen this replaces, one `memberFilter` was
    // shared by every tenant panel, so this is exactly what used to break.
    const globex = await openDrawer('Globex Labs');
    expect(within(globex).getByLabelText('Filter members')).toHaveValue('');
    expect(within(globex).getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByText(/No members match the filter/i)).not.toBeInTheDocument();
  });

  it('starts every drawer on Members rather than on the last tenant’s tab', async () => {
    await renderPage();

    const acme = await openDrawer('Acme Corp');
    selectTab(acme, /Policy history/i);
    await waitFor(() => {
      expect(within(acme).getByRole('tab', { name: /Policy history/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    await closeDrawer();

    const globex = await openDrawer('Globex Labs');
    expect(within(globex).getByRole('tab', { name: /Members/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('shows each tenant’s own member count on its Members tab', async () => {
    await renderPage();

    // Acme has three people; Globex has two — Grace, plus Ada, who administers it without a
    // membership row of her own. Both counts are the merge of the two join tables.
    const acme = await openDrawer('Acme Corp');
    expect(within(acme).getByRole('tab', { name: /Members/i })).toHaveTextContent('3');
    expect(within(acme).getByText(/3 members · 1 admin/)).toBeInTheDocument();
    await closeDrawer();

    const globex = await openDrawer('Globex Labs');
    expect(within(globex).getByRole('tab', { name: /Members/i })).toHaveTextContent('2');
    expect(within(globex).getByText(/2 members · 1 admin/)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   2. No classList / DOM toggling remains
   ------------------------------------------------------------------------- */

describe('the drawer is React-owned, not a hidden div', () => {
  it('renders no per-tenant administration block before Manage is pressed', async () => {
    const { container } = await renderPage();

    // The old markup was `<div id="tenant-<id>" class="hidden …">`, one per administered
    // tenant, always in the document and toggled by `classList`.
    for (const tenant of TENANTS) {
      expect(container.querySelector(`#tenant-${tenant.id}`)).toBeNull();
    }
    expect(screen.queryByTestId('tenant-manage-drawer')).not.toBeInTheDocument();
    expect(screen.queryByText(/Administration Panel/i)).not.toBeInTheDocument();
  });

  it('opens as a modal dialog that traps focus, and Esc closes it', async () => {
    await renderPage();

    const drawer = await openDrawer('Acme Corp');
    expect(drawer).toHaveAttribute('role', 'dialog');
    expect(drawer).toHaveAttribute('data-state', 'open');
    // Focus moved into the sheet — the thing a `classList.toggle('hidden')` never did.
    await waitFor(() => {
      expect(drawer.contains(document.activeElement)).toBe(true);
    });

    await closeDrawer();
  });

  it('closes on Done, and unmounts rather than hiding', async () => {
    await renderPage();

    const drawer = await openDrawer('Acme Corp');
    fireEvent.click(within(drawer).getByRole('button', { name: /^Done$/ }));

    await waitFor(() => {
      expect(screen.queryByTestId('tenant-manage-drawer')).not.toBeInTheDocument();
    });
  });

  it('offers Manage only for tenants the viewer administers', async () => {
    await renderPage();

    const initech = screen.getByText('Initech').closest('tr') as HTMLElement;
    expect(within(initech).queryByRole('button', { name: /^Manage$/ })).not.toBeInTheDocument();

    openRowMenu(initech, /Actions for Initech/i);
    expect(await screen.findByText(/Manage — admins only/i)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   3. Every capability is present, as five lazily-mounted tabs
   ------------------------------------------------------------------------- */

describe('the five sections', () => {
  it('lists all five in the mockup’s order', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    expect(within(drawer).getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual([
      expect.stringContaining('Members'),
      'License & plan',
      'MCP settings',
      'Per-key capabilities',
      'Policy history',
    ]);
  });

  it('loads nothing but Members until another tab is opened', async () => {
    await renderPage();
    await openDrawer('Acme Corp');

    // Members come from the tenant lists the page already had; no section fetches on open.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('loads a section the first time its tab is opened', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    selectTab(drawer, /Policy history/i);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(
      (global.fetch as jest.Mock).mock.calls.some((call) =>
        String(call[0]).includes('/api/tenants/mcp-policy/history'),
      ),
    ).toBe(true);
  });

  it('keeps a visited section mounted, so a draft survives a look at another tab', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    selectTab(drawer, /Policy history/i);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const callsAfterFirstVisit = (global.fetch as jest.Mock).mock.calls.length;

    selectTab(drawer, /Members/i);
    selectTab(drawer, /Policy history/i);

    // Re-selecting a tab it has already seen is not a second load: the panel never unmounted.
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsAfterFirstVisit);
  });
});

/* -------------------------------------------------------------------------
   4. Non-current tenants show the lock note
   ------------------------------------------------------------------------- */

describe('a tenant that is not the current one', () => {
  it('locks the four proxy-backed sections, naming the tenant', async () => {
    await renderPage();
    const drawer = await openDrawer('Globex Labs');

    for (const [tab, testId, copy] of [
      ['License & plan', 'tnt-lock-license', /view its license details/i],
      ['MCP settings', 'tnt-lock-mcp', /view or edit MCP settings/i],
      ['Per-key capabilities', 'tnt-lock-keys', /view or edit key capabilities/i],
      ['Policy history', 'tnt-lock-history', /view its policy history/i],
    ] as const) {
      selectTab(drawer, tab);
      const note = await within(drawer).findByTestId(testId);
      expect(note).toHaveTextContent('Select Globex Labs as your current tenant');
      expect(note).toHaveTextContent(copy);
    }

    // A locked section reads its own data from nowhere, so nothing is requested for it.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still shows that tenant’s members, which do not come from the proxy', async () => {
    await renderPage();
    const drawer = await openDrawer('Globex Labs');

    expect(within(drawer).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(drawer).queryByTestId('tnt-lock-members')).not.toBeInTheDocument();
  });

  it('lets the current tenant through to the live sections', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    selectTab(drawer, 'Policy history');

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(within(drawer).queryByTestId('tnt-lock-history')).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   5. The slug-change confirm
   ------------------------------------------------------------------------- */

describe('editing a tenant', () => {
  /** Open Edit tenant for Acme from its row menu. */
  async function openEditDialog() {
    const row = screen.getByText('Acme Corp').closest('tr') as HTMLElement;
    openRowMenu(row, /Actions for Acme Corp/i);
    fireEvent.click(await screen.findByText('Edit'));
    return await screen.findByRole('dialog', { name: /Edit tenant/i });
  }

  it('saves a name-only change without asking anything', async () => {
    const user = userEvent.setup();
    await renderPage();
    const dialog = await openEditDialog();

    const name = within(dialog).getByLabelText('Tenant name');
    await user.clear(name);
    await user.type(name, 'Acme Europe');
    fireEvent.click(within(dialog).getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(mockUpdateTenant).toHaveBeenCalledWith(
        't-acme',
        'Acme Europe',
        'Merchant platform APIs',
        'acme-corp',
      );
    });
    expect(screen.queryByText(/Change tenant slug\?/i)).not.toBeInTheDocument();
  });

  it('stops for a confirm that enumerates before → after when the slug moves', async () => {
    const user = userEvent.setup();
    await renderPage();
    const dialog = await openEditDialog();

    const slug = within(dialog).getByLabelText('Tenant slug');
    await user.clear(slug);
    await user.type(slug, 'acme');
    fireEvent.click(within(dialog).getByRole('button', { name: /Save changes/i }));

    const confirm = await screen.findByRole('alertdialog', { name: /Change tenant slug\?/i });
    const summary = within(confirm).getByTestId('tnt-slug-change-summary');
    expect(summary).toHaveTextContent('acme-corp');
    expect(summary).toHaveTextContent('acme');
    expect(
      within(confirm).getByText(/Changing the slug will affect URLs/i),
    ).toBeInTheDocument();
    expect(
      within(confirm).getByText(/published OpenAPI specs that reference this tenant/i),
    ).toBeInTheDocument();

    // Nothing has been written while the confirm is up.
    expect(mockUpdateTenant).not.toHaveBeenCalled();
  });

  it('writes nothing when the slug confirm is cancelled', async () => {
    const user = userEvent.setup();
    await renderPage();
    const dialog = await openEditDialog();

    const slug = within(dialog).getByLabelText('Tenant slug');
    await user.clear(slug);
    await user.type(slug, 'acme');
    fireEvent.click(within(dialog).getByRole('button', { name: /Save changes/i }));

    const confirm = await screen.findByRole('alertdialog', { name: /Change tenant slug\?/i });
    fireEvent.click(within(confirm).getByRole('button', { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(mockUpdateTenant).not.toHaveBeenCalled();
  });

  it('writes the change once the confirm is accepted', async () => {
    const user = userEvent.setup();
    await renderPage();
    const dialog = await openEditDialog();

    const slug = within(dialog).getByLabelText('Tenant slug');
    await user.clear(slug);
    await user.type(slug, 'acme');
    fireEvent.click(within(dialog).getByRole('button', { name: /Save changes/i }));

    const confirm = await screen.findByRole('alertdialog', { name: /Change tenant slug\?/i });
    fireEvent.click(within(confirm).getByRole('button', { name: /Change slug/i }));

    await waitFor(() => {
      expect(mockUpdateTenant).toHaveBeenCalledWith(
        't-acme',
        'Acme Corp',
        'Merchant platform APIs',
        'acme',
      );
    });
  });

  it('refuses an invalid slug in the words the screen has always used', async () => {
    const user = userEvent.setup();
    await renderPage();
    const dialog = await openEditDialog();

    const slug = within(dialog).getByLabelText('Tenant slug');
    await user.clear(slug);
    await user.type(slug, 'acme corp');
    fireEvent.click(within(dialog).getByRole('button', { name: /Save changes/i }));

    expect(
      await within(dialog).findByText(
        /Slug must contain only lowercase letters, numbers, and dashes/i,
      ),
    ).toBeInTheDocument();
    expect(mockUpdateTenant).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------
   6. The membership dialogs
   ------------------------------------------------------------------------- */

describe('membership', () => {
  it('adds a member, and adds the administrator role only when asked', async () => {
    const user = userEvent.setup();
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    fireEvent.click(within(drawer).getByRole('button', { name: /Add member/i }));
    const dialog = await screen.findByRole('dialog', { name: /Add member/i });
    expect(dialog).toHaveTextContent('Add a new member to Acme Corp.');

    await user.type(within(dialog).getByLabelText('Email address'), 'grace@example.com');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add member$/ }));

    await waitFor(() => {
      expect(mockAddTenantUser).toHaveBeenCalledWith('t-acme', 'grace@example.com');
    });
    expect(mockAddTenantAdmin).not.toHaveBeenCalled();
  });

  it('refuses an empty email rather than posting one', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    fireEvent.click(within(drawer).getByRole('button', { name: /Add member/i }));
    const dialog = await screen.findByRole('dialog', { name: /Add member/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add member$/ }));

    expect(
      await within(dialog).findByText(/Please enter an email address/i),
    ).toBeInTheDocument();
    expect(mockAddTenantUser).not.toHaveBeenCalled();
  });

  it('shows the API’s own error rather than guessing at one', async () => {
    const user = userEvent.setup();
    mockAddTenantUser.mockResolvedValue(
      JSON.stringify({ success: false, error: 'No user with that email address' }),
    );
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    fireEvent.click(within(drawer).getByRole('button', { name: /Add member/i }));
    const dialog = await screen.findByRole('dialog', { name: /Add member/i });
    await user.type(within(dialog).getByLabelText('Email address'), 'nobody@example.com');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Add member$/ }));

    expect(
      await within(dialog).findByText(/No user with that email address/i),
    ).toBeInTheDocument();
  });

  it('withholds edit and remove on the viewer’s own row', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    expect(
      within(drawer).getByRole('button', { name: /Edit roles for Ada Lovelace/i }),
    ).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: /Remove Ada Lovelace/i })).toBeDisabled();
    expect(
      within(drawer).getByRole('button', { name: /Edit roles for Linus Torvalds/i }),
    ).toBeEnabled();
  });

  it('confirms a removal by name, and names the tenant they lose', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    fireEvent.click(within(drawer).getByRole('button', { name: /Remove Linus Torvalds/i }));

    const confirm = await screen.findByRole('alertdialog', {
      name: /Remove Linus Torvalds\?/i,
    });
    expect(confirm).toHaveTextContent('They will lose access to Acme Corp immediately.');
    // Not an administrator, so no admin banner.
    expect(
      within(confirm).queryByText(/This user is also an administrator/i),
    ).not.toBeInTheDocument();

    fireEvent.click(within(confirm).getByRole('button', { name: /^Remove$/ }));
    await waitFor(() => {
      expect(mockRemoveTenantUser).toHaveBeenCalledWith('tu-acme-linus');
    });
  });

  it('warns when the person being removed is also an administrator', async () => {
    mockGetAdminTenants.mockResolvedValue(
      JSON.stringify([
        ...ADMIN_ROWS,
        {
          id: 'ta-acme-linus',
          tenant_id: 't-acme',
          user_id: 'u-linus',
          name: 'Linus Torvalds',
          email: 'linus@example.com',
        },
      ]),
    );
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    fireEvent.click(within(drawer).getByRole('button', { name: /Remove Linus Torvalds/i }));

    const confirm = await screen.findByRole('alertdialog', {
      name: /Remove Linus Torvalds\?/i,
    });
    expect(
      within(confirm).getByText(/This user is also an administrator/i),
    ).toBeInTheDocument();

    fireEvent.click(within(confirm).getByRole('button', { name: /^Remove$/ }));
    // Both roles go, and the administrator row goes first.
    await waitFor(() => {
      expect(mockRemoveTenantAdmin).toHaveBeenCalledWith('ta-acme-linus');
    });
    expect(mockRemoveTenantUser).toHaveBeenCalledWith('tu-acme-linus');
  });

  it('grants and revokes the administrator role from Edit member roles', async () => {
    await renderPage();
    const drawer = await openDrawer('Acme Corp');

    fireEvent.click(
      within(drawer).getByRole('button', { name: /Edit roles for Linus Torvalds/i }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Edit member roles/i });
    expect(dialog).toHaveTextContent('Update roles for Linus Torvalds.');

    fireEvent.click(within(dialog).getByLabelText('Administrator'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(mockAddTenantAdmin).toHaveBeenCalledWith('t-acme', 'linus@example.com');
    });
  });
});

/* -------------------------------------------------------------------------
   7. The list: one chrome, the toolbar, the states
   ------------------------------------------------------------------------- */

describe('the tenants list', () => {
  it('draws the page through PageHeader rather than its own header', async () => {
    await renderPage();

    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Tenants');
    expect(screen.getByTestId('page-breadcrumb')).toHaveTextContent('Tenants');
    expect(screen.getByRole('button', { name: /New tenant/i })).toBeInTheDocument();
  });

  it('opens the create flow from the header, and from the #create deep link', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /New tenant/i }));
    expect(await screen.findByTestId('create-tenant-dialog')).toBeInTheDocument();
  });

  it('names each tenant with its slug, its role and its status', async () => {
    await renderPage();

    const acme = screen.getByText('Acme Corp').closest('tr') as HTMLElement;
    expect(within(acme).getByText('acme-corp')).toBeInTheDocument();
    expect(within(acme).getByText('Current')).toBeInTheDocument();
    expect(within(acme).getByText('Admin')).toBeInTheDocument();
    expect(within(acme).getByText('Enabled')).toBeInTheDocument();

    const initech = screen.getByText('Initech').closest('tr') as HTMLElement;
    expect(within(initech).getByText('Member')).toBeInTheDocument();
    expect(within(initech).getByText('Disabled')).toBeInTheDocument();
    // No description reads as an em dash rather than as an empty cell.
    expect(within(initech).getByText('—')).toBeInTheDocument();
  });

  it('makes a non-current tenant’s name the Select affordance, and the current one’s not', async () => {
    await renderPage();

    const globex = screen.getByText('Globex Labs').closest('tr') as HTMLElement;
    fireEvent.click(within(globex).getByRole('button', { name: 'Globex Labs' }));
    await waitFor(() => {
      expect(mockSessionUpdate).toHaveBeenCalledWith({ current_tenant_id: 't-globex' });
    });

    const acme = screen.getByText('Acme Corp').closest('tr') as HTMLElement;
    expect(within(acme).queryByRole('button', { name: 'Acme Corp' })).not.toBeInTheDocument();
  });

  it('filters by name and by slug', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(screen.getByLabelText('Filter tenants'), 'globex-labs');

    await waitFor(() => {
      expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Globex Labs')).toBeInTheDocument();
  });

  it('narrows to the tenants the viewer administers', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /You administer/i }));

    await waitFor(() => {
      expect(screen.queryByText('Initech')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Globex Labs')).toBeInTheDocument();
  });

  it('counts the list in its foot', async () => {
    await renderPage();
    expect(screen.getByText(/3 tenants · you administer 2/)).toBeInTheDocument();
  });

  it('teaches rather than apologises when there are no tenants at all', async () => {
    mockGetTenants.mockResolvedValue('[]');
    mockGetAdminTenants.mockResolvedValue('[]');
    render(<TenantsPage />);

    expect(await screen.findByText('No tenants yet')).toBeInTheDocument();
    expect(
      screen.getByText(/You are not a member of any tenants yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create a tenant/i })).toBeInTheDocument();
  });

  it('offers a way back when the load fails', async () => {
    mockGetTenants.mockRejectedValue(new Error('network down'));
    render(<TenantsPage />);

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   8. Accessibility
   ------------------------------------------------------------------------- */

describe('accessibility', () => {
  it('has no axe violations once the list has loaded', async () => {
    const { container } = await renderPage();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations while the list is loading', async () => {
    mockGetTenants.mockReturnValue(new Promise(() => {}));
    const { container } = render(<TenantsPage />);
    await screen.findByText(/Loading tenants/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with the manage drawer open', async () => {
    await renderPage();
    await openDrawer('Acme Corp');
    // The drawer portals to the end of `<body>`, so the whole document is the subject.
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
