/**
 * Types and presentation helpers for the breaking-publish guardrail (CTG-3.4, #4478).
 *
 * The verdict is computed by apiome-rest — it classifies the head against the previous
 * published revision and compares semver majors. The UI never re-derives "is this breaking"
 * or "was the major bumped"; this module only fetches the server assessment and maps its
 * status onto CSS utility classes and copy.
 */

/** Tenant policy level resolved from the assigned style guide. */
export type BreakingPublishPolicy = 'off' | 'warn' | 'block';

/**
 * The assessment outcome.
 *
 * `disabled` / `no-baseline` / `ok` are silent; `warning` and `blocked` surface; `unavailable`
 * means the comparison could not be made, which never blocks a publish.
 */
export type BreakingPublishStatus =
  | 'disabled'
  | 'no-baseline'
  | 'ok'
  | 'warning'
  | 'blocked'
  | 'unavailable';

/** One breaking change, in changelog order. */
export interface BreakingPublishChange {
  pointer: string;
  ruleId: string;
  pathGroup: string;
  summary: string;
}

export interface BreakingPublishGuardrail {
  policy: BreakingPublishPolicy;
  status: BreakingPublishStatus;
  /** The guardrail has a warning or a block to report. */
  triggered: boolean;
  /** Publish is refused unless force-published with a reason. */
  blocked: boolean;
  breaking: boolean;
  /** Null when a version label is not semver — unknown, never assumed. */
  majorBumped: boolean | null;
  fromVersion: string | null;
  toVersion: string | null;
  baselineRevisionId: string | null;
  breakingChanges: BreakingPublishChange[];
  /** True total, which may exceed `breakingChanges.length`. */
  breakingCount: number;
  truncated: boolean;
  counts: Record<string, number>;
  maxSeverity: string | null;
  recommendedVersion: string | null;
  detail: string | null;
  message: string;
}

/** Badge CSS classes per status, keyed for the summary strip. */
const STATUS_BADGE_CLASSES: Record<BreakingPublishStatus, string> = {
  blocked: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  'no-baseline': 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  disabled: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  unavailable: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const STATUS_BADGE_FALLBACK = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';

/** Return the badge CSS classes for a guardrail status (defensive fallback for unknowns). */
export function guardrailStatusBadgeClass(status: string): string {
  return STATUS_BADGE_CLASSES[status as BreakingPublishStatus] ?? STATUS_BADGE_FALLBACK;
}

/** Short human label per status, for the summary badge. */
const STATUS_LABELS: Record<BreakingPublishStatus, string> = {
  blocked: 'Blocked',
  warning: 'Warning',
  ok: 'Compatible release',
  'no-baseline': 'Initial publication',
  disabled: 'Guardrail off',
  unavailable: 'Not checked',
};

/** Return the display label for a guardrail status. */
export function guardrailStatusLabel(status: string): string {
  return STATUS_LABELS[status as BreakingPublishStatus] ?? 'Not checked';
}

/**
 * Whether a guardrail should stop Publish in the dialog.
 *
 * Mirrors the server rule exactly — a blocked assessment is overridable only by force publish —
 * so the dialog and the 422 can never disagree.
 */
export function guardrailBlocksPublish(
  guardrail: BreakingPublishGuardrail | null,
  forcePublish: boolean
): boolean {
  return !!guardrail && guardrail.blocked && !forcePublish;
}

/**
 * Fetch the guardrail assessment for a version via the Next.js proxy.
 * @throws Error with the server message when the request fails.
 */
export async function fetchBreakingPublishGuardrail(
  projectId: string,
  versionId: string,
  options?: { signal?: AbortSignal }
): Promise<BreakingPublishGuardrail> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/breaking-publish-guardrail`,
    { method: 'GET', signal: options?.signal }
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.success === false) {
    const message =
      (data && (data.error || data.detail)) ||
      `Failed to load breaking-change guardrail (HTTP ${response.status})`;
    throw new Error(
      typeof message === 'string' ? message : 'Failed to load breaking-change guardrail'
    );
  }
  return data as BreakingPublishGuardrail;
}
