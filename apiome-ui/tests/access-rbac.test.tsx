/**
 * Access / IAM (RBAC) UI tests — #3611
 *
 * Renders the three tenant-facing client components (Roles, Members, Audit) against a
 * mocked `global.fetch` that returns the documented `{ success, data }` proxy shapes,
 * and asserts the key UI surfaces: the permission matrix (10 resources x 5 actions),
 * the members table + the "Coming soon" SSO/SCIM cards, and the audit filter tabs +
 * an event row.
 */

import React from 'react';
import { render, screen, within, findByText, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

/**
 * The members screen reads the session for the viewer's own id (HIVE-5.2, #5305) — that is
 * what marks their row "(you)" and closes the writes on it. `useAuthSession` throws outside
 * its provider rather than returning nothing, so the harness stubs the module the way
 * `tenants-hive-redesign.test.tsx` does.
 */
jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: { user_id: 'viewer-1', email: 'viewer@acme.io', name: 'Viewer' } },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import RolesClient from '../src/app/ade/dashboard/roles/RolesClient';
import MembersClient from '../src/app/ade/dashboard/members/MembersClient';
import AuditClient from '../src/app/ade/dashboard/audit/AuditClient';
import { DialogProvider } from '../src/app/components/providers/DialogProvider';

/**
 * Render a client inside the app's dialog provider.
 *
 * Roles and Members ask for a confirm through `useDialog()` since HIVE-2.7 (#5286), and the
 * hook throws outside its provider rather than silently doing nothing — so the harness has
 * to mount the same thing `app/layout.tsx` does.
 *
 * @param ui The component under test.
 * @returns Whatever `render` returns.
 */
const renderWithDialogs = (ui: React.ReactElement) =>
  render(<DialogProvider>{ui}</DialogProvider>);

const ROLES = [
  {
    id: 'role-owner',
    slug: 'owner',
    name: 'Owner',
    description: 'Built-in · full control',
    is_builtin: true,
    member_count: 1,
    permissions: [
      { resource: 'versions', action: 'view' },
      { resource: 'versions', action: 'publish' },
    ],
  },
  {
    id: 'role-rm',
    slug: 'release-manager',
    name: 'Release Manager',
    description: 'Can publish versions.',
    is_builtin: false,
    member_count: 2,
    permissions: [{ resource: 'versions', action: 'publish' }],
  },
];

const MEMBERS = [
  {
    user_id: 'user-1',
    name: 'Dana Okoro',
    email: 'dana@acme.io',
    status: 'active',
    member_since: '2026-01-01T00:00:00Z',
    role_id: 'role-owner',
    role_name: 'Owner',
    role_slug: 'owner',
    is_admin: true,
  },
  {
    user_id: 'user-2',
    name: 'Noah Partner',
    email: 'noah@partner.com',
    status: 'pending',
    member_since: '2026-06-01T00:00:00Z',
    role_id: 'role-rm',
    role_name: 'Release Manager',
    role_slug: 'release-manager',
    is_admin: false,
  },
];

const AUDIT = [
  {
    id: 'evt-1',
    actor_id: 'user-1',
    actor_label: 'dana@acme.io',
    action: 'role.assigned',
    target: 'noah@partner.com → Release Manager',
    source: 'Web',
    detail: '',
    created_at: '2026-06-20T12:04:22Z',
  },
];

const PERMS_ADMIN = { is_admin: true, permissions: [] as string[] };

function jsonResponse(data: unknown) {
  return Promise.resolve({
    status: 200,
    json: () => Promise.resolve({ success: true, data }),
  } as Response);
}

