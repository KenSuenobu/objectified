'use server';

/**
 * The launcher's summary chips (HIVE-4.5, #5299).
 *
 * `/ade` greets the reader and then says, in three chips, where they are and what they have:
 * the workspace they are in with its role and plan, how many projects they can reach, and how
 * many versions of those are published. None of that is new data — it is what the workspace
 * switcher and the Control Panel's own statistics already show — so this module reads the two
 * existing sources rather than adding a third:
 *
 * - `loadTenantMembershipContext()` (OLO-6.1) for the workspace row, which carries the
 *   effective RBAC role and the attached licence plan in the same round-trip the rail's
 *   switcher makes.
 * - `getDashboardStats()` for the counts, so the launcher and the Control Panel can never
 *   disagree about how many projects exist.
 *
 * Misuse safeguards:
 * - The acting user comes from the server session; the client passes nothing and can spoof
 *   nothing.
 * - Every lookup fails soft. A launcher that cannot count projects still launches
 *   applications, which is the page's actual job, so an unreachable REST or database
 *   degrades to a hero with no chips rather than to an error page.
 */

// Relative, like `commercial-access.ts` beside it: the jest `auth/server-session` mock is
// mapped by suffix, and the `@lib/*` alias is matched first and would win.
import { getAuthSession } from '../auth/server-session';
import { loadTenantMembershipContext } from '../auth/tenant-membership-context';
import type { TenantMembershipRow } from '../auth/tenant-membership-context-mapping';
import { getDashboardStats } from './helper';

/** What the launcher's hero says about the reader's position, beyond their name. */
export type LauncherSummary = {
  /**
   * The workspace the session is currently in, enriched with role and plan when the
   * membership context resolved. `null` when the reader has no active workspace, in which
   * case the launcher simply draws no workspace chip.
   */
  workspace: TenantMembershipRow | null;
  /**
   * Projects across every workspace the reader belongs to — the Control Panel's own
   * "Projects" statistic, not a per-workspace count, so the two surfaces agree.
   */
  projectCount: number;
  /** Published versions across the same workspaces. */
  publishedCount: number;
};

/** What the chips say when nothing could be resolved. */
const EMPTY_SUMMARY: LauncherSummary = {
  workspace: null,
  projectCount: 0,
  publishedCount: 0,
};

/**
 * Read one numeric column out of the dashboard statistics payload.
 *
 * `getDashboardStats` returns a JSON string whose counts arrive from `pg` as strings
 * (`COUNT(*)` is `bigint`), so both the parse and the coercion have to be defensive.
 *
 * @param stats The parsed statistics object, or null when it could not be parsed.
 * @param column The column name to read.
 * @returns The count, or 0 when it is missing or not a number.
 */
function countFrom(stats: Record<string, unknown> | null, column: string): number {
  const value = Number(stats?.[column]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The workspace row the session is currently in.
 *
 * @param tenants Every membership the reader holds.
 * @param currentTenantId The session's active workspace id, if it has one.
 * @returns The matching row, or null when there is no active workspace.
 */
function activeWorkspace(
  tenants: TenantMembershipRow[],
  currentTenantId: string | undefined
): TenantMembershipRow | null {
  if (!currentTenantId) return null;
  return tenants.find((row) => row.id === currentTenantId) ?? null;
}

/**
 * Summarise the signed-in reader's position for the launcher hero.
 *
 * @returns The workspace row and the two counts; all-empty when there is no session or when
 *          neither source could be reached.
 */
export async function getLauncherSummaryForSession(): Promise<LauncherSummary> {
  const session = await getAuthSession();
  const user = session?.user as
    | { user_id?: string; current_tenant_id?: string }
    | undefined;
  const userId = user?.user_id;
  if (!userId) return EMPTY_SUMMARY;

  // Both sources are independent and both may fail; `allSettled` is what keeps one outage
  // from taking the other's chip away as well.
  const [context, statsJson] = await Promise.allSettled([
    loadTenantMembershipContext(),
    getDashboardStats(userId),
  ]);

  const tenants = context.status === 'fulfilled' ? context.value.tenants : [];

  let stats: Record<string, unknown> | null = null;
  if (statsJson.status === 'fulfilled') {
    try {
      stats = JSON.parse(statsJson.value) as Record<string, unknown>;
    } catch (error) {
      console.error('[launcher-summary] dashboard stats were not JSON:', error);
    }
  }

  return {
    workspace: activeWorkspace(tenants, user?.current_tenant_id),
    projectCount: countFrom(stats, 'total_projects'),
    publishedCount: countFrom(stats, 'published_versions'),
  };
}
