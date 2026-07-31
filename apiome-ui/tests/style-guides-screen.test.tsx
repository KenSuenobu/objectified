/**
 * Governance → Style Guides screen tests — GOV-2.1 (#4433)
 *
 * Renders StyleGuidesClient against a mocked `global.fetch` returning the documented
 * `{ success, data }` proxy shapes and asserts: the list view columns (name + badges,
 * rules on, assignments, updated), read-only handling of the built-in guide, admin
 * gating of the mutating controls, and the create / duplicate / assign / delete flows'
 * REST calls.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

const mockConfirm = jest.fn<Promise<boolean>, [unknown]>(() => Promise.resolve(true));

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({
    confirm: (opts: unknown) => mockConfirm(opts),
    alert: jest.fn(),
  }),
}));

import StyleGuidesClient from '../src/app/ade/dashboard/style-guides/StyleGuidesClient';

const BUILTIN = {
  id: 'guide-builtin',
  name: 'Apiome Recommended',
  description: 'The built-in Apiome style guide.',
  source: 'builtin',
  isDefault: true,
  ruleCount: 37,
  enabledRuleCount: 37,
  tenantAssigned: false,
  projectAssignments: [],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

const CUSTOM = {
  id: 'guide-custom',
  name: 'Payments Guide',
  description: 'House rules for payments APIs.',
  source: 'custom',
  isDefault: false,
  ruleCount: 12,
  enabledRuleCount: 9,
  tenantAssigned: false,
  projectAssignments: [{ projectId: 'proj-1', projectName: 'Payments API' }],
  createdAt: '2026-07-05T00:00:00Z',
  updatedAt: '2026-07-08T00:00:00Z',
};

const PROJECTS = [
  { id: 'proj-1', name: 'Payments API' },
  { id: 'proj-2', name: 'Orders API' },
];

let isAdmin = true;
let calls: { url: string; method: string; body: unknown }[] = [];

function jsonResponse(payload: unknown) {
  return Promise.resolve({
    status: 200,
    json: () => Promise.resolve(payload),
  } as Response);
}

function mockFetch() {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : null });

    if (url.includes('/api/access/permissions/me')) {
      return jsonResponse({ success: true, data: { is_admin: isAdmin, permissions: [] } });
    }
    if (url.includes('/api/projects')) {
      return jsonResponse({ success: true, projects: PROJECTS });
    }
    if (url.startsWith('/api/style-guides') && method === 'GET') {
      return jsonResponse({ success: true, data: { guides: [BUILTIN, CUSTOM], count: 2 } });
    }
    // Mutations: the screen only needs success; it reloads the list afterwards.
    return jsonResponse({ success: true, data: {} });
  });
  // @ts-expect-error - assigning a test double to the global
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  isAdmin = true;
  calls = [];
  mockConfirm.mockClear();
  mockConfirm.mockResolvedValue(true);
  mockFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const findMutation = (method: string, urlPart: string) =>
  calls.find((c) => c.method === method && c.url.includes(urlPart));

describe('StyleGuidesClient — list view', () => {
  it('renders guides with badges, rule counts, assignments, and updated dates', async () => {
    render(<StyleGuidesClient />);

    expect(await screen.findByText('Apiome Recommended')).toBeInTheDocument();
    expect(screen.getByText('Payments Guide')).toBeInTheDocument();

    // Column headers.
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Name', 'Rules on', 'Assignments', 'Updated', 'Actions']);

    // The builtin guide carries the Built-in badge and the tenant-default badge.
    expect(screen.getByText('Built-in')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('Tenant default')).toBeInTheDocument();

    // Rules-on counts ("enabled / total") and the custom guide's project chip.
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('/ 12')).toBeInTheDocument();
    expect(screen.getByText('Payments API')).toBeInTheDocument();
  });

  it('offers edit/delete only for custom guides (builtin is read-only)', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Apiome Recommended');

    expect(screen.queryByLabelText('Edit Apiome Recommended')).toBeNull();
    expect(screen.queryByLabelText('Delete Apiome Recommended')).toBeNull();
    expect(screen.getByLabelText('Duplicate Apiome Recommended')).toBeInTheDocument();

    expect(screen.getByLabelText('Edit Payments Guide')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete Payments Guide')).toBeInTheDocument();
  });

  it('hides all mutating controls for non-admin members', async () => {
    isAdmin = false;
    render(<StyleGuidesClient />);
    await screen.findByText('Apiome Recommended');

    expect(screen.queryByText('New guide')).toBeNull();
    expect(screen.queryByText('Start from Recommended')).toBeNull();
    expect(screen.queryByText('Assign…')).toBeNull();
    expect(screen.queryByLabelText('Duplicate Apiome Recommended')).toBeNull();
  });
});

describe('StyleGuidesClient — section tabs', () => {
  it('opens on the guide list and offers a tab per governance section', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Apiome Recommended');

    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Style guides', 'Import & export policy', 'Verification policy']);
    expect(screen.getByRole('tab', { name: 'Style guides' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Only the guide list is mounted — the policy panels stay unloaded until selected.
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('quality-policy-panel')).toBeNull();
    expect(screen.queryByText('Verification publish & deploy policy')).toBeNull();
  });

  it('swaps the guide list for the quality policy panel when its tab is selected', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Apiome Recommended');

    fireEvent.click(screen.getByRole('tab', { name: 'Import & export policy' }));

    expect(await screen.findByTestId('quality-policy-panel')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    // The list-only header actions leave with the list.
    expect(screen.queryByText('New guide')).toBeNull();
    expect(screen.queryByText('Start from Recommended')).toBeNull();
  });

  it('shows the verification policy on its own tab and returns to the list', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Apiome Recommended');

    fireEvent.click(screen.getByRole('tab', { name: 'Verification policy' }));
    expect(await screen.findByText('Verification publish & deploy policy')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Style guides' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByText('New guide')).toBeInTheDocument();
  });
});

describe('StyleGuidesClient — create & duplicate', () => {
  it('creates an empty guide via the New guide dialog', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Apiome Recommended');

    fireEvent.click(screen.getByText('New guide'));
    expect(await screen.findByText('New style guide')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Guide' } });
    fireEvent.click(screen.getByText('Create guide'));

    await waitFor(() => {
      const post = findMutation('POST', '/api/style-guides');
      expect(post).toBeTruthy();
      expect(post?.body).toEqual({ name: 'My Guide', description: null, sourceGuideId: null });
    });
  });

  it('duplicates the builtin guide via Start from Recommended', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Apiome Recommended');

    fireEvent.click(screen.getByText('Start from Recommended'));
    expect(await screen.findByText('Duplicate style guide')).toBeInTheDocument();

    // Name and rule source are prefilled from the builtin guide.
    expect(screen.getByLabelText('Name')).toHaveValue('Apiome Recommended (copy)');
    expect(screen.getByLabelText('Copy rules from')).toHaveValue('guide-builtin');

    fireEvent.click(screen.getByText('Create guide'));

    await waitFor(() => {
      const post = findMutation('POST', '/api/style-guides');
      expect(post?.body).toMatchObject({
        name: 'Apiome Recommended (copy)',
        sourceGuideId: 'guide-builtin',
      });
    });
  });
});

describe('StyleGuidesClient — assign dialog', () => {
  it('makes a guide the tenant default', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Payments Guide');

    // The custom guide's row action opens the assign dialog.
    fireEvent.click(screen.getAllByText('Assign…')[1]);
    expect(await screen.findByText('Assign “Payments Guide”')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Make tenant default'));
    await waitFor(() => {
      expect(findMutation('PUT', '/api/style-guides/guide-custom/default')).toBeTruthy();
    });
  });

  it('assigns and unassigns projects', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Payments Guide');

    fireEvent.click(screen.getAllByText('Assign…')[1]);
    await screen.findByText('Assign “Payments Guide”');

    // proj-1 is already assigned, so only Orders API is offered.
    const select = screen.getByLabelText('Project to assign');
    expect(within(select).queryByText('Payments API')).toBeNull();
    fireEvent.change(select, { target: { value: 'proj-2' } });
    fireEvent.click(screen.getByText('Assign'));
    await waitFor(() => {
      expect(
        findMutation('PUT', '/api/style-guides/guide-custom/assignments/projects/proj-2'),
      ).toBeTruthy();
    });

    // The screen disables controls while a mutation is in flight; wait for it to settle.
    await waitFor(() => expect(screen.getByLabelText('Unassign Payments API')).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Unassign Payments API'));
    await waitFor(() => {
      expect(
        findMutation('DELETE', '/api/style-guides/assignments/projects/proj-1'),
      ).toBeTruthy();
    });
  });
});

describe('StyleGuidesClient — delete', () => {
  it('deletes a custom guide after confirmation', async () => {
    render(<StyleGuidesClient />);
    await screen.findByText('Payments Guide');

    fireEvent.click(screen.getByLabelText('Delete Payments Guide'));
    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
      expect(findMutation('DELETE', '/api/style-guides/guide-custom')).toBeTruthy();
    });
  });

  it('does not delete when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false);
    render(<StyleGuidesClient />);
    await screen.findByText('Payments Guide');

    fireEvent.click(screen.getByLabelText('Delete Payments Guide'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(findMutation('DELETE', '/api/style-guides/guide-custom')).toBeFalsy();
  });
});
