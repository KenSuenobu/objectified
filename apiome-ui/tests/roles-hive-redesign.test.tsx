/**
 * The Roles redesign, rendered (HIVE-5.3, #5306).
 *
 * `roles-model.test.ts` holds the decisions; this holds the screen that makes them, against a
 * mocked `/api/access/*` returning the documented `{success, data}` envelopes. What it pins is
 * the ticket's four acceptance criteria and the mockup's **Keeps (1:1)** list:
 *
 *   1. **Matrix cells are real toggle buttons** with `aria-pressed` and an accessible name of
 *      their own — 65 of them, plus the thirteen row toggles that carry the `mixed` state.
 *   2. **Built-in roles cannot be renamed or deleted, and the reason is stated** — while an
 *      administrator can still tune their grid, which is what the server allows.
 *   3. **Navigating away with unsaved changes prompts** — switching role, creating one and
 *      duplicating one all go through the same guard, which can discard or save.
 *   4. **Delete names the role and states the member impact**, from the roster rather than
 *      from a count.
 *
 * Plus the two things the screen this replaces got wrong: it destroyed a draft silently, and
 * it asked for a name through a dialog that could hold nothing but a name.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import RolesClient from '../src/app/ade/dashboard/roles/RolesClient';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const ROLES = [
  {
    id: 'role-owner',
    slug: 'owner',
    name: 'Owner',
    description: 'Full control of the workspace.',
    is_builtin: true,
    member_count: 1,
    permissions: [
      { resource: 'projects', action: 'view' },
      { resource: 'versions', action: 'view' },
    ],
  },
  {
    id: 'role-rm',
    slug: 'release-manager',
    name: 'Release manager',
    description: 'Cuts and publishes versions.',
    is_builtin: false,
    member_count: 2,
    permissions: [
      { resource: 'versions', action: 'view' },
      { resource: 'versions', action: 'publish' },
    ],
  },
  {
    id: 'role-auditor',
    slug: 'auditor',
    name: 'Auditor',
    description: 'Reads everything, changes nothing.',
    is_builtin: false,
    member_count: 0,
    permissions: [],
  },
];

const MEMBERS = [
  {
    user_id: 'u-linus',
    name: 'Linus Torvalds',
    email: 'linus@acme.io',
    status: 'active',
    member_since: '2026-01-01T12:00:00Z',
    role_id: 'role-rm',
    role_name: 'Release manager',
    role_slug: 'release-manager',
    is_admin: false,
  },
  {
    user_id: 'u-margaret',
    name: 'Margaret Hamilton',
    email: 'margaret@acme.io',
    status: 'active',
    member_since: '2026-02-01T12:00:00Z',
    role_id: 'role-rm',
    role_name: 'Release manager',
    role_slug: 'release-manager',
    is_admin: false,
  },
];

const PERMS_ADMIN = { is_admin: true, permissions: [] as string[] };
const PERMS_VIEWER = { is_admin: false, permissions: ['members:view'] };

/** Every call the mocked transport saw, so a test can assert what reached the API. */
interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** How one mocked screen is configured. */
interface MockOptions {
  /** The `permissions/me` payload. */
  perms?: { is_admin: boolean; permissions: string[] };
  /** The roles the API returns. */
  roles?: typeof ROLES;
  /** Make the roles read fail, so the page's error banner is reachable. */
  failRoles?: boolean;
  /** Make the roster read fail, so the delete confirm's fallback is reachable. */
  failMembers?: boolean;
  /** Fail one write, keyed by a substring of `${method} ${url}`. */
  failWrite?: { match: string; error: string };
}

/**
 * Build a `{success, data}` response.
 *
 * @param data The payload.
 * @returns A resolved `Response`-alike.
 */
function ok(data: unknown) {
  return Promise.resolve({
    status: 200,
    json: () => Promise.resolve({ success: true, data }),
  } as Response);
}

/**
 * Build a failure envelope.
 *
 * @param error The message the proxy reports.
 * @returns A resolved `Response`-alike.
 */
