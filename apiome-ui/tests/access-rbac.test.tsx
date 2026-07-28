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

import RolesClient from '../src/app/ade/dashboard/roles/RolesClient';
import MembersClient from '../src/app/ade/dashboard/members/MembersClient';
import AuditClient from '../src/app/ade/dashboard/audit/AuditClient';

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
  it('renders the role list and a 12x5 permission matrix', async () => {
    render(<RolesClient />);

    // Role names appear in the left list.
    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Release Manager')).toBeInTheDocument();

    // All 12 resources render as rows (lint_findings added by CLX-4.1, #4859;
    // verification_targets by ECA-1.2, #4730).
    for (const label of [
      'Projects',
      'Versions',
      'Classes',
      'Properties',
      'Paths',
      'Primitives / Types',
      'Imports',
      'Members',
      'API Keys',
      'Billing',
      'Lint Findings',
      'Verification Targets',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // All 5 action columns render as headers.
    const matrix = screen.getByRole('table');
    const headers = within(matrix).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Resource', 'View', 'Create', 'Edit', 'Delete', 'Publish']);

    // 12 resources x 5 actions = 60 toggle cells.
    const toggles = within(matrix).getAllByRole('button');
    expect(toggles).toHaveLength(60);
  });
});

describe('MembersClient (#3611)', () => {
  it('renders a member row and the Coming soon SSO/SCIM cards', async () => {
    render(<MembersClient />);

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
    render(<MembersClient />);

    expect(await screen.findByText('2 of 5 seats used')).toBeInTheDocument();
    const meter = screen.getByRole('meter', { name: /Member seats used/i });
    expect(meter).toHaveAttribute('aria-valuenow', '2');
    expect(meter).toHaveAttribute('aria-valuemax', '5');

    // Below capacity, invite stays enabled.
    expect(screen.getByRole('button', { name: /Invite member/i })).toBeEnabled();
  });

  it('disables invite and shows upgrade guidance at capacity', async () => {
    mockMembersFetch({ used: 5, max: 5 });
    render(<MembersClient />);

    expect(await screen.findByText('5 of 5 seats used')).toBeInTheDocument();
    // The at-capacity guidance is visible before any failed action.
    expect(screen.getByText(FRIENDLY_EXHAUSTED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invite member/i })).toBeDisabled();
  });

  it('renders the seats-exhausted 403 as friendly guidance, not a raw error', async () => {
    // Not yet at capacity locally, so the form is enabled; the server rejects.
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
    render(<MembersClient />);

    const emailInput = await screen.findByLabelText(/Email address/i);
    fireEvent.change(emailInput, { target: { value: 'new@acme.io' } });
    fireEvent.click(screen.getByRole('button', { name: /Invite member/i }));

    const banner = await screen.findByTestId('members-error');
    await waitFor(() => expect(banner).toHaveTextContent(FRIENDLY_EXHAUSTED));
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

    render(<MembersClient />);

    expect(await screen.findByText('Dana Okoro')).toBeInTheDocument();
    // No seat indicator when the license read failed.
    expect(screen.queryByTestId('member-seat-usage')).not.toBeInTheDocument();
  });
});

describe('AuditClient (#3611)', () => {
  it('renders the filter tabs and an event row', async () => {
    render(<AuditClient />);

    // Filter tabs.
    for (const tab of ['All events', 'Role changes', 'Permissions', 'Members', 'Admin overrides']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }

    // An event row resolves after the async fetch.
    expect(await screen.findByText('role.assigned')).toBeInTheDocument();
    expect(screen.getByText('noah@partner.com → Release Manager')).toBeInTheDocument();

    // Compliance note.
    const note = await findByText(document.body, /append-only and hash-chained/i);
    expect(note).toBeInTheDocument();
  });
});
