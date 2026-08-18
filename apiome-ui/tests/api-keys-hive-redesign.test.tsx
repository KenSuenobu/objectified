/**
 * The API keys redesign, rendered (HIVE-5.4, #5307).
 *
 * `api-keys-model.test.ts` holds the derivations; this holds the screen that makes them,
 * against a mocked `lib/db/helper` returning the JSON envelopes those server actions really
 * answer with. What it pins is the ticket's four acceptance criteria and the mockup's
 * **Keeps (1:1)** list:
 *
 *   1. **The secret is shown exactly once, with copy, and cannot be re-revealed.** Asserted
 *      as a property of the screen: after the reveal dialog is acknowledged, the plaintext
 *      key is nowhere in the document, and no control anywhere brings it back.
 *   2. **Scope presets produce the same scope strings as today.** Asserted at the boundary —
 *      what the chosen card actually sends to `createApiKey`.
 *   3. **Expired and revoked keys are visually distinct and non-actionable.** The row carries
 *      its tint class, and the expired key's switch is disabled.
 *   4. **The prefix is monospace and copyable.** Both, and what lands on the clipboard is the
 *      characters rather than the ellipsis the cell draws.
 *
 * Plus the two things the screen this replaces got wrong: a failed write reported to nothing
 * but the console, and a failed *read* drawn as "No API Keys Yet".
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

/** The workspace the session is in. */
const TENANT_ID = 't-acme';

/** Every call the mocked server actions saw, so a test can assert what reached the database. */
interface RecordedCall {
  fn: string;
  args: unknown[];
}

const calls: RecordedCall[] = [];

/** What `getApiKeysForTenant` answers with next. Reassigned per test. */
let keysResponse: string = '[]';
/** What `createApiKey` answers with next. */
let createResponse: string = '';
/** What `deleteApiKey` answers with next. */
let deleteResponse = JSON.stringify({ success: true });
/** What `toggleApiKeyStatus` answers with next. */
let toggleResponse = JSON.stringify({ success: true });

jest.mock('../lib/db/helper', () => ({
  getApiKeysForTenant: jest.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'getApiKeysForTenant', args });
    return keysResponse;
  }),
  createApiKey: jest.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'createApiKey', args });
    return createResponse;
  }),
  deleteApiKey: jest.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'deleteApiKey', args });
    return deleteResponse;
  }),
  toggleApiKeyStatus: jest.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'toggleApiKeyStatus', args });
    return toggleResponse;
  }),
}));

// The page answers the command palette's `?open=new-api-key` (HIVE-3.6), which needs the app
// router. Nothing here exercises navigation, so the three hooks are stubs.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/ade/dashboard/api-keys',
  useSearchParams: () => new URLSearchParams(),
}));

/** The signed-in user the page sees. Reassigned by the no-workspace test. */
let mockSessionUser: Record<string, unknown> = {
  user_id: 'u-ada',
  email: 'ada@acme.io',
  current_tenant_id: TENANT_ID,
};

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: mockSessionUser },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@lib/auth/tenant-membership-context', () => ({
  loadTenantMembershipContext: jest.fn(async () => ({
    tenants: [{ id: 't-acme', name: 'Acme Corp', slug: 'acme' }],
    adminTenantIds: ['t-acme'],
    createTenant: null,
  })),
}));

import ApiKeysClient from '../src/app/ade/dashboard/api-keys/ApiKeysClient';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/** Far enough in the past that no clock this suite runs on disagrees it has expired. */
const LONG_EXPIRED = '2020-01-01T00:00:00Z';
/** Far enough ahead that it is neither expired nor inside the 14-day warning window. */
const FAR_FUTURE = '2099-01-02T00:00:00Z';

