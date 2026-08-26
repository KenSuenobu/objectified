/**
 * Every rule the repository batch-import wizard applies (BLK-1.4, #5526).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Import selected — batch wizard,
 * and the BLK-1.2 / BLK-1.3 contracts the wizard renders.
 *
 * The Files tab lets a reader tick many rows. Until now *Import selected* opened the one-file
 * wizard on the first of them and toasted an apology for the rest, so onboarding a repository
 * with forty specs was forty passes through a wizard. The batch wizard is three steps —
 * **Review** the plan, **Verify** it against the workspace with nothing written, **Apply** it —
 * and every decision those steps make is here, React-free, in the same split
 * `repositoryDetailModel.ts` uses and for the same reason: a rule that lives in JSX is a rule
 * that is only ever tested through a DOM.
 *
 * What is here: what each row of the review table says and why, what a per-row override
 * means and how it becomes the BLK-1.3 request, what the header counts, which policy is in
 * force, what is excluded and why, and what the footer offers on each step.
 */

import type { ImportFooter } from '@/app/components/ade/import/importWizardModel';
import type {
  BulkItemOverride,
  BulkPlan,
  BulkPlanItem,
} from '@/app/components/ade/dashboard/catalog/bulkImportModel';

// ============================================================================
// Steps and copy
// ============================================================================

/** The wizard's three stops, in order. */
export type BatchImportStep = 'review' | 'verify' | 'apply';

/** The stepper rail. */
export const BATCH_IMPORT_STEPS: ReadonlyArray<{ id: BatchImportStep; label: string }> = [
  { id: 'review', label: 'Review' },
  { id: 'verify', label: 'Verify' },
  { id: 'apply', label: 'Apply' },
];

/** The stepper's accessible name. */
export const BATCH_IMPORT_STEPS_LABEL = 'Batch import progress';

/** The sentence under the wizard's title. */
export const BATCH_IMPORT_DESCRIPTION =
  'Review what each file would do, verify the batch against this workspace, then apply it. ' +
  'Every specification becomes its own import job, so one failure never costs you the rest.';

/** The verify step's lead, before it has run. */
export const BATCH_VERIFY_NOTE =
  'Verify runs the whole batch as a dry run: every item is resolved and validated exactly as ' +
  'the apply will resolve it, and nothing is written — no project, no version, no catalog row.';

/** The verify step's lead, once the reader chose to skip it. */
export const BATCH_VERIFY_SKIPPED_NOTE =
  'Verify was skipped. Apply will still resolve every item the same way; you just did not see ' +
  'it first.';

/** The apply step's lead, before it has run. */
export const BATCH_APPLY_NOTE =
  'Apply starts one import job per item with exactly the decisions above. Items that fail ' +
  'report their reason; the rest still import.';

/** The note under the review table explaining what an override does. */
export const BATCH_OVERRIDE_NOTE =
  'Change a row’s target to send it somewhere other than where the plan resolved it. Rows you ' +
  'leave alone apply the plan as shown.';

/** The stale-plan refusal, as the wizard leads with it. */
export const BATCH_STALE_PLAN_TITLE =
  'This workspace changed since the plan was made, so the batch was refused before anything ' +
  'was written. Re-plan to review the rows that moved.';

/**
 * The wizard's title.
 *
 * @param count How many files the reader ticked.
 * @returns For example `"Import 12 selected files"`.
 */
export function batchImportTitle(count: number): string {
  return `Import ${count} selected file${count === 1 ? '' : 's'}`;
}

// ============================================================================
// Per-row targets
// ============================================================================

/** A project the reader may append a row to — what `/api/projects` lists. */
export interface BatchProjectOption {
  id: string;
  name: string;
  slug: string;
}

/**
 * The per-row target control's value.
 *
 * `plan` applies the row's own reconciliation; `new` forces a new project; `existing:<id>`
 * appends to that project. One control carries both the mode and the project because a
 * reader overriding a row is answering one question — *where does this go?* — not two.
 */
export type BatchTargetChoice = 'plan' | 'new' | `existing:${string}`;

/** The default for every row: apply what the plan resolved. */
export const BATCH_TARGET_PLAN: BatchTargetChoice = 'plan';

/**
 * Read a target control's value.
 *
 * @param value The raw select value.
 * @returns The decision it encodes. Anything unrecognised reads as `plan`, which changes
 *   nothing — the safe direction for a value that cannot be trusted.
 */
