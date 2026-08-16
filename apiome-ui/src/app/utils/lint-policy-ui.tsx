/**
 * Lint policy decision chrome (CLX-1.3, #4850).
 *
 * Keeps raw finding severity separate from the effective policy decision state shown as a badge.
 */

import { cn } from '@lib/utils';

export type LintDecisionState =
  | 'open'
  | 'acknowledged'
  | 'waiver_requested'
  | 'waived'
  | 'fixed'
  | 'false_positive';

const STATE_LABEL: Record<LintDecisionState, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  waiver_requested: 'Waiver requested',
  waived: 'Waived',
  fixed: 'Fixed',
  false_positive: 'False positive',
};

const STATE_CLASS: Record<LintDecisionState, string> = {
  open: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  acknowledged: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  waiver_requested: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  waived: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  fixed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  false_positive: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
};

/** Badge showing effective decision state (distinct from raw severity). */
export function LintDecisionBadge({
  state,
  waived,
}: {
  state: string;
  waived?: boolean;
}) {
  const normalized = (STATE_LABEL[state as LintDecisionState] ? state : 'open') as LintDecisionState;
  return (
    <span
      data-testid="lint-decision-badge"
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide',
        STATE_CLASS[normalized],
      )}
      title={
        waived
          ? 'Policy decision: waived (raw severity still shown separately)'
          : `Policy decision: ${STATE_LABEL[normalized]}`
      }
    >
      {STATE_LABEL[normalized]}
    </span>
  );
}

/** Annotated finding from GET …/lint/policy. */
export interface LintPolicyAnnotatedFinding {
  evidence?: {
    sourceFingerprint?: string | null;
    severity?: string | null;
    ruleId?: string | null;
    message?: string | null;
  };
  effectiveState?: string;
  waived?: boolean;
}

export interface LintPolicyResponsePayload {
  evaluation?: { passed?: boolean; gateResults?: Record<string, unknown> };
  findings?: LintPolicyAnnotatedFinding[];
}

/** Index policy findings by source fingerprint for O(1) badge lookup. */
export function policyDecisionsByFingerprint(
  payload: LintPolicyResponsePayload | null | undefined,
): Record<string, { state: string; waived: boolean }> {
  const out: Record<string, { state: string; waived: boolean }> = {};
  for (const row of payload?.findings || []) {
    const fp = row.evidence?.sourceFingerprint;
    if (!fp) continue;
    out[fp] = {
      state: row.effectiveState || 'open',
      waived: Boolean(row.waived),
    };
  }
  return out;
}
