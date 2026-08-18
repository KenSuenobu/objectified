/**
 * Lint policy decision chrome (CLX-1.3, #4850; re-skinned by HIVE-5.8, #5311).
 *
 * Keeps raw finding severity separate from the effective policy decision state shown as a badge.
 */

import { Badge } from '@/app/components/ui/Badge';
import {
  LINT_DECISION_STATE_LABEL,
  isLintDecisionState,
  type LintDecisionState,
} from './lint-decision-vocabulary';

// The vocabulary itself lives in `lint-decision-vocabulary.ts` so the two pure modules that
// need only the words do not have to import a component to get them. Re-exported here
// because every existing call site reaches for `LintDecisionState` under this name.
export {
  LINT_DECISION_STATES,
  LINT_DECISION_STATE_LABEL,
  isLintDecisionState,
  lintDecisionStateLabel,
  type LintDecisionState,
} from './lint-decision-vocabulary';

/**
 * Badge showing effective decision state (distinct from raw severity).
 *
 * The six state strings are entries in the shared status vocabulary
 * (`ui/statusVocabulary.ts`), so a waiver request is the same orange here, in the workspace
 * queue and in the catalog lint panel, and it follows all nine themes. This component is what
 * is left once the colour is data: the normalisation and the tooltip that says the badge is a
 * *policy decision*, never the finding's own severity.
 *
 * @param props.state The finding's effective decision state.
 * @param props.waived Whether the decision is a granted waiver, which the tooltip spells out.
 * @returns The badge.
 */
export function LintDecisionBadge({
  state,
  waived,
}: {
  state: string;
  waived?: boolean;
}) {
  const normalized: LintDecisionState = isLintDecisionState(state) ? state : 'open';
  return (
    <Badge
      data-testid="lint-decision-badge"
      status={normalized}
      title={
        waived
          ? 'Policy decision: waived (raw severity still shown separately)'
          : `Policy decision: ${LINT_DECISION_STATE_LABEL[normalized]}`
      }
    >
      {LINT_DECISION_STATE_LABEL[normalized]}
    </Badge>
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