export function parseBatchTargetChoice(
  value: string,
): { mode: 'plan' } | { mode: 'new' } | { mode: 'existing'; projectId: string } {
  if (value === 'new') return { mode: 'new' };
  if (value.startsWith('existing:')) {
    const projectId = value.slice('existing:'.length).trim();
    if (projectId) return { mode: 'existing', projectId };
  }
  return { mode: 'plan' };
}

/** Human copy for each match basis, so a row explains itself rather than asserting. */
export const BATCH_MATCH_BASIS_COPY: Record<string, string> = {
  'repository-provenance': 'imported from this path before',
  slug: 'an existing project uses this slug',
  'spec-identity': 'an existing project has this title',
};

/** What one row of the review table states about where its spec goes. */
export interface BatchRowTarget {
  /** Append, create, or still undecided. */
  kind: 'append' | 'create' | 'unresolved';
  /** The sentence: *New version of Payments API*, *New project payments-api*, *Needs a choice*. */
  label: string;
  /**
   * The version label the row creates, or `null` when it is only known once verify runs —
   * an override moves the row onto a project whose history the plan did not derive from.
   */
  version: string | null;
  /** Why: the match basis for a plan resolution, or that the reader chose it. */
  basis: string | null;
  /** Whether the reader's choice, rather than the plan, decided this row. */
  overridden: boolean;
}

/**
 * The plan's own answer for a row, as the review table phrases it.
 *
 * @param item The plan row.
 * @returns Its target with `overridden: false`.
 */
function planRowTarget(item: BulkPlanItem): BatchRowTarget {
  const resolution = item.resolution ?? 'create-project';
  const matched = item.matched_project ?? null;
  const version = item.proposed_version?.version_id ?? null;
  const basis = item.match_basis ? (BATCH_MATCH_BASIS_COPY[item.match_basis] ?? item.match_basis) : null;
  if (resolution === 'append-version' && matched) {
    return {
      kind: 'append',
      label: `New version of ${matched.name}`,
      version,
      basis,
      overridden: false,
    };
  }
  if (resolution === 'unresolved') {
    return {
      kind: 'unresolved',
      label: matched ? `Needs a choice — matches ${matched.name}` : 'Needs a choice',
      version,
      basis,
      overridden: false,
    };
  }
  return {
    kind: 'create',
    label: `New project ${item.suggested_slug}`,
    version,
    // Under `always-create` the plan reports the match it is ignoring; say so.
    basis: matched ? `matches ${matched.name} · policy creates anyway` : null,
    overridden: false,
  };
}

/**
 * What a row states, given the reader's choice for it.
 *
 * @param item The plan row.
 * @param choice The row's target control value.
 * @param projects The projects the reader may append to.
 * @returns The row's target, phrased for the table.
 */
export function batchRowTarget(
  item: BulkPlanItem,
  choice: BatchTargetChoice | string,
  projects: readonly BatchProjectOption[],
): BatchRowTarget {
  const decision = parseBatchTargetChoice(choice);
  if (decision.mode === 'plan') return planRowTarget(item);
  if (decision.mode === 'new') {
    return {
      kind: 'create',
      label: `New project ${item.suggested_slug}`,
      version: null,
      basis: 'chosen here',
      overridden: true,
    };
  }
  const project = projects.find((candidate) => candidate.id === decision.projectId);
  const matched = item.matched_project;
  const name =
    project?.name ?? (matched && matched.project_id === decision.projectId ? matched.name : null);
  return {
    kind: 'append',
    label: `New version of ${name ?? decision.projectId}`,
    // The label follows *that* project's history, which the plan did not derive; verify says.
    version: null,
    basis: 'chosen here',
    overridden: true,
  };
}

/** One option of a row's target control. */
export interface BatchTargetOption {
  value: BatchTargetChoice;
  label: string;
}

/**
 * The choices a row's target control offers.
 *
 * The plan's own resolution leads, so the default reads as what it is. A row the plan would
 * append is offered a new project instead; a row the plan would create (or could not decide)
 * is offered its match, when it has one; and every other project in the workspace is offered
 * as somewhere to append to.
 *
 * @param item The plan row.
 * @param projects The projects the reader may append to.
 * @returns The options, plan first.
 */
