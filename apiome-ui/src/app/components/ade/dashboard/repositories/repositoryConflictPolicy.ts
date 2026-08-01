/**
 * Repository refresh conflict policy — types and presentation rules (RAR-4.5, #3531).
 *
 * When auto-refresh re-imports a changed file it can find that the version the original
 * import produced has been hand-edited in Apiome since. The divergence guard (RAR-4.4)
 * detects that; this policy decides what happens next. Three answers, and the difference
 * between them is the difference between "we lost an afternoon of edits" and "we shipped a
 * stale spec", so the screen has to say what each one *does*, not just name it.
 *
 * Two rules live here rather than in the component:
 *
 *  * {@link effectivePolicyFor} — the same `file -> repository -> default` precedence the
 *    server applies, so the panel can show a file's real policy without asking again.
 *  * {@link POLICY_COPY} — one place for the label, the one-line consequence, and the tone,
 *    so the selector, the override rows and the tests all read the same words.
 *
 * Deliberately React-free, so every rule is unit-testable without a DOM — the same split as
 * `repositoryWebhookIpAllowlist.ts` and `repositoryQuotaTelemetry.ts` next to it.
 */

/** The three policies the API accepts; the tokens match the stored values exactly. */
export type ConflictPolicy = 'overwrite' | 'hold-for-review' | 'new-branch';

/** The policy in force when neither the file nor the repository sets one. */
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = 'hold-for-review';

/** Every policy, in the order the selector renders them (safest default in the middle). */
export const CONFLICT_POLICIES: readonly ConflictPolicy[] = [
  'hold-for-review',
  'overwrite',
  'new-branch',
] as const;

/** One per-file exception to the repository-wide policy. */
export interface ConflictPolicyOverride {
  branch: string;
  path: string;
  policy: ConflictPolicy;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** What `GET /api/repositories/{id}/conflict-policy` returns. */
export interface ConflictPolicyResponse {
  success: boolean;
  repositoryId: string;
  policy: ConflictPolicy;
  defaultPolicy: ConflictPolicy;
  availablePolicies: ConflictPolicy[];
  overrides: ConflictPolicyOverride[];
  error?: string;
}

/** Where an applied policy came from, for the "inherits from repository" copy. */
export type ConflictPolicySource = 'file' | 'repository' | 'default';

/**
 * Label, consequence and tone for each policy.
 *
 * `tone` is what the row is drawn with: `overwrite` is the only policy that can lose work
 * that is not in the repository, so it is the only one drawn as a warning.
 */
export const POLICY_COPY: Record<
  ConflictPolicy,
  { label: string; detail: string; tone: 'good' | 'neutral' | 'warn' }
> = {
  'hold-for-review': {
    label: 'Hold for review',
    detail:
      'The refresh is skipped and the file is flagged as diverged. Nothing is overwritten until someone resolves it.',
    tone: 'good',
  },
  overwrite: {
    label: 'Overwrite',
    detail:
      'The refresh wins: the repository version replaces the edits made in Apiome. The divergence is still recorded.',
    tone: 'warn',
  },
  'new-branch': {
    label: 'New branch',
    detail:
      'The current version is left untouched and the refresh lands on a new branch, so neither the edit nor the upstream change is lost.',
    tone: 'neutral',
  },
};

/** Panel/badge accent per tone, so the consequence reads before the text does. */
export const POLICY_TONE_CLASSES: Record<'good' | 'neutral' | 'warn', string> = {
  good: 'border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300',
  neutral: 'border-gray-200 text-gray-700 dark:border-gray-700 dark:text-gray-300',
  warn: 'border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300',
};

/**
 * Narrow an arbitrary value to a {@link ConflictPolicy}.
 *
 * Anything unrecognised — including null, undefined and a token from a newer server —
 * yields `fallback`, which mirrors the server's rule that an unusable value means "not set"
 * rather than an error. Because the broadest fallback is hold-for-review, every degradation
 * path is the safe one.
 *
 * @param value Raw value from an API payload or a form control.
 * @param fallback What to return when `value` is not a known policy.
 * @returns The narrowed policy.
 */
export function asConflictPolicy(
  value: unknown,
  fallback: ConflictPolicy = DEFAULT_CONFLICT_POLICY
): ConflictPolicy {
  return typeof value === 'string' && (CONFLICT_POLICIES as readonly string[]).includes(value)
    ? (value as ConflictPolicy)
    : fallback;
}

/**
 * Resolve the policy in force for one file, and say where it came from.
 *
 * Applies the server's precedence — `per-file override -> repository policy -> default` —
 * so the panel can label a row "inherits from repository" without a second request.
 *
 * @param path Repository-relative path of the file.
 * @param branch The branch the file was imported from.
 * @param repositoryPolicy The repository-wide policy.
 * @param overrides Every per-file override the repository has.
 * @returns The applied policy and its source.
 */
export function effectivePolicyFor(
  path: string,
  branch: string,
  repositoryPolicy: ConflictPolicy,
  overrides: readonly ConflictPolicyOverride[]
): { policy: ConflictPolicy; source: ConflictPolicySource } {
  const match = overrides.find((o) => o.path === path && o.branch === branch);
  if (match) return { policy: asConflictPolicy(match.policy), source: 'file' };
  return { policy: repositoryPolicy, source: 'repository' };
}

/**
 * Parse a conflict-policy API payload into the panel's shape.
 *
 * Every field is narrowed rather than trusted: a malformed payload renders the safe default
 * with no overrides instead of throwing inside a render.
 *
 * @param raw The parsed JSON body.
 * @returns The normalised response.
 */
export function parseConflictPolicyResponse(raw: unknown): ConflictPolicyResponse {
  const body = (raw ?? {}) as Record<string, unknown>;
  const policy = asConflictPolicy(body.policy);
  const overridesRaw = Array.isArray(body.overrides) ? body.overrides : [];
  return {
    success: body.success !== false,
    repositoryId: typeof body.repositoryId === 'string' ? body.repositoryId : '',
    policy,
    defaultPolicy: asConflictPolicy(body.defaultPolicy),
    availablePolicies: Array.isArray(body.availablePolicies)
      ? body.availablePolicies.map((p) => asConflictPolicy(p))
      : [...CONFLICT_POLICIES],
    overrides: overridesRaw.map((o) => {
      const row = (o ?? {}) as Record<string, unknown>;
      return {
        branch: typeof row.branch === 'string' ? row.branch : '',
        path: typeof row.path === 'string' ? row.path : '',
        policy: asConflictPolicy(row.policy),
        createdBy: typeof row.createdBy === 'string' ? row.createdBy : null,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
      };
    }),
  };
}

/**
 * One-sentence summary of what this repository's configuration does on a divergence.
 *
 * Written so the count of exceptions is never silently dropped: a repository set to
 * "overwrite" with four files held back is a materially different setup from one with none,
 * and the difference has to be visible without expanding the table.
 *
 * @param policy The repository-wide policy.
 * @param overrideCount How many files deviate from it.
 * @returns The summary sentence.
 */
export function conflictPolicySummary(policy: ConflictPolicy, overrideCount: number): string {
  const base = `${POLICY_COPY[policy].label} applies to every file in this repository`;
  if (overrideCount === 0) return `${base}.`;
  const exception =
    overrideCount === 1 ? '1 file has its own policy' : `${overrideCount} files have their own policy`;
  return `${base}, except ${exception}.`;
}