function fail(error: string) {
  return Promise.resolve({
    status: 500,
    json: () => Promise.resolve({ success: false, error }),
  } as Response);
}

/**
 * Point `global.fetch` at the fixtures and record every call.
 *
 * @param options See {@link MockOptions}.
 * @returns The recorded calls, which fill in as the screen works.
 */
function mockApi(options: MockOptions = {}): RecordedCall[] {
  const { perms = PERMS_ADMIN, roles = ROLES, failRoles, failMembers, failWrite } = options;
  const calls: RecordedCall[] = [];

  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    if (failWrite && `${method} ${url}`.includes(failWrite.match)) return fail(failWrite.error);
    if (url.includes('/api/access/permissions/me')) return ok(perms);
    if (url.includes('/api/access/members')) {
      return failMembers ? fail('The roster is unavailable') : ok(MEMBERS);
    }
    if (url.includes('/api/access/roles')) {
      if (method === 'GET') return failRoles ? fail('The access service did not answer') : ok(roles);
      if (method === 'DELETE') {
        return Promise.resolve({ status: 204, json: () => Promise.resolve({}) } as Response);
      }
      return ok({ ...roles[roles.length - 1], id: 'role-new', slug: 'new-role', name: 'New role' });
    }
    return ok([]);
  });

  // @ts-expect-error - assigning a test double to the global
  global.fetch = fn;
  return calls;
}

/** The native dialogs, spied on for the whole file: none of them may ever be reached. */
const nativeConfirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
const nativePrompt = jest.spyOn(window, 'prompt').mockReturnValue('x');

beforeEach(() => {
  nativeConfirm.mockClear();
  nativePrompt.mockClear();
});

afterEach(() => {
  jest.clearAllMocks();
});

/**
 * Render the page and wait for its first paint.
 *
 * @returns Nothing; the caller queries through `screen`.
 */
async function renderRoles() {
  render(<RolesClient />);
  await screen.findByRole('button', { name: 'Projects View' });
}

// ---------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------

describe('the permission matrix', () => {
  it('draws 65 cells as toggle buttons that name themselves', async () => {
    mockApi();
    await renderRoles();

    const matrix = screen.getByRole('table');
    const cells = within(matrix)
      .getAllByRole('button')
      .filter((button) => !button.getAttribute('aria-label')?.startsWith('All '));
    expect(cells).toHaveLength(65);

    // The first role is Owner, whose fixture grants `projects:view` and `versions:view`.
    expect(screen.getByRole('button', { name: 'Projects View' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Projects Create' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Verification evidence Publish' })).toBeEnabled();
  });

  it('heads five action columns and thirteen resource rows', async () => {
    mockApi();
    await renderRoles();

    const matrix = screen.getByRole('table');
    expect(within(matrix).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Resource',
      'View',
      'Create',
      'Edit',
      'Delete',
      'Publish',
    ]);
    expect(within(matrix).getAllByRole('rowheader')).toHaveLength(13);
    // The guard key is printed under each label, so a reader can match the row to the API.
    expect(within(matrix).getByText('verification_evidence')).toBeInTheDocument();
  });

  it('gives each row a tri-state toggle that reports mixed', async () => {
    mockApi();
    await renderRoles();

    const row = screen.getByRole('button', { name: 'All Projects permissions' });
    // Owner grants `projects:view` and nothing else on that resource.
    expect(row).toHaveAttribute('aria-pressed', 'mixed');

    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    for (const action of ['View', 'Create', 'Edit', 'Delete', 'Publish']) {
      expect(screen.getByRole('button', { name: `Projects ${action}` })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    }

    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'false');
  });

  it('counts what is on, and moves the count as cells are pressed', async () => {
    mockApi();
    await renderRoles();

    expect(screen.getByTestId('roles-cells-on')).toHaveTextContent('2 of 65 cells on');
    await userEvent.click(screen.getByRole('button', { name: 'Billing View' }));
    expect(screen.getByTestId('roles-cells-on')).toHaveTextContent('3 of 65 cells on');
  });

  it('grants view everywhere, and clears everything', async () => {
    mockApi();
    await renderRoles();

    await userEvent.click(screen.getByRole('button', { name: /Grant view on all/ }));
    expect(screen.getByTestId('roles-cells-on')).toHaveTextContent('13 of 65 cells on');

    await userEvent.click(screen.getByRole('button', { name: /Clear all/ }));
    expect(screen.getByTestId('roles-cells-on')).toHaveTextContent('0 of 65 cells on');
  });
});