export function batchTargetOptions(
  item: BulkPlanItem,
  projects: readonly BatchProjectOption[],
): BatchTargetOption[] {
  const plan = planRowTarget(item);
  const matched = item.matched_project ?? null;
  const options: BatchTargetOption[] = [{ value: 'plan', label: `Plan: ${plan.label}` }];
  if (plan.kind !== 'create') {
    options.push({ value: 'new', label: `New project ${item.suggested_slug}` });
  }
  if (plan.kind !== 'append' && matched) {
    options.push({
      value: `existing:${matched.project_id}`,
      label: `New version of ${matched.name}`,
    });
  }
  for (const project of projects) {
    if (matched && project.id === matched.project_id) continue;
    options.push({ value: `existing:${project.id}`, label: `New version of ${project.name}` });
  }
  return options;
}

/**
 * The BLK-1.3 overrides a set of row choices amounts to.
 *
 * Only rows the reader moved are sent: an absent override means "apply the plan", so
 * agreeing with the plan costs nothing to express and the common case stays one click.
 *
 * @param plan The plan.
 * @param choices Each row's target control value, keyed by item key.
 * @returns The request's `overrides` list, in plan order.
 */
export function batchOverridesForRequest(
  plan: BulkPlan,
  choices: Readonly<Record<string, string>>,
): BulkItemOverride[] {
  const overrides: BulkItemOverride[] = [];
  for (const item of plan.items) {
    if (!item.importable) continue;
    const decision = parseBatchTargetChoice(choices[item.key] ?? BATCH_TARGET_PLAN);
    if (decision.mode === 'new') {
      overrides.push({ key: item.key, mode: 'new' });
    } else if (decision.mode === 'existing') {
      overrides.push({ key: item.key, mode: 'existing', project_id: decision.projectId });
    }
  }
  return overrides;
}

/**
 * The importable items whose target is still undecided — an `always-ask` row the reader has
 * not moved. The server fails each such row on its own; the wizard says so first.
 *
 * @param plan The plan.
 * @param choices Each row's target control value.
 * @returns The undecided rows' keys, in plan order.
 */
export function batchUndecidedKeys(
  plan: BulkPlan,
  choices: Readonly<Record<string, string>>,
): string[] {
  return plan.items
    .filter(
      (item) =>
        item.importable &&
        parseBatchTargetChoice(choices[item.key] ?? BATCH_TARGET_PLAN).mode === 'plan' &&
        planRowTarget(item).kind === 'unresolved',
    )
    .map((item) => item.key);
}

// ============================================================================
// Excluded rows, header counts, policy
// ============================================================================

/** Human copy for each reason a file is part of no item. */
export const BATCH_SKIPPED_REASON_COPY: Record<string, string> = {
  'not-an-item-root': 'compiled into another selected spec',
  'no-recognisable-format': 'no recognisable format',
  'over-item-limit': 'over the batch limit',
};

/** One excluded row of the review step: a file the batch will not import, and why. */
export interface BatchExcludedRow {
  path: string;
  reason: string;
}

/**
 * Everything the batch will not import, with its reason — listed rather than hidden.
 *
 * Two sources: items the plan found but no adapter can import, and files the plan attached to
 * no item at all (a shared type file another spec already compiles, a README, a file over the
 * batch ceiling).
 *
 * @param plan The plan.
 * @returns The excluded rows, items first, in plan order.
 */
export function batchExcludedRows(plan: BulkPlan): BatchExcludedRow[] {
  const rows: BatchExcludedRow[] = plan.items
    .filter((item) => !item.importable)
    .map((item) => ({
      path: item.root_path,
      reason: item.format ? `no importer for ${item.format}` : 'format not recognised',
    }));
  for (const entry of plan.skipped) {
    rows.push({ path: entry.path, reason: BATCH_SKIPPED_REASON_COPY[entry.reason] ?? entry.reason });
  }
  return rows;
}

/** The counts the header line is built from. */
export interface BatchHeaderCounts {
  items: number;
  appends: number;
  creates: number;
  unresolved: number;
  excluded: number;
}

/**
 * Count the batch as the reader has it — the plan's resolutions, with their overrides applied.
 *
 * @param plan The plan.
 * @param choices Each row's target control value.
 * @returns The counts.
 */
export function batchHeaderCounts(
  plan: BulkPlan,
  choices: Readonly<Record<string, string>>,
): BatchHeaderCounts {
  const counts: BatchHeaderCounts = {
    items: 0,
    appends: 0,
    creates: 0,
    unresolved: 0,
    excluded: batchExcludedRows(plan).length,
  };
  for (const item of plan.items) {
    if (!item.importable) continue;
    counts.items += 1;
    const target = batchRowTarget(item, choices[item.key] ?? BATCH_TARGET_PLAN, []);
    if (target.kind === 'append') counts.appends += 1;
    else if (target.kind === 'create') counts.creates += 1;
    else counts.unresolved += 1;
  }
  return counts;
}