function mockFetch() {
  const fn = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/access/permissions/me')) return jsonResponse(PERMS_ADMIN);
    if (url.includes('/api/access/roles')) return jsonResponse(ROLES);
    if (url.includes('/api/access/members')) return jsonResponse(MEMBERS);
    if (url.includes('/api/access/audit')) return jsonResponse(AUDIT);
    return jsonResponse([]);
  });
  // @ts-expect-error - assigning a test double to the global
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RolesClient (#3611)', () => {
  it('renders the role list and a 13x5 permission matrix', async () => {
    renderWithDialogs(<RolesClient />);

    // Role names appear in the left list. "Owner" is also the editor's heading once it is
    // selected, so the list's own copy is found by the row's test id.
    expect(await screen.findByTestId('role-item-owner')).toHaveTextContent('Owner');
    expect(screen.getByTestId('role-item-release-manager')).toHaveTextContent('Release Manager');

    // All 13 resources render as rows (lint_findings added by CLX-4.1, #4859;
    // verification_targets by ECA-1.2, #4730; verification_evidence by ECA-1.3, #4731).
    // HIVE-5.3 (#5306) took the labels to sentence case, as the mockup writes them; the
    // guard keys they grant against are unchanged and are now printed under each label.
    for (const label of [
      'Projects',
      'Versions',
      'Classes',
      'Properties',
      'Paths',
      'Primitives / Types',
      'Imports',
      'Members',
      'API keys',
      'Billing',
      'Lint findings',
      'Verification targets',
      'Verification evidence',
    ]) {
      // Scoped to the matrix: "Members" is also the header's link to the roster.
      expect(within(screen.getByRole('table')).getByText(label)).toBeInTheDocument();
    }

    // All 5 action columns render as headers.
    const matrix = screen.getByRole('table');
    const headers = within(matrix).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Resource', 'View', 'Create', 'Edit', 'Delete', 'Publish']);

    // 13 resources x 5 actions = 65 toggle cells, plus the 13 row toggles HIVE-5.3 added —
    // the tri-state control that grants or revokes a whole resource at once.
    const toggles = within(matrix).getAllByRole('button');
    expect(toggles).toHaveLength(78);
    expect(toggles.filter((button) => button.getAttribute('aria-pressed') !== null)).toHaveLength(
      78
    );
  });
});