// ---------------------------------------------------------------------------------------
// Built-in and read-only
// ---------------------------------------------------------------------------------------

describe('a built-in role', () => {
  it('is named by a heading, not a field, and says why', async () => {
    mockApi();
    await renderRoles();

    expect(screen.queryByLabelText('Role name')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.getByTestId('roles-lock-note')).toHaveTextContent(/keep their name/i);
  });

  it('offers no Delete', async () => {
    mockApi();
    await renderRoles();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
  });

  it('still lets an administrator tune its grid, which the server allows', async () => {
    mockApi();
    await renderRoles();
    expect(screen.getByRole('button', { name: 'Projects Create' })).toBeEnabled();
  });
});

describe('a viewer who may not change roles', () => {
  it('sees every toggle locked and the grant that would unlock them', async () => {
    mockApi({ perms: PERMS_VIEWER });
    await renderRoles();

    expect(screen.getByRole('button', { name: 'Projects View' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'All Projects permissions' })).toBeDisabled();
    expect(screen.getByTestId('roles-lock-note')).toHaveTextContent('members:edit');
    expect(screen.queryByTestId('roles-new')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Grant view on all/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The draft and its guard
// ---------------------------------------------------------------------------------------

describe('an edited draft', () => {
  it('announces itself in three places and counts what is pending', async () => {
    mockApi();
    await renderRoles();

    expect(screen.queryByTestId('roles-save-bar')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Billing View' }));
    await userEvent.click(screen.getByRole('button', { name: 'Billing Edit' }));

    expect(screen.getByTestId('roles-dirty-badge')).toHaveTextContent('Unsaved');
    expect(screen.getByTestId('roles-save-bar')).toHaveTextContent('2 unsaved changes');
    expect(screen.getByTestId('role-dirty-dot')).toBeInTheDocument();
  });

  it('is put back by Discard', async () => {
    mockApi();
    await renderRoles();

    await userEvent.click(screen.getByRole('button', { name: 'Billing View' }));
    await userEvent.click(within(screen.getByTestId('roles-save-bar')).getByText('Discard'));

    expect(screen.queryByTestId('roles-save-bar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Billing View' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('is saved as the whole grid, in the vocabulary order', async () => {
    const calls = mockApi();
    await renderRoles();

    await userEvent.click(screen.getByRole('button', { name: 'Billing View' }));
    await userEvent.click(screen.getByTestId('roles-save'));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toContain('/api/access/roles/role-owner');
    expect(put?.body).toEqual({
      name: 'Owner',
      description: 'Full control of the workspace.',
      permissions: [
        { resource: 'projects', action: 'view' },
        { resource: 'versions', action: 'view' },
        { resource: 'billing', action: 'view' },
      ],
    });
  });

  it('reports a failed save in the page banner, where the press came from', async () => {
    mockApi({ failWrite: { match: 'PUT', error: 'The access service refused the change' } });
    await renderRoles();

    await userEvent.click(screen.getByRole('button', { name: 'Billing View' }));
    await userEvent.click(screen.getByTestId('roles-save-bar-save'));

    expect(await screen.findByTestId('roles-error')).toHaveTextContent(
      'The access service refused the change'
    );
  });
});

describe('the unsaved-changes guard', () => {
  /**
   * Dirty the selected role, then ask for another one.
   *
   * @returns Nothing; the guard is open when it resolves.
   */
  async function dirtyThenSwitch() {
    await userEvent.click(screen.getByRole('button', { name: 'Billing View' }));
    await userEvent.click(screen.getByTestId('role-item-release-manager'));
    return screen.findByTestId('roles-unsaved-dialog');
  }

  it('asks before a switch throws the draft away, and names both roles', async () => {
    mockApi();
    await renderRoles();

    const dialog = await dirtyThenSwitch();
    expect(dialog).toHaveTextContent('1 unsaved change');
    expect(dialog).toHaveTextContent('Owner');
    expect(dialog).toHaveTextContent('Switching to Release manager resets the draft.');
    // Still on the role that was being edited. Found by test id rather than by role: Radix
    // marks everything behind an open dialog `aria-hidden`, so the page's own headings are
    // out of the accessibility tree while the guard is up.
    expect(screen.getByTestId('role-item-owner')).toHaveAttribute('aria-current', 'true');
  });

  it('stays put on Keep editing, with the draft intact', async () => {
    mockApi();
    await renderRoles();

    const dialog = await dirtyThenSwitch();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByTestId('roles-unsaved-dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.getByTestId('roles-save-bar')).toBeInTheDocument();
  });

  it('switches and forgets on Discard', async () => {
    const calls = mockApi();
    await renderRoles();

    const dialog = await dirtyThenSwitch();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.getByLabelText('Role name')).toHaveValue('Release manager'));
    expect(screen.queryByTestId('roles-save-bar')).not.toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('saves and then switches on Save and switch', async () => {
    const calls = mockApi();
    await renderRoles();

    const dialog = await dirtyThenSwitch();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and switch' }));

    await waitFor(() => expect(screen.getByLabelText('Role name')).toHaveValue('Release manager'));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toContain('role-owner');
  });

  it('guards creating a role too, because that also selects one', async () => {
    mockApi();
    await renderRoles();

    await userEvent.click(screen.getByRole('button', { name: 'Billing View' }));
    await userEvent.click(screen.getByTestId('roles-new'));

    const dialog = await screen.findByTestId('roles-unsaved-dialog');
    expect(dialog).toHaveTextContent('Leaving this role resets the draft.');
    // With no destination the primary says what it does rather than where it goes.
    expect(within(dialog).getByRole('button', { name: 'Save and continue' })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByTestId('roles-new-dialog')).toBeInTheDocument();
  });

  it('does not ask when there is nothing to lose', async () => {
    mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('role-item-auditor'));
    expect(screen.queryByTestId('roles-unsaved-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Role name')).toHaveValue('Auditor'));
  });
});

// ---------------------------------------------------------------------------------------
// The dialogs
// ---------------------------------------------------------------------------------------

describe('creating a role', () => {
  it('carries the grid of the role it copies from', async () => {
    const calls = mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('roles-new'));
    await userEvent.type(screen.getByLabelText('Name'), 'Release captain');
    await userEvent.selectOptions(
      screen.getByLabelText('Copy permissions from'),
      'role-rm'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Release captain',
      description: '',
      permissions: [
        { resource: 'versions', action: 'view' },
        { resource: 'versions', action: 'publish' },
      ],
    });
  });

  it('starts from nothing when no source is chosen', async () => {
    const calls = mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('roles-new'));
    await userEvent.type(screen.getByLabelText('Name'), 'Release captain');
    await userEvent.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ permissions: [] });
  });

  it('refuses a name another role already has, before it asks the server', async () => {
    const calls = mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('roles-new'));
    await userEvent.type(screen.getByLabelText('Name'), 'Auditor');
    await userEvent.click(screen.getByRole('button', { name: 'Create role' }));

    expect(
      within(screen.getByTestId('roles-new-dialog')).getByRole('alert')
    ).toHaveTextContent('A role named "Auditor" already exists.');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('duplicating a role', () => {
  it('prefills "(copy)" and posts to the duplicate endpoint', async () => {
    const calls = mockApi();
    await renderRoles();

    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    const dialog = await screen.findByTestId('roles-duplicate-dialog');
    expect(within(dialog).getByLabelText('Name for the duplicated role')).toHaveValue(
      'Owner (copy)'
    );

    await userEvent.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes('/duplicate'))).toBe(true)
    );
    expect(calls.find((call) => call.url.includes('/duplicate'))?.body).toEqual({
      name: 'Owner (copy)',
    });
  });
});

describe('deleting a role', () => {
  it('names the role and the members whose access changes', async () => {
    mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('role-item-release-manager'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByTestId('roles-delete-dialog');
    expect(dialog).toHaveTextContent('Delete the role “Release manager”?');
    expect(within(dialog).getByTestId('roles-delete-impact')).toHaveTextContent(
      'Linus Torvalds, Margaret Hamilton keep their accounts but lose every permission this role granted.'
    );
  });

  it('still states the impact when the roster could not be read', async () => {
    mockApi({ failMembers: true });
    await renderRoles();

    await userEvent.click(screen.getByTestId('role-item-release-manager'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByTestId('roles-delete-impact')).toHaveTextContent(
      '2 members keep their accounts'
    );
  });

  it('says so when nobody holds it', async () => {
    mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('role-item-auditor'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByTestId('roles-delete-impact')).toHaveTextContent(
      'No member currently holds it.'
    );
  });

  it('deletes on confirm', async () => {
    const calls = mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('role-item-auditor'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(await screen.findByTestId('roles-delete-dialog')).getByRole('button', {
        name: 'Delete role',
      })
    );

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(calls.find((call) => call.method === 'DELETE')?.url).toContain('role-auditor');
  });

  it('reports a refusal inside the dialog, not behind it', async () => {
    mockApi({ failWrite: { match: 'DELETE', error: 'Built-in roles cannot be deleted' } });
    await renderRoles();

    await userEvent.click(screen.getByTestId('role-item-auditor'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByTestId('roles-delete-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete role' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Built-in roles cannot be deleted'
      )
    );
  });
});

// ---------------------------------------------------------------------------------------
// The list, and the states with no matrix in them
// ---------------------------------------------------------------------------------------

describe('the role list', () => {
  it('groups built-in above custom and counts each role’s members', async () => {
    mockApi();
    await renderRoles();

    expect(within(screen.getByLabelText('Built-in roles')).getAllByRole('listitem')).toHaveLength(1);
    const custom = within(screen.getByLabelText('Custom roles')).getAllByRole('listitem');
    expect(custom.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Release manager'),
      expect.stringContaining('Auditor'),
    ]);
    expect(screen.getByTestId('role-item-release-manager')).toHaveTextContent('2');
  });

  it('marks the role being edited', async () => {
    mockApi();
    await renderRoles();
    expect(screen.getByTestId('role-item-owner')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('role-item-auditor')).not.toHaveAttribute('aria-current');
  });

  it('filters', async () => {
    mockApi();
    await renderRoles();

    await userEvent.type(screen.getByLabelText('Filter roles'), 'audit');
    expect(screen.queryByTestId('role-item-owner')).not.toBeInTheDocument();
    expect(screen.getByTestId('role-item-auditor')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Filter roles'));
    await userEvent.type(screen.getByLabelText('Filter roles'), 'zzz');
    expect(screen.getByTestId('roles-filter-empty')).toBeInTheDocument();
  });
});

describe('the states with no matrix in them', () => {
  it('offers a retry when the roles could not be read', async () => {
    mockApi({ failRoles: true });
    render(<RolesClient />);

    expect(await screen.findByTestId('roles-error')).toHaveTextContent(
      'The access service did not answer'
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('says the workspace has no roles rather than drawing an empty matrix', async () => {
    mockApi({ roles: [] });
    render(<RolesClient />);

    expect(await screen.findByTestId('roles-empty')).toHaveTextContent('No roles defined yet.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The acceptance criterion the ticket opens with
// ---------------------------------------------------------------------------------------

describe('the native dialogs this screen used to reach for', () => {
  it('are never called, on any of the four paths that used to', async () => {
    mockApi();
    await renderRoles();

    await userEvent.click(screen.getByTestId('roles-new'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await userEvent.click(
      within(await screen.findByTestId('roles-duplicate-dialog')).getByRole('button', {
        name: 'Cancel',
      })
    );
    await userEvent.click(screen.getByTestId('role-item-auditor'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(nativePrompt).not.toHaveBeenCalled();
  });
});