const KEYS = [
  {
    id: 'k-active',
    tenant_id: TENANT_ID,
    name: 'CI contract gate',
    description: 'GitHub Actions job that blocks merges on breaking classified diffs.',
    key_prefix: 'sk_9f31c2Qm...',
    scopes: ['diff:read'],
    last_used_at: '2026-08-15T08:02:00Z',
    expires_at: FAR_FUTURE,
    enabled: true,
    created_at: '2026-07-02T10:14:00Z',
    updated_at: '2026-07-02T10:14:00Z',
  },
  {
    id: 'k-disabled',
    tenant_id: TENANT_ID,
    name: 'Nightly lint',
    description: 'Cron reads catalog + MCP lint gates every night at 02:00 UTC.',
    key_prefix: 'sk_2ab7e0Zz...',
    scopes: ['lint:read'],
    last_used_at: '2026-08-10T02:00:00Z',
    expires_at: null,
    enabled: false,
    created_at: '2026-06-18T15:41:00Z',
    updated_at: '2026-06-18T15:41:00Z',
  },
  {
    id: 'k-expired',
    tenant_id: TENANT_ID,
    name: 'Partner sync',
    description: 'Legacy integration used by Globex to mirror published specs.',
    key_prefix: 'sk_c41d88Aa...',
    scopes: ['*'],
    last_used_at: '2026-07-31T23:58:00Z',
    expires_at: LONG_EXPIRED,
    enabled: true,
    created_at: '2026-02-01T09:00:00Z',
    updated_at: '2026-02-01T09:00:00Z',
  },
  {
    id: 'k-both',
    tenant_id: TENANT_ID,
    name: 'Terraform',
    description: 'Plan-time contract + lint checks in the platform IaC pipeline.',
    key_prefix: 'sk_77e0a1Bb...',
    scopes: ['diff:read', 'lint:read'],
    last_used_at: null,
    expires_at: FAR_FUTURE,
    enabled: true,
    created_at: '2026-08-14T16:22:00Z',
    updated_at: '2026-08-14T16:22:00Z',
  },
];

/** The plaintext key the create path reveals. */
const SECRET = 'sk_9f31c2Qm7ZtR4vB8kW2xLp0sD6hN1yE3cU5aJ';

/** What the clipboard was last handed. */
let clipboardText: string | null = null;
/** Whether the next clipboard write is refused, for the failure path. */
let clipboardFails = false;

/**
 * Put the recording clipboard on `navigator`.
 *
 * Called again after every `userEvent.setup()`: user-event installs a clipboard stub of its
 * own on setup, which would otherwise swallow the writes these tests are about.
 */
function stubClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: jest.fn(async (text: string) => {
        if (clipboardFails) throw new Error('denied');
        clipboardText = text;
      }),
    },
  });
}

beforeEach(() => {
  calls.length = 0;
  keysResponse = JSON.stringify(KEYS);
  createResponse = JSON.stringify({
    success: true,
    apiKey: SECRET,
    id: 'k-new',
    keyPrefix: 'sk_9f31c2Qm...',
    scopes: ['diff:read'],
  });
  deleteResponse = JSON.stringify({ success: true });
  toggleResponse = JSON.stringify({ success: true });
  clipboardText = null;
  clipboardFails = false;
  mockSessionUser = { user_id: 'u-ada', email: 'ada@acme.io', current_tenant_id: TENANT_ID };
  stubClipboard();
});

afterEach(() => {
  jest.clearAllMocks();
});

/**
 * Render the page and wait for the first read.
 *
 * @returns A `userEvent` session.
 */
async function renderApiKeys() {
  const user = userEvent.setup();
  stubClipboard();
  render(<ApiKeysClient />);
  await screen.findByText('CI contract gate');
  return { user };
}

/**
 * The `<tr>` one key's row lives in.
 *
 * `DataTable` writes a row's attributes itself and takes no per-row escape hatch, so the
 * handle sits on the Name cell — the same departure `MembersTable` documents.
 *
 * @param name The key's name.
 * @returns The row element.
 */
function rowFor(name: string): HTMLElement {
  const cell = document.querySelector(`[data-api-key-name="${name}"]`);
  if (!cell) throw new Error(`No row for ${name}`);
  const row = cell.closest('tr');
  if (!row) throw new Error(`Row for ${name} is not in a table`);
  return row as HTMLElement;
}