describe('MembersClient (#3611)', () => {
  it('renders a member row and the Coming soon SSO/SCIM cards', async () => {
    renderWithDialogs(<MembersClient />);

    // A member row.
    expect(await screen.findByText('Dana Okoro')).toBeInTheDocument();
    expect(screen.getByText('dana@acme.io')).toBeInTheDocument();

    // SSO / SCIM coming-soon cards.
    expect(screen.getByText('Single Sign-On (OIDC/SAML)')).toBeInTheDocument();
    expect(screen.getByText('SCIM 2.0 provisioning')).toBeInTheDocument();
    expect(screen.getAllByText('Coming soon').length).toBeGreaterThanOrEqual(2);

    // Disabled (non-functional) controls.
    expect(screen.getByRole('button', { name: 'Configure SSO' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable SCIM' })).toBeDisabled();
  });
});

/**
 * OLO-6.3 (#4220): member management surfaces license seat usage, gates invite
 * at capacity, and renders the OLO-5.3 `license-seats-exhausted` 403 gracefully.
 */
describe('MembersClient — license/seat alignment (OLO-6.3)', () => {
  const FRIENDLY_EXHAUSTED = /All member seats included in this tenant's license/i;

  /** Build a `{ success, data }` license response for the `/api/tenants/license` proxy. */
  function licenseResponse(seats: { used: number; max: number }) {
    return jsonResponse({
      plan: { name: 'Free', type: 'free' },
      seats,
      quotas: { max_projects: 1, max_versions: 3, max_ai_requests: 0 },
      features: [],
    });
  }

  /**
   * Mock `global.fetch` for the member screen.
   *
   * @param seats Seat usage returned by the license proxy.
   * @param invite Optional override for the invite POST (`/api/access/members`,
   *   method POST) — used to simulate the OLO-5.3 seats-exhausted 403.
   */
  function mockMembersFetch(
    seats: { used: number; max: number },
    invite?: () => Promise<Response>,
  ) {
    const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/tenants/license')) return licenseResponse(seats);
      if (url.includes('/api/access/permissions/me')) return jsonResponse(PERMS_ADMIN);
      if (url.includes('/api/access/roles')) return jsonResponse(ROLES);
      if (url.includes('/api/access/members')) {
        if (init?.method === 'POST' && invite) return invite();
        return jsonResponse(MEMBERS);
      }
      return jsonResponse([]);
    });
    // @ts-expect-error - assigning a test double to the global
    global.fetch = fn;
    return fn;
  }

  it('surfaces seat usage proactively with a meter', async () => {
    mockMembersFetch({ used: 2, max: 5 });
    renderWithDialogs(<MembersClient />);

    expect(await screen.findByText('2 of 5 seats used')).toBeInTheDocument();
    const meter = screen.getByRole('meter', { name: /Member seats used/i });
    expect(meter).toHaveAttribute('aria-valuenow', '2');
    expect(meter).toHaveAttribute('aria-valuemax', '5');

    // Below capacity, invite stays enabled.
    expect(screen.getByRole('button', { name: /Invite member/i })).toBeEnabled();
  });

  it('disables invite and shows upgrade guidance at capacity', async () => {
    mockMembersFetch({ used: 5, max: 5 });
    renderWithDialogs(<MembersClient />);

    expect(await screen.findByText('5 of 5 seats used')).toBeInTheDocument();
    // The at-capacity guidance is visible before any failed action.
    expect(screen.getByText(FRIENDLY_EXHAUSTED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invite member/i })).toBeDisabled();
  });

  it('renders the seats-exhausted 403 as friendly guidance, not a raw error', async () => {
    // Not yet at capacity locally, so the invite is offered; the server rejects.
    mockMembersFetch({ used: 4, max: 5 }, () =>
      Promise.resolve({
        status: 403,
        json: () =>
          Promise.resolve({
            success: false,
            error: "This tenant's license allows 5 member seat(s) and all 5 are in use.",
            code: 'license-seats-exhausted',
          }),
      } as Response),
    );
    renderWithDialogs(<MembersClient />);

    // HIVE-5.2 (#5305): the invite is a dialog behind the header's primary, not an inline
    // card, and its failure is shown *in* the dialog rather than in a page banner the
    // overlay would be covering.
    fireEvent.click(await screen.findByTestId('members-invite'));

    const emailInput = await screen.findByLabelText(/Email address/i);
    fireEvent.change(emailInput, { target: { value: 'new@acme.io' } });
    fireEvent.click(screen.getByRole('button', { name: /Send invite/i }));

    const dialog = await screen.findByTestId('members-invite-dialog');
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(FRIENDLY_EXHAUSTED));
  });

  it('renders the roster even when the license read fails', async () => {
    // License proxy returns a failure envelope; the roster must still load.
    const fn = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/tenants/license')) {
        return Promise.resolve({
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'boom' }),
        } as Response);
      }
      if (url.includes('/api/access/permissions/me')) return jsonResponse(PERMS_ADMIN);
      if (url.includes('/api/access/roles')) return jsonResponse(ROLES);
      if (url.includes('/api/access/members')) return jsonResponse(MEMBERS);
      return jsonResponse([]);
    });
    // @ts-expect-error - assigning a test double to the global
    global.fetch = fn;

    renderWithDialogs(<MembersClient />);

    expect(await screen.findByText('Dana Okoro')).toBeInTheDocument();
    // No seat indicator when the license read failed.
    expect(screen.queryByTestId('member-seat-usage')).not.toBeInTheDocument();
  });
});

describe('AuditClient (#3611)', () => {
  it('renders the filter chips and an event row', async () => {
    renderWithDialogs(<AuditClient />);

    // The five original filter chips. HIVE-5.5 (#5308) put a count after each label, so the
    // accessible name is now "<label> <count>" — matched by prefix rather than exactly.
    for (const chip of ['All events', 'Role changes', 'Permissions', 'Members', 'Admin overrides']) {
      expect(
        await screen.findByRole('button', { name: new RegExp(`^${chip}`) })
      ).toBeInTheDocument();
    }

    // An event row resolves after the async fetch.
    expect(await screen.findByText('role.assigned')).toBeInTheDocument();
    expect(screen.getByText('noah@partner.com → Release Manager')).toBeInTheDocument();

    // Compliance note.
    const note = await findByText(document.body, /append-only and hash-chained/i);
    expect(note).toBeInTheDocument();
  });
});
