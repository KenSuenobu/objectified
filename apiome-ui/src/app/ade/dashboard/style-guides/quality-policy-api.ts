/**
 * Client contract for the tenant import/export quality policy — IXH-2.3 (#5098).
 *
 * The Governance → Style Guides screen hosts the policy panel; both talk to the
 * `/api/quality-policy` proxy, which forwards to the REST layer's tenant-scoped
 * `/v1/tenants/{slug}/governance/quality-policy` and `…/quality-waivers` endpoints. Types mirror
 * the REST models' camelCase serialization aliases.
 *
 * The policy governs two gates. **Import** decides whether a candidate document may enter the
 * catalog at all; **export** decides whether an artifact may be delivered. Each carries the same
 * three floors (grade, score, severity) plus an enforcement mode: `advisory` reports a shortfall,
 * `block` refuses the operation. Nothing is blocked until a tenant says so — a tenant that has
 * never saved a policy reads `isDefault: true` with every floor unset.
 */

/** One scope's floors and enforcement mode. */
export interface QualityThresholds {
  minGrade: string | null;
  minScore: number | null;
  blockOnSeverity: 'error' | 'warning' | 'info' | null;
  enforcement: 'advisory' | 'block';
}

/** The tenant's policy in force — `GET/PUT /api/quality-policy`. */
export interface QualityPolicy {
  policyVersionId: string | null;
  versionNumber: number;
  contentFingerprint: string;
  isDefault: boolean;
  import: QualityThresholds;
  export: QualityThresholds;
  /** Per-adapter-key overrides, e.g. `{ openapi: { import: { minGrade: 'B' } } }`. */
  formatOverrides: Record<string, unknown>;
  allowOverride: boolean;
  overrideRoles: string[];
  waiverTtlHours: number;
  actorLabel: string | null;
  createdAt: string | null;
}

/** Version history — `GET /api/quality-policy/versions`. */
export interface QualityPolicyVersionList {
  versions: QualityPolicy[];
  count: number;
}

/** One recorded waiver — `GET /api/quality-policy/waivers`. */
export interface QualityWaiver {
  id: string;
  scope: string;
  subjectKey: string;
  subjectLabel: string | null;
  formatKey: string | null;
  reportFingerprint: string | null;
  score: number | null;
  grade: string | null;
  reason: string;
  expiresAt: string | null;
  policyVersionId: string | null;
  actorLabel: string | null;
  actorRole: string | null;
  createdAt: string | null;
}

export interface QualityWaiverList {
  waivers: QualityWaiver[];
  count: number;
}

/** Letter grades offered as a floor, best → worst (matches the linter's grade vocabulary). */
export const QUALITY_GRADE_OPTIONS = ['A', 'B', 'C', 'D', 'F'] as const;

/** Severities offered as a floor, most → least severe. "or worse" is implied by the order. */
export const QUALITY_SEVERITY_OPTIONS = ['error', 'warning', 'info'] as const;

/** The shipped default a tenant sees before saving anything: nothing blocked. */
export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minGrade: null,
  minScore: null,
  blockOnSeverity: null,
  enforcement: 'advisory',
};

/**
 * Whether a scope's settings could ever refuse an operation.
 *
 * Used for the "advisory / blocking" badge: enforcement alone is not enough, because a `block`
 * mode with no floor has nothing to block on — exactly the server's rule.
 */
export function isBlockingConfiguration(thresholds: QualityThresholds): boolean {
  const hasFloor =
    thresholds.minGrade !== null ||
    thresholds.minScore !== null ||
    thresholds.blockOnSeverity !== null;
  return hasFloor && thresholds.enforcement === 'block';
}

/**
 * Call the quality-policy proxy.
 *
 * The proxy wraps REST responses as `{success, data, error}`; FastAPI error details can be a
 * string or an object, so both are normalized into the thrown Error's message.
 *
 * @param path Sub-path under `/api/quality-policy` (`''`, `'versions'`, `'waivers'`).
 * @param init Fetch options.
 * @returns The parsed `data` payload, or `null` for a 204.
 */
export async function qualityPolicyApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/quality-policy${path ? `/${path}` : ''}`, init);
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const err = json.error;
    const message =
      typeof err === 'object' && err !== null
        ? (err as { message?: string }).message || 'Request failed'
        : err || 'Request failed';
    throw new Error(String(message));
  }
  return json.data as T;
}
