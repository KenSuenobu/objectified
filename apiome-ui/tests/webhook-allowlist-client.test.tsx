/**
 * The webhook allowlist screen, driven (REPO-7.6, #2804; redesigned HIVE-7.6, #5323).
 *
 * These drive the real screen against a stubbed `/api/repositories/webhook-ip-allowlist`
 * and assert the behaviours the original ticket's third acceptance criterion names — the
 * allowlist is visible in the admin UI, and the bypass is an explicit, reasoned act.
 *
 * The redesign put a confirm in front of the two edits that *weaken* the filter, so the two
 * paths that used to mutate on click now answer a dialog first. Everything else here is the
 * behaviour the redesign had to carry over intact;
 * `repository-bring-in-hive-redesign.test.tsx` holds what it added.
 *
 * Plus the two degradations that matter:
 *
 *  - "enforced" with an empty range cache must not be drawn as protection, because it is not;
 *  - a 403 from REST (the non-administrator answer) must surface as a message rather than as
 *    a page that silently declines to save.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

/** Mutable so one test can drive the "no tenant selected" guard. */
let currentTenantId: string | undefined = 'tenant-1';

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: { current_tenant_id: currentTenantId } } }),
}));

const toastError = jest.fn();
const toastSuccess = jest.fn();

// The Repositories sub-nav under the title reads the path to decide which tab is current.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/ade/dashboard/repositories/webhook-ip-allowlist',
}));
jest.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: (...args: unknown[]) => toastSuccess(...args), message: jest.fn() },
}));

import { WebhookAllowlistClient } from '@/app/ade/dashboard/repositories/webhook-ip-allowlist/WebhookAllowlistClient';

const ENTRY_ID = 'aa0e8400-e29b-41d4-a716-44665544000a';

function providers(rangeCount = 1) {
  return [
    {
      provider: 'github',
      sourceUrl: 'https://api.github.com/meta',
      note: 'GitHub publishes its webhook egress ranges in the `hooks` array.',
      rangeCount,
      ranges:
        rangeCount > 0
          ? [{ cidr: '192.30.252.0/22', family: 4, source: 'provider', refreshedAt: null }]
          : [],
      lastAttemptAt: '2026-08-01T10:00:00Z',
      lastSuccessAt: rangeCount > 0 ? '2026-08-01T10:00:00Z' : null,
      lastOutcome: rangeCount > 0 ? 'success' : 'failure',
      lastError: rangeCount > 0 ? null : 'HTTP 503',
      stale: rangeCount === 0,
    },
    {
      provider: 'gitlab',
      sourceUrl: null,
      note: 'GitLab.com publishes no machine-readable range list.',
      rangeCount: 0,
      ranges: [],
      lastAttemptAt: '2026-08-01T10:00:00Z',
      lastSuccessAt: null,
      lastOutcome: 'skipped',
      lastError: null,
      stale: true,
    },
  ];
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    enforcementEnabled: true,
    strict: false,
    refreshIntervalSeconds: 86400,
    trustedProxyHops: 0,
    tenantEnforcementEnabled: true,
    bypassReason: null,
    policyUpdatedAt: null,
    providers: providers(),
    entries: [
      {
        id: ENTRY_ID,
        cidr: '203.0.113.0/24',
        family: 4,
        description: 'Vendor relay',
        enabled: true,
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-01T00:00:00Z',
      },
    ],
    ...overrides,
  };
}

/** Every fetch made by the component, so a test can assert on the request itself. */
let calls: Array<{ url: string; init?: RequestInit }> = [];