/**
 * Open the create dialog and fill in a name.
 *
 * @param user The `userEvent` session.
 * @param name What to call the key.
 */
async function openCreateDialog(user: ReturnType<typeof userEvent.setup>, name = 'Release pipeline') {
  await user.click(screen.getByTestId('api-keys-create'));
  const dialog = await screen.findByTestId('api-key-create-dialog');
  await user.type(within(dialog).getByLabelText(/^Name/), name);
  return dialog;
}

/* -------------------------------------------------------------------------
   1. The page
   ------------------------------------------------------------------------- */

describe('the API keys page', () => {
  it('leads with the page chrome the design language asks for', async () => {
    await renderApiKeys();

    expect(screen.getByRole('heading', { level: 1, name: 'API keys' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(
      screen.getByText('Keys for external REST access. Prefer scoped CI tokens for pipelines.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /API docs/ })).toHaveAttribute(
      'href',
      '/ade/dashboard/help'
    );
  });

  it('names the workspace in the breadcrumb once its membership context resolves', async () => {
    await renderApiKeys();
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Acme Corp')
      ).toBeInTheDocument()
    );
  });

  it('reads only the tenant in the session', async () => {
    await renderApiKeys();
    expect(calls.filter((call) => call.fn === 'getApiKeysForTenant')).toHaveLength(1);
    expect(calls[0].args).toEqual([TENANT_ID]);
  });

  it('counts the keys by status in the table foot', async () => {
    await renderApiKeys();
    expect(screen.getByTestId('api-keys-summary')).toHaveTextContent(
      '4 keys · 2 active · 1 disabled · 1 expired'
    );
  });
});

/* -------------------------------------------------------------------------
   2. The table
   ------------------------------------------------------------------------- */

describe('the keys table', () => {
  it('draws the nine columns the mockup keeps', async () => {
    await renderApiKeys();
    const table = screen.getByTestId('api-keys-table');
    for (const header of [
      'Name',
      'Prefix',
      'Scopes',
      'Status',
      'Last used',
      'Created',
      'Expires',
      'Enabled',
    ]) {
      expect(within(table).getByRole('columnheader', { name: new RegExp(header) })).toBeInTheDocument();
    }
    expect(within(table).getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
  });

  it('prints the prefix once, in monospace, and copies it without the ellipsis', async () => {
    const { user } = await renderApiKeys();
    const row = rowFor('CI contract gate');

    const prefix = within(row).getByText('sk_9f31c2Qm…');
    expect(prefix).toHaveClass('mono');
    expect(prefix.textContent).not.toContain('...');

    await user.click(within(row).getByRole('button', { name: /Copy the prefix of CI contract gate/ }));
    await waitFor(() => expect(clipboardText).toBe('sk_9f31c2Qm'));
  });

  it('says "Full access" for a * key and draws a badge per scope otherwise', async () => {
    await renderApiKeys();
    expect(within(rowFor('Partner sync')).getByText('Full access')).toBeInTheDocument();

    const terraform = rowFor('Terraform');
    expect(within(terraform).getByText('diff:read')).toBeInTheDocument();
    expect(within(terraform).getByText('lint:read')).toBeInTheDocument();
  });

  it('gives each status its own badge from the shared vocabulary', async () => {
    await renderApiKeys();
    expect(within(rowFor('CI contract gate')).getByText('Active')).toBeInTheDocument();
    expect(within(rowFor('Nightly lint')).getByText('Disabled')).toBeInTheDocument();
    expect(within(rowFor('Partner sync')).getByText('Expired')).toBeInTheDocument();
  });

  it('tints an expired row and a disabled row differently', async () => {
    await renderApiKeys();
    expect(rowFor('Partner sync')).toHaveClass('akey-row--expired');
    expect(rowFor('Nightly lint')).toHaveClass('akey-row--disabled');
    expect(rowFor('CI contract gate').className).not.toMatch(/akey-row--/);
  });

  it('leaves an expired key non-actionable — its switch is inert and says why', async () => {
    await renderApiKeys();
    const toggle = screen.getByTestId('api-key-toggle-k-expired');
    expect(toggle).toBeDisabled();
    expect(toggle.closest('.akey-toggle')).toHaveAttribute(
      'title',
      expect.stringMatching(/expired/i)
    );
  });

  it('still offers Delete on the expired key, which is what the banner asks for', async () => {
    await renderApiKeys();
    expect(screen.getByTestId('api-key-delete-k-expired')).toBeEnabled();
  });

  it('narrows by name and by a prefix pasted out of a log', async () => {
    const { user } = await renderApiKeys();
    const filter = screen.getByLabelText('Filter API keys');

    await user.type(filter, 'terraform');
    await waitFor(() => expect(screen.queryByText('CI contract gate')).not.toBeInTheDocument());
    expect(screen.getByText('Terraform')).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, 'sk_c41d88');
    await waitFor(() => expect(screen.getByText('Partner sync')).toBeInTheDocument());
    expect(screen.queryByText('Terraform')).not.toBeInTheDocument();
  });

  it('narrows by status chip', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByRole('button', { name: /^Expired/ }));
    await waitFor(() => expect(screen.queryByText('Terraform')).not.toBeInTheDocument());
    expect(screen.getByText('Partner sync')).toBeInTheDocument();
  });

  it('offers a way back when a filter leaves nothing', async () => {
    const { user } = await renderApiKeys();
    await user.type(screen.getByLabelText('Filter API keys'), 'nothing matches this');
    expect(await screen.findByText('No API keys match these filters')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('CI contract gate')).toBeInTheDocument();
  });

  it('draws the in-card empty state, not a claim about the workspace, when the read fails', async () => {
    keysResponse = 'not json at all';
    render(<ApiKeysClient />);

    expect(await screen.findByText('Failed to load API keys')).toBeInTheDocument();
    expect(screen.queryByText('No API keys yet')).not.toBeInTheDocument();
  });

  it('says "No API keys yet" only when there really are none', async () => {
    keysResponse = '[]';
    render(<ApiKeysClient />);
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   3. Creating a key, and the one look at its secret
   ------------------------------------------------------------------------- */

describe('creating a key', () => {
  it('keeps the four fields, their copy and the name message', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-keys-create'));
    const dialog = await screen.findByTestId('api-key-create-dialog');

    expect(within(dialog).getByPlaceholderText('My API Key')).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText('What is this key used for?')).toBeInTheDocument();
    expect(within(dialog).getByText('A descriptive name for this API key')).toBeInTheDocument();
    expect(within(dialog).getByRole('radiogroup', { name: 'Scopes' })).toBeInTheDocument();
    // The visible labels are really associated with their controls, rather than sitting
    // beside them: `getByLabelText` only finds a control its label points at.
    expect(within(dialog).getByLabelText(/^Name/)).toHaveAttribute('id', 'api-key-name');
    expect(within(dialog).getByLabelText('Description')).toHaveAttribute(
      'id',
      'api-key-description'
    );

    await user.click(within(dialog).getByRole('button', { name: 'Create API key' }));
    expect(await screen.findByTestId('api-key-create-error')).toHaveTextContent(
      'API key name is required'
    );
    expect(calls.some((call) => call.fn === 'createApiKey')).toBe(false);
  });

  it('offers the four presets as cards carrying their scope strings', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-keys-create'));
    const dialog = await screen.findByTestId('api-key-create-dialog');

    for (const preset of ['full', 'diff', 'lint', 'ci_both']) {
      expect(within(dialog).getByTestId(`api-key-scope-${preset}`)).toBeInTheDocument();
    }
    // Full access is the default, as it was before this ticket.
    expect(within(within(dialog).getByTestId('api-key-scope-full')).getByRole('radio')).toBeChecked();
    expect(
      within(within(dialog).getByTestId('api-key-scope-ci_both')).getByText('diff:read')
    ).toBeInTheDocument();
  });

  it('sends the chosen preset scope strings, unchanged, to the server', async () => {
    const { user } = await renderApiKeys();
    const dialog = await openCreateDialog(user);

    await user.click(within(within(dialog).getByTestId('api-key-scope-ci_both')).getByRole('radio'));
    await user.type(within(dialog).getByLabelText('Expires in (days)'), '90');
    await user.click(within(dialog).getByRole('button', { name: 'Create API key' }));

    await screen.findByTestId('api-key-secret-dialog');
    const created = calls.find((call) => call.fn === 'createApiKey');
    expect(created?.args).toEqual([
      TENANT_ID,
      'Release pipeline',
      '',
      90,
      ['diff:read', 'lint:read'],
    ]);
  });

  it('sends no expiry when the box is left empty', async () => {
    const { user } = await renderApiKeys();
    const dialog = await openCreateDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create API key' }));

    await screen.findByTestId('api-key-secret-dialog');
    expect(calls.find((call) => call.fn === 'createApiKey')?.args[3]).toBeNull();
  });

  it('refuses an expiry the helper would silently turn into "never"', async () => {
    const { user } = await renderApiKeys();
    const dialog = await openCreateDialog(user);
    await user.type(within(dialog).getByLabelText('Expires in (days)'), '-5');
    await user.click(within(dialog).getByRole('button', { name: 'Create API key' }));

    expect(await screen.findByTestId('api-key-create-error')).toHaveTextContent(/whole number/);
    expect(calls.some((call) => call.fn === 'createApiKey')).toBe(false);
  });

  it('shows the server refusal in the dialog, and keeps what was typed', async () => {
    createResponse = JSON.stringify({
      success: false,
      error: 'An API key with this name already exists for this tenant',
    });
    const { user } = await renderApiKeys();
    const dialog = await openCreateDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create API key' }));

    expect(await screen.findByTestId('api-key-create-error')).toHaveTextContent(
      'An API key with this name already exists for this tenant'
    );
    expect(screen.getByTestId('api-key-create-dialog')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Release pipeline');
  });
});

describe('the reveal-once secret', () => {
  /**
   * Create a key and get to the reveal dialog.
   *
   * @returns The `userEvent` session and the dialog.
   */
  async function reveal() {
    const { user } = await renderApiKeys();
    const dialog = await openCreateDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create API key' }));
    return { user, secretDialog: await screen.findByTestId('api-key-secret-dialog') };
  }

  it('shows the key, the warning and what the list will show from now on', async () => {
    const { secretDialog } = await reveal();

    expect(within(secretDialog).getByTestId('api-key-secret-value')).toHaveTextContent(SECRET);
    expect(within(secretDialog).getByTestId('api-key-secret-warning')).toHaveTextContent(
      "This is the only time you'll see this API key"
    );
    expect(within(secretDialog).getByTestId('api-key-secret-summary')).toHaveTextContent(
      '“Release pipeline” · scope full access · expires never'
    );
    expect(within(secretDialog).getByText('sk_9f31c2Qm…')).toBeInTheDocument();
  });

  it('copies the key, and only says so once the write resolved', async () => {
    const { user, secretDialog } = await reveal();

    await user.click(within(secretDialog).getByTestId('api-key-secret-copy'));
    await waitFor(() => expect(clipboardText).toBe(SECRET));
    expect(await within(secretDialog).findByText('Copied!')).toBeInTheDocument();
  });

  it('does not claim a copy that failed, and says what to do instead', async () => {
    clipboardFails = true;
    const { user, secretDialog } = await reveal();

    await user.click(within(secretDialog).getByTestId('api-key-secret-copy'));
    expect(await screen.findByTestId('api-key-secret-copy-error')).toBeInTheDocument();
    expect(within(secretDialog).queryByText('Copied!')).not.toBeInTheDocument();
  });

  it('cannot be dismissed by Escape — the acknowledgement is the only way out', async () => {
    const { user, secretDialog } = await reveal();

    await user.keyboard('{Escape}');
    expect(secretDialog).toBeInTheDocument();
    expect(screen.getByTestId('api-key-secret-value')).toHaveTextContent(SECRET);
  });

  it('offers no close cross, so the key cannot be dropped by a mis-click', async () => {
    const { secretDialog } = await reveal();
    expect(within(secretDialog).queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('shows the key exactly once — acknowledging it puts the plaintext beyond reach', async () => {
    const { user, secretDialog } = await reveal();

    await user.click(within(secretDialog).getByTestId('api-key-secret-ack'));
    await waitFor(() =>
      expect(screen.queryByTestId('api-key-secret-dialog')).not.toBeInTheDocument()
    );

    // The criterion, asserted as a property of the whole document rather than of one node:
    // nothing anywhere still carries the plaintext, and no control offers it again.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByTestId('api-key-secret-value')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument();

    // Re-opening the create dialog does not bring it back either.
    await user.click(screen.getByTestId('api-keys-create'));
    await screen.findByTestId('api-key-create-dialog');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('reloads the list once the key exists', async () => {
    await reveal();
    expect(calls.filter((call) => call.fn === 'getApiKeysForTenant').length).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------
   4. Disabling, enabling and deleting
   ------------------------------------------------------------------------- */

describe('the enable switch', () => {
  it('confirms before disabling, naming the key and its prefix', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-toggle-k-active'));

    const dialog = await screen.findByTestId('api-key-disable-dialog');
    expect(dialog).toHaveTextContent('Are you sure you want to disable “CI contract gate”?');
    expect(dialog).toHaveTextContent('This will immediately block all requests using this key.');
    expect(within(dialog).getByText('sk_9f31c2Qm…')).toBeInTheDocument();
    expect(calls.some((call) => call.fn === 'toggleApiKeyStatus')).toBe(false);
  });

  it('writes only once the confirm is pressed', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-toggle-k-active'));
    await user.click(await screen.findByTestId('api-key-disable-confirm'));

    await waitFor(() =>
      expect(calls.find((call) => call.fn === 'toggleApiKeyStatus')?.args).toEqual([
        'k-active',
        false,
      ])
    );
  });

  it('leaves the key alone when the confirm is cancelled', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-toggle-k-active'));
    const dialog = await screen.findByTestId('api-key-disable-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByTestId('api-key-disable-dialog')).not.toBeInTheDocument()
    );
    expect(calls.some((call) => call.fn === 'toggleApiKeyStatus')).toBe(false);
  });

  it('enables immediately, because that is the reversible direction', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-toggle-k-disabled'));

    await waitFor(() =>
      expect(calls.find((call) => call.fn === 'toggleApiKeyStatus')?.args).toEqual([
        'k-disabled',
        true,
      ])
    );
    expect(screen.queryByTestId('api-key-disable-dialog')).not.toBeInTheDocument();
  });

  it('reports a refused enable in the page banner, which has a retry', async () => {
    toggleResponse = JSON.stringify({ success: false, error: 'The key is managed by SSO' });
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-toggle-k-disabled'));

    // Enabling is the one write with no dialog open to report into, so it reports here.
    const banner = await screen.findByTestId('api-keys-error');
    expect(banner).toHaveTextContent('The key is managed by SSO');
    expect(within(banner).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // And it does not blank the table the way a *load* failure does.
    expect(screen.getByText('CI contract gate')).toBeInTheDocument();
  });

  it('reports a refused disable in the dialog rather than to the console', async () => {
    toggleResponse = JSON.stringify({ success: false, error: 'The key is managed by SSO' });
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-toggle-k-active'));
    await user.click(await screen.findByTestId('api-key-disable-confirm'));

    const dialog = await screen.findByTestId('api-key-disable-dialog');
    expect(await within(dialog).findByText('The key is managed by SSO')).toBeInTheDocument();
  });
});

describe('deleting a key', () => {
  it('confirms with the copy the screen this replaces used, plus what it costs', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-delete-k-expired'));

    const dialog = await screen.findByTestId('api-key-delete-dialog');
    expect(dialog).toHaveTextContent(
      'Are you sure you want to delete the API key “Partner sync”? This action cannot be undone.'
    );
    expect(within(dialog).getByTestId('api-key-delete-warning')).toHaveTextContent(/401/);
    expect(calls.some((call) => call.fn === 'deleteApiKey')).toBe(false);
  });

  it('deletes only the key the row was about', async () => {
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-delete-k-expired'));
    await user.click(await screen.findByTestId('api-key-delete-confirm'));

    await waitFor(() =>
      expect(calls.find((call) => call.fn === 'deleteApiKey')?.args).toEqual(['k-expired'])
    );
  });

  it('reports a refused delete inline and keeps the dialog open', async () => {
    deleteResponse = JSON.stringify({ success: false, error: 'The key is still in use' });
    const { user } = await renderApiKeys();
    await user.click(screen.getByTestId('api-key-delete-k-expired'));
    await user.click(await screen.findByTestId('api-key-delete-confirm'));

    const dialog = await screen.findByTestId('api-key-delete-dialog');
    expect(await within(dialog).findByText('The key is still in use')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   5. The banner, the reference cards and the no-workspace state
   ------------------------------------------------------------------------- */

describe('the expiry banner', () => {
  it('names the expired key and offers the replacement', async () => {
    const { user } = await renderApiKeys();
    const banner = screen.getByTestId('api-keys-expiry-banner');
    expect(banner).toHaveTextContent('“Partner sync” expired');
    expect(banner).toHaveTextContent('create a replacement and delete the old one');

    await user.click(within(banner).getByRole('button', { name: /Create replacement/ }));
    expect(await screen.findByTestId('api-key-create-dialog')).toBeInTheDocument();
  });

  it('says nothing when every key is healthy', async () => {
    keysResponse = JSON.stringify([KEYS[0], KEYS[3]]);
    render(<ApiKeysClient />);
    await screen.findByText('CI contract gate');
    expect(screen.queryByTestId('api-keys-expiry-banner')).not.toBeInTheDocument();
  });
});

describe('the reference cards', () => {
  it('shows how to send a key, and counts this workspace scopes', async () => {
    await renderApiKeys();
    const reference = screen.getByTestId('api-keys-reference');

    expect(within(reference).getByTestId('api-keys-example-request')).toHaveTextContent(
      'Authorization: Bearer'
    );
    expect(within(reference).getByTestId('api-key-scope-count-full')).toHaveTextContent('1');
    expect(within(reference).getByTestId('api-key-scope-count-diff:read')).toHaveTextContent('2');
    expect(within(reference).getByTestId('api-key-scope-count-lint:read')).toHaveTextContent('2');
  });

  it('names the workspace a key runs as', async () => {
    await renderApiKeys();
    await waitFor(() =>
      expect(screen.getByTestId('api-keys-reference')).toHaveTextContent('Acme Corp')
    );
  });
});

describe('without a workspace', () => {
  it('asks for one instead of reading keys', async () => {
    mockSessionUser = { user_id: 'u-ada', email: 'ada@acme.io' };

    render(<ApiKeysClient />);

    expect(await screen.findByTestId('api-keys-no-tenant')).toBeInTheDocument();
    expect(screen.getByText('No workspace selected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to Workspaces/ })).toHaveAttribute(
      'href',
      '/ade/dashboard/tenants'
    );
    expect(calls.some((call) => call.fn === 'getApiKeysForTenant')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   6. No native dialog is left anywhere on this screen
   ------------------------------------------------------------------------- */

describe('the native dialogs this screen used to be able to reach', () => {
  it('never fires one, on any of the three decisions', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const { user } = await renderApiKeys();

    await user.click(screen.getByTestId('api-key-toggle-k-active'));
    await user.click(await screen.findByTestId('api-key-disable-confirm'));
    await user.click(screen.getByTestId('api-key-delete-k-expired'));
    await user.click(await screen.findByTestId('api-key-delete-confirm'));

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