/**
 * The header line the wizard carries throughout.
 *
 * @param counts From {@link batchHeaderCounts}.
 * @returns For example `"12 items · 9 new versions · 3 new projects · 2 excluded"`.
 */
export function batchHeaderSummary(counts: BatchHeaderCounts): string {
  const parts = [`${counts.items} item${counts.items === 1 ? '' : 's'}`];
  if (counts.appends) {
    parts.push(`${counts.appends} new version${counts.appends === 1 ? '' : 's'}`);
  }
  if (counts.creates) {
    parts.push(`${counts.creates} new project${counts.creates === 1 ? '' : 's'}`);
  }
  if (counts.unresolved) parts.push(`${counts.unresolved} needing a choice`);
  if (counts.excluded) parts.push(`${counts.excluded} excluded`);
  return parts.join(' · ');
}

/** What each policy does, in the reader's terms. */
const POLICY_COPY: Record<string, string> = {
  'append-when-matched': 'matched files add a version, the rest create a project',
  'always-create': 'every file creates a project; matches are shown but not used',
  'always-ask': 'every row needs a choice below',
};

/** Which tier a policy came from, in the reader's terms. */
const POLICY_SOURCE_COPY: Record<string, string> = {
  repository: 'repository override',
  tenant: 'workspace default',
  default: 'built-in default',
};

/**
 * The line naming the reconciliation policy in force, so the wizard never silently diverges
 * from it.
 *
 * @param plan The plan.
 * @returns For example `"Policy: append-when-matched (workspace default) — matched files add a
 *   version, the rest create a project"`, or `''` when the server reported no policy.
 */
export function batchPolicyLine(plan: BulkPlan): string {
  const policy = plan.version_policy;
  if (!policy) return '';
  const source = plan.version_policy_source
    ? POLICY_SOURCE_COPY[plan.version_policy_source] ?? plan.version_policy_source
    : null;
  const meaning = POLICY_COPY[policy];
  return `Policy: ${policy}${source ? ` (${source})` : ''}${meaning ? ` — ${meaning}` : ''}`;
}

// ============================================================================
// Footer
// ============================================================================

/** What the footer needs to know about where the wizard is. */
export interface BatchFooterState {
  step: BatchImportStep;
  /** The plan has loaded and holds at least one importable item. */
  planReady: boolean;
  /** A verify or apply run is in flight. */
  running: boolean;
  /** Verify has finished. */
  verified: boolean;
  /** The reader chose to skip verify. */
  verifySkipped: boolean;
  /** Apply has finished. */
  applied: boolean;
  /** How many items the apply would start. */
  itemCount: number;
}

/**
 * What the footer offers on each step.
 *
 * Apply is unreachable until verify has run or was deliberately skipped — the ticket's gate —
 * and Back is drawn disabled rather than removed while a run is in flight, so the row does
 * not jump. Once the batch is applied there is nothing forward of it: the dismiss verb becomes
 * *Close*.
 *
 * @param state See {@link BatchFooterState}.
 * @returns The footer's four slots.
 */
export function batchFooterFor(state: BatchFooterState): ImportFooter {
  const { step, planReady, running, verified, verifySkipped, applied, itemCount } = state;
  if (step === 'review') {
    return {
      back: null,
      cancel: { label: 'Cancel', disabled: false },
      primary: { label: 'Next: Verify →', disabled: !planReady },
      keepAnyway: null,
    };
  }
  if (step === 'verify') {
    return {
      back: { label: '← Back', disabled: running },
      cancel: { label: 'Cancel', disabled: running },
      primary:
        verified || verifySkipped
          ? { label: 'Next: Apply →', disabled: running }
          : { label: 'Run verify', disabled: running || !planReady },
      keepAnyway: null,
    };
  }
  return {
    back: { label: '← Back', disabled: running || applied },
    cancel: { label: applied ? 'Close' : 'Cancel', disabled: running },
    primary: applied
      ? null
      : {
          label: `Import ${itemCount} spec${itemCount === 1 ? '' : 's'}`,
          disabled: running || !planReady,
        },
    keepAnyway: null,
  };
}

/**
 * Whether the verify step still offers *Skip verify*.
 *
 * @param state See {@link BatchFooterState}.
 * @returns True on the verify step before it has run and while nothing is in flight.
 */
export function batchOffersSkipVerify(state: BatchFooterState): boolean {
  return state.step === 'verify' && !state.verified && !state.verifySkipped && !state.running;
}
