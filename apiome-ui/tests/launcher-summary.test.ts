/**
 * The launcher's hero summary (HIVE-4.5, #5299).
 *
 * `lib/db/launcher-summary.ts` adds no data of its own: it pairs the membership context the
 * rail's workspace switcher already loads with the statistics the Control Panel already
 * shows, so the launcher's three chips can never contradict either surface.
 *
 * The thing worth guarding is that it *fails soft*. A launcher exists to launch
 * applications; a REST outage or a database fault must cost it its chips, not its page. Both
 * sources are read through `Promise.allSettled` for exactly that reason, and the assertions
 * below are mostly about what happens when one of them throws.
 */

import { getAuthSession } from './__mocks__/server-session';

const mockLoadContext = jest.fn();
const mockDashboardStats = jest.fn();

jest.mock('../lib/auth/tenant-membership-context', () => ({
  loadTenantMembershipContext: () => mockLoadContext(),
}));

jest.mock('../lib/db/helper', () => ({
  getDashboardStats: (userId: string) => mockDashboardStats(userId),
}));

import { getLauncherSummaryForSession } from '../lib/db/launcher-summary';

/** A session for a signed-in reader in one workspace. */
const SESSION = {
  user: { user_id: 'user-1', current_tenant_id: 'tenant-1' },
};

/** The membership context, as the switcher's loader returns it. */
const CONTEXT = {
  tenants: [
    { id: 'tenant-0', name: 'Other Corp', role: 'viewer' },
    { id: 'tenant-1', name: 'Acme Corp', role: 'owner', licenseName: 'Free' },
  ],
  adminTenantIds: [],
  createTenant: null,
};

/** Counts as `pg` returns them — `COUNT(*)` is `bigint`, so every one is a string. */
const STATS = JSON.stringify({ total_projects: '3', published_versions: '5' });

beforeEach(() => {
  (getAuthSession as jest.Mock).mockReset();
  mockLoadContext.mockReset();
  mockDashboardStats.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('launcher summary', () => {
  it('names the session’s own workspace and counts what the Control Panel counts', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(SESSION);
    mockLoadContext.mockResolvedValue(CONTEXT);
    mockDashboardStats.mockResolvedValue(STATS);

    await expect(getLauncherSummaryForSession()).resolves.toEqual({
      workspace: { id: 'tenant-1', name: 'Acme Corp', role: 'owner', licenseName: 'Free' },
      projectCount: 3,
      publishedCount: 5,
    });
    expect(mockDashboardStats).toHaveBeenCalledWith('user-1');
  });

  it('reads nothing at all without a session', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(null);

    await expect(getLauncherSummaryForSession()).resolves.toEqual({
      workspace: null,
      projectCount: 0,
      publishedCount: 0,
    });
    // The acting user comes from the server session; with none there is nobody to read for,
    // and neither source is touched.
    expect(mockLoadContext).not.toHaveBeenCalled();
    expect(mockDashboardStats).not.toHaveBeenCalled();
  });

  it('claims no workspace when the session is not in one', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue({ user: { user_id: 'user-1' } });
    mockLoadContext.mockResolvedValue(CONTEXT);
    mockDashboardStats.mockResolvedValue(STATS);

    const summary = await getLauncherSummaryForSession();
    expect(summary.workspace).toBeNull();
    // …and still counts, so the launcher keeps the two chips it can honestly draw.
    expect(summary.projectCount).toBe(3);
  });

  it('claims no workspace when the session names one the reader is not in', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue({
      user: { user_id: 'user-1', current_tenant_id: 'tenant-gone' },
    });
    mockLoadContext.mockResolvedValue(CONTEXT);
    mockDashboardStats.mockResolvedValue(STATS);

    await expect(getLauncherSummaryForSession()).resolves.toMatchObject({ workspace: null });
  });

  it('keeps the counts when the membership context is unreachable', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(SESSION);
    mockLoadContext.mockRejectedValue(new Error('REST is down'));
    mockDashboardStats.mockResolvedValue(STATS);

    await expect(getLauncherSummaryForSession()).resolves.toEqual({
      workspace: null,
      projectCount: 3,
      publishedCount: 5,
    });
  });

  it('keeps the workspace when the statistics query faults', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(SESSION);
    mockLoadContext.mockResolvedValue(CONTEXT);
    mockDashboardStats.mockRejectedValue(new Error('database is down'));

    const summary = await getLauncherSummaryForSession();
    expect(summary.workspace?.name).toBe('Acme Corp');
    expect(summary.projectCount).toBe(0);
    expect(summary.publishedCount).toBe(0);
  });

  it('survives statistics that are not JSON at all', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(SESSION);
    mockLoadContext.mockResolvedValue(CONTEXT);
    mockDashboardStats.mockResolvedValue('not json');

    await expect(getLauncherSummaryForSession()).resolves.toMatchObject({
      projectCount: 0,
      publishedCount: 0,
    });
  });

  it('reads a missing or nonsensical count as zero rather than as NaN', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(SESSION);
    mockLoadContext.mockResolvedValue(CONTEXT);
    mockDashboardStats.mockResolvedValue(JSON.stringify({ published_versions: null }));

    await expect(getLauncherSummaryForSession()).resolves.toMatchObject({
      projectCount: 0,
      publishedCount: 0,
    });
  });
});
