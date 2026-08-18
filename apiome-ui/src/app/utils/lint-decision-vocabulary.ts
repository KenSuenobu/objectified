/**
 * The lint decision vocabulary (CLX-1.3, #4850; extracted by HIVE-5.8, #5311).
 *
 * The six states a finding's policy decision moves through, their labels, and nothing else.
 * Extracted from `lint-policy-ui.tsx` because that module also draws a badge — so importing
 * the *words* pulled React in with them, and the two places that need only the words are
 * `utils/lint-workspace.ts` (a pure module the API proxies share) and
 * `components/ade/lintWorkspace/lintWorkspaceModel.ts` (the workspace's own derivations).
 * Before this, each kept its own copy of the same six strings.
 */

/** The state a finding's policy decision is in. */
export type LintDecisionState =
  | 'open'
  | 'acknowledged'
  | 'waiver_requested'
  | 'waived'
  | 'fixed'
  | 'false_positive';

/**
 * The six states, in the order every surface lists them — the order of the state machine
 * itself, from untouched to judged.
 */
export const LINT_DECISION_STATES: readonly LintDecisionState[] = [
  'open',
  'acknowledged',
  'waiver_requested',
  'waived',
  'fixed',
  'false_positive',
] as const;

/** Sentence-case label for each state, as every lint surface writes it. */
export const LINT_DECISION_STATE_LABEL: Readonly<Record<LintDecisionState, string>> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  waiver_requested: 'Waiver requested',
  waived: 'Waived',
  fixed: 'Fixed',
  false_positive: 'False positive',
};

/**
 * Whether a raw string is one of the six states.
 *
 * @param state Raw effective-state string from the findings or policy endpoints.
 * @returns True when the vocabulary knows it.
 */
export function isLintDecisionState(state: string): state is LintDecisionState {
  return Object.prototype.hasOwnProperty.call(LINT_DECISION_STATE_LABEL, state);
}

/**
 * The label for a decision state, tolerating a string this build has not been taught.
 *
 * @param state Raw effective-state string.
 * @returns The sentence-case label, falling back to `Open` — the state the machine starts
 *   at, and what every lint surface has always drawn for an unrecognised value.
 */
export function lintDecisionStateLabel(state: string): string {
  return isLintDecisionState(state)
    ? LINT_DECISION_STATE_LABEL[state]
    : LINT_DECISION_STATE_LABEL.open;
}
