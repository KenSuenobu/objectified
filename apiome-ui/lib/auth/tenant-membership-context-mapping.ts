/**
 * Pure types and mapping for the tenant-switcher membership context (OLO-6.1, #4218).
 *
 * The switcher renders from the OLO-6.2 (#4219) enriched `GET /v1/tenants/me`
 * payload: every membership carries the caller's effective RBAC role, the V121
 * member lifecycle status, and the tenant's attached license plan in one
 * round-trip. This module holds the client-safe shapes and the REST→row
 * mapping so they are unit-testable without a server context (the actual fetch
 * lives in `tenant-membership-context.ts`, a server action).
 */

/** One membership item as returned by `GET /v1/tenants/me` (OLO-6.2). */
export interface RestTenantMembership {
  /** Tenant id (UUID string). */
  id: string;
  /** Tenant URL slug. */
  slug: string;
  /** Tenant display name. */
  name: string;
  /** Effective RBAC role slug: `owner`/`admin`/`editor`/`viewer` or a custom slug. */
  role: string;
  /** Member lifecycle status (V121): `active`, `pending`, or `suspended`. */
  status: string;
  /** Attached plan display name (e.g. `Free`); null when the tenant has no license row. */
  license_name?: string | null;
  /** Attached plan billing type: `free`/`paid`/`sponsor`; null when unlicensed. */
  license_type?: string | null;
}

/**
 * One tenant row the switcher renders. The enrichment fields are optional so a
 * legacy context (e.g. the studio shell's prefetched name-only rows) keeps
 * rendering with the pre-OLO-6.1 admin badge fallback.
 */
export interface TenantMembershipRow {
  /** Tenant id (UUID string). */
  id: string;
  /** Tenant display name. */
  name: string;
  /** Tenant URL slug, when known. */
  slug?: string;
  /** Effective RBAC role slug, when known. */
  role?: string;
  /** Member lifecycle status, when known. */
  status?: string;
  /** Attached plan display name; null when the tenant has no license row. */
  licenseName?: string | null;
  /** Attached plan billing type; null when the tenant has no license row. */
  licenseType?: string | null;
}

/** The plan tier an unlicensed workspace is treated as, matching the OLO-5.3 enforcement. */
export const DEFAULT_PLAN_NAME = 'Free';

/** The workspace meta line while the membership context is still in flight. */
export const LOADING_WORKSPACE_META = 'Loading…';

/** The workspace meta line when there is no active workspace to describe. */
export const NO_WORKSPACE_META = 'Choose a workspace';

/**
 * The one-line description of a workspace: `"Owner · Team"`.
 *
 * Lives here, beside the row shape, rather than in the switcher that first drew it: the
 * rail's switcher and the `/ade` launcher's workspace chip (HIVE-4.5, #5299) both print it,
 * and a launcher that imported the switcher would pull the whole create-workspace dialog
 * into the first chunk a reader downloads.
 *
 * @param row The active membership, if the context has resolved one.
 * @param loading True while the membership context is still loading.
 * @returns The meta line, never empty — a row with nothing to say still says something.
 */
export function formatWorkspaceMeta(
  row: TenantMembershipRow | undefined,
  loading: boolean
): string {
  // No `role` means an unenriched row (a legacy name-only context): claiming a plan there
  // would be a guess, and a wrong plan is worse than no plan.
  if (row?.role) {
    const role = row.role.charAt(0).toUpperCase() + row.role.slice(1);
    return `${role} · ${row.licenseName || DEFAULT_PLAN_NAME}`;
  }
  // A reload after a switch keeps describing the workspace it already knows; only a first
  // load, with nothing to describe yet, says so.
  if (loading) return LOADING_WORKSPACE_META;
  return NO_WORKSPACE_META;
}

/** Whether the caller may create another tenant, with the numbers behind it. */
export interface CreateTenantGate {
  /** True when `used < max` — mirrors the OLO-5.3 REST guard exactly. */
  allowed: boolean;
  /** Tenants the user already belongs to (members + administrators). */
  used: number;
  /** The user's `max_tenants` entitlement (Free default when no row). */
  max: number;
}

/**
 * Free-plan default for `user_entitlements.max_tenants`, mirroring
 * `DEFAULT_FREE_MAX_TENANTS` in apiome-rest's enforcement guard (OLO-5.3,
 * #4213). Keep the two in sync — the UI gate must predict exactly what the
 * REST transaction will enforce.
 */
export const DEFAULT_FREE_MAX_TENANTS = 1;

/**
 * Map one REST membership item to the row shape the switcher renders.
 *
 * @param item A membership from the enriched `GET /v1/tenants/me`.
 * @returns The corresponding switcher row.
 */
export function mapRestMembershipToRow(item: RestTenantMembership): TenantMembershipRow {
  return {
    id: String(item.id),
    name: item.name ?? '',
    slug: item.slug,
    role: item.role,
    status: item.status,
    licenseName: item.license_name ?? null,
    licenseType: item.license_type ?? null,
  };
}

/**
 * Decide whether the caller may create another tenant.
 *
 * Mirrors the OLO-5.3 REST guard (`current >= max_tenants` blocks), so the
 * header entry never invites a click that the provisioning transaction would
 * 403. A negative or zero `max` therefore reads as "may not create".
 *
 * @param used Tenants the user already belongs to.
 * @param max The user's `max_tenants` entitlement.
 * @returns The gate with its inputs, for cap-aware UI copy.
 */
export function resolveCreateTenantGate(used: number, max: number): CreateTenantGate {
  return { allowed: used < max, used, max };
}