function stubFetch(responder: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  global.fetch = jest.fn(async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit | undefined });
    const { status = 200, body } = responder(String(url), init as RequestInit | undefined);
    return {
      ok: status < 400,
      status,
      statusText: String(status),
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  currentTenantId = 'tenant-1';
  toastError.mockClear();
  toastSuccess.mockClear();
  stubFetch(() => ({ body: payload() }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- what the panel shows ----------------------------------------------------------------

describe('the allowlist view', () => {
  test('shows the provider ranges and this workspace’s own entries', async () => {
    render(<WebhookAllowlistClient />);
    expect(await screen.findByText('192.30.252.0/22')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.0/24')).toBeInTheDocument();
    expect(screen.getByText(/Vendor relay/)).toBeInTheDocument();
  });

  test('states the posture rather than leaving three switches to be combined', async () => {
    render(<WebhookAllowlistClient />);
    const banner = await screen.findByTestId('allowlist-posture');
    expect(banner).toHaveAttribute('data-posture', 'enforced');
  });

  test('enforcement with nothing cached is not drawn as protection', async () => {
    // The dangerous state: everything reads "on" and every delivery is being allowed.
    stubFetch(() => ({ body: payload({ providers: providers(0) }) }));
    render(<WebhookAllowlistClient />);
    const banner = await screen.findByTestId('allowlist-posture');
    expect(banner).toHaveAttribute('data-posture', 'unfiltered');
    expect(within(banner).getByText(/nothing to filter against/i)).toBeInTheDocument();
  });

  test('a bypassed workspace says so, with the reason on record', async () => {
    stubFetch(() => ({
      body: payload({ tenantEnforcementEnabled: false, bypassReason: 'Vendor relay' }),
    }));
    render(<WebhookAllowlistClient />);
    const banner = await screen.findByTestId('allowlist-posture');
    expect(banner).toHaveAttribute('data-posture', 'bypassed');
    expect(screen.getByTestId('bypass-reason')).toHaveTextContent('Vendor relay');
  });

  test('a provider with no list to fetch is not shown as broken', async () => {
    render(<WebhookAllowlistClient />);
    await screen.findAllByTestId('provider-card');
    const cards = screen.getAllByTestId('provider-card');
    const gitlabCard = cards.find((card) => card.getAttribute('data-provider') === 'gitlab')!;
    expect(within(gitlabCard).getByTestId('refresh-summary')).toHaveTextContent(
      /No range list to fetch/
    );
  });

  test('a workspace with no entries says the provider ranges are all there is', async () => {
    stubFetch(() => ({ body: payload({ entries: [] }) }));
    render(<WebhookAllowlistClient />);
    expect(await screen.findByText(/No additional ranges/)).toBeInTheDocument();
  });

  test('no tenant selected is a guard, not an error', async () => {
    currentTenantId = undefined;
    render(<WebhookAllowlistClient />);
    // The shared gate (HIVE-2.5, #5284) — a lock and a way through, not an amber warning.
    expect(await screen.findByText('Pick a workspace first')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an unreachable API is reported rather than shown as an empty allowlist', async () => {
    stubFetch(() => ({ status: 503, body: { success: false, error: 'Repository API unavailable' } }));
    render(<WebhookAllowlistClient />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Repository API unavailable');
  });
});

// --- adding a range ----------------------------------------------------------------------

describe('adding a range', () => {
  test('sends the CIDR and the reason', async () => {
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.type(screen.getByLabelText('Address or CIDR'), '198.51.100.0/24');
    await user.type(screen.getByLabelText('Why'), 'Self-hosted runner');
    await user.click(screen.getByRole('button', { name: /allow range/i }));

    await waitFor(() => {
      const post = calls.find((call) => call.init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post!.init!.body))).toEqual({
        cidr: '198.51.100.0/24',
        description: 'Self-hosted runner',
      });
    });
  });

  test('a range with host bits is caught before it is sent', async () => {
    // The same rule the server applies: an operator who meant one host and got 256 would
    // never learn it from this screen.
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.type(screen.getByLabelText('Address or CIDR'), '10.0.0.1/24');
    await user.type(screen.getByLabelText('Why'), 'runner');
    await user.click(screen.getByRole('button', { name: /allow range/i }));

    // A `ui/FormField` error: an `alert` beside the field it belongs to, and the field points
    // at it with `aria-describedby` rather than the message floating under the whole card.
    expect(await screen.findByRole('alert')).toHaveTextContent(/host bits/);
    expect(screen.getByLabelText('Address or CIDR')).toHaveAttribute(
      'aria-describedby',
      'allowlist-cidr-error'
    );
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false);
  });

  test('a range with no reason is refused before it is sent', async () => {
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.type(screen.getByLabelText('Address or CIDR'), '198.51.100.0/24');
    await user.click(screen.getByRole('button', { name: /allow range/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/why this range/i);
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false);
  });

  test('a non-administrator is told why the change did not save', async () => {
    stubFetch((_url, init) =>
      init?.method === 'POST'
        ? { status: 403, body: { success: false, error: 'Only tenant administrators can change the webhook IP allowlist' } }
        : { body: payload() }
    );
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.type(screen.getByLabelText('Address or CIDR'), '198.51.100.0/24');
    await user.type(screen.getByLabelText('Why'), 'runner');
    await user.click(screen.getByRole('button', { name: /allow range/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Only tenant administrators can change the webhook IP allowlist'
      )
    );
  });
});

// --- entries -----------------------------------------------------------------------------

describe('existing entries', () => {
  test('an entry can be disabled without being deleted', async () => {
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.init?.method === 'PATCH');
      expect(patch?.url).toContain(`/entries/${ENTRY_ID}`);
      expect(JSON.parse(String(patch!.init!.body))).toEqual({ enabled: false });
    });
  });

  test('a disabled entry offers to be enabled again', async () => {
    stubFetch(() => ({
      body: payload({
        entries: [
          {
            id: ENTRY_ID,
            cidr: '203.0.113.0/24',
            family: 4,
            description: 'Vendor relay',
            enabled: false,
            createdAt: '2026-07-01T00:00:00Z',
            updatedAt: '2026-07-01T00:00:00Z',
          },
        ],
      }),
    }));
    render(<WebhookAllowlistClient />);
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  test('an entry can be removed', async () => {
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.click(screen.getByRole('button', { name: /Remove 203\.0\.113\.0\/24/ }));
    // HIVE-7.6 (#5323): removing a range narrows what an unauthenticated endpoint accepts, so
    // it confirms first. The dialog names the range rather than saying "this range".
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Remove 203.0.113.0/24?')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove range' }));

    await waitFor(() => {
      const del = calls.find((call) => call.init?.method === 'DELETE');
      expect(del?.url).toContain(`/entries/${ENTRY_ID}`);
    });
  });

  test('the screen re-renders from what the server stored, not from local state', async () => {
    // Every mutation answers with the whole allowlist, so an edit can never leave the page
    // disagreeing with the database.
    stubFetch((_url, init) =>
      init?.method === 'DELETE' ? { body: payload({ entries: [] }) } : { body: payload() }
    );
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.click(screen.getByRole('button', { name: /Remove 203\.0\.113\.0\/24/ }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove range' })
    );

    expect(await screen.findByText(/No additional ranges/)).toBeInTheDocument();
  });
});

// --- the bypass --------------------------------------------------------------------------

describe('the bypass', () => {
  test('asks for a reason before it will turn enforcement off', async () => {
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.click(screen.getByRole('button', { name: /bypass allowlist/i }));

    // The refusal is a field error now, not a toast that leaves the field unmarked — and the
    // confirm never opens, so the reason cannot be skipped by answering a dialog.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Say why enforcement/);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === 'PUT')).toBe(false);
  });

  test('sends the reason with the change so the ledger can record it', async () => {
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);
    await screen.findByText('203.0.113.0/24');

    await user.type(screen.getByLabelText(/reason for bypassing/i), 'Relay has no published range');
    await user.click(screen.getByRole('button', { name: /bypass allowlist/i }));

    // The confirm quotes the reason back — the last moment anyone can correct what the audit
    // ledger is about to record.
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('“Relay has no published range”');
    await user.click(within(confirm).getByRole('button', { name: 'Bypass allowlist' }));

    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === 'PUT');
      expect(JSON.parse(String(put!.init!.body))).toEqual({
        enforcementEnabled: false,
        bypassReason: 'Relay has no published range',
      });
    });
  });

  test('a bypassed workspace is offered enforcement back, with no reason needed', async () => {
    stubFetch((_url, init) =>
      init?.method === 'PUT'
        ? { body: payload() }
        : { body: payload({ tenantEnforcementEnabled: false, bypassReason: 'Relay' }) }
    );
    const user = userEvent.setup();
    render(<WebhookAllowlistClient />);

    await user.click(await screen.findByRole('button', { name: /restore enforcement/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === 'PUT');
      expect(JSON.parse(String(put!.init!.body))).toEqual({
        enforcementEnabled: true,
        bypassReason: null,
      });
    });
  });
});
