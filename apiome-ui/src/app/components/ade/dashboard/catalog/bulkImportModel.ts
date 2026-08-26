/**
 * The bulk-import wire shapes and the rules for reading them (MFI-29.5, BLK-1.2, BLK-1.3).
 *
 * `CatalogBulkImportPanel` is the one surface that runs a batch — the catalog wizard's and the
 * repository Files tab's alike — and this is the half of it that is not React: what the three
 * endpoints return, how a start row and its job's status fold into one result row, and what
 * that row *says* about where a spec went. Kept apart so the repository batch wizard (BLK-1.4)
 * can read the same rows without rendering the panel, and so each rule has a test that needs
 * no DOM.
 *
 * Every BLK-1.2 / BLK-1.3 field is optional. A deployment that predates them returns a plan
 * without reconciliation and a result without destinations, and both read as "everything is
 * new" — which is exactly what such a server means.
 */

/** A file in the payload that belongs to no importable item. */
export interface BulkSkippedMember {
  path: string;
  reason: string;
}

/** The existing project a planned item resolves to (BLK-1.2). */
export interface BulkMatchedProject {
  project_id: string;
  name: string;
  slug: string;
}

/** The version label a planned item would create, and how it was derived (BLK-1.2). */
export interface BulkProposedVersion {
  version_id: string;
  derived_from: 'default' | 'version-bump' | 'next-available';
  previous_version_id?: string | null;
}

/** What applying the plan now would do with an item (BLK-1.2). */
export type BulkResolution = 'append-version' | 'create-project' | 'unresolved';

/** One independent spec found in the payload (a row of the plan). */
export interface BulkPlanItem {
  key: string;
  root_path: string;
  members: string[];
  total_bytes: number;
  source_kind?: string | null;
  format?: string | null;
  confidence?: number | null;
  importable: boolean;
  predicted_target: 'project' | 'catalog';
  input_kind: 'file' | 'fileset';
  suggested_name: string;
  suggested_slug: string;
  reason: string;
  /** BLK-1.2: what applying this plan now would do with the item. */
  resolution?: BulkResolution;
  matched_project?: BulkMatchedProject | null;
  match_basis?: 'repository-provenance' | 'slug' | 'spec-identity' | null;
  match_detail?: string | null;
  match_confidence?: number | null;
  proposed_version?: BulkProposedVersion | null;
}

/** The reconciliation policy a plan was resolved under (BLK-1.2). */
export type BulkVersionPolicy = 'append-when-matched' | 'always-create' | 'always-ask';

/** The partition of one payload, as returned by `/api/catalog/import/bulk/plan`. */
export interface BulkPlan {
  items: BulkPlanItem[];
  skipped: BulkSkippedMember[];
  truncated: boolean;
  total_items: number;
  max_items: number;
  source_label: string;
  /** BLK-1.2: the reconciliation policy the plan was resolved under, and which tier set it. */
  version_policy?: BulkVersionPolicy;
  version_policy_source?: 'repository' | 'tenant' | 'default';
  /**
   * BLK-1.3: an opaque token describing these resolutions. Echoed on the submit so a plan
   * that drifted since it was reviewed is refused rather than applied.
   */
  plan_fingerprint?: string;
  summary: {
    items: number;
    importable: number;
    unimportable: number;
    skipped_files: number;
    by_target: Record<string, number>;
    by_format: Record<string, number>;
    by_resolution?: Record<string, number>;
    matched?: number;
  };
}

/** One reviewer decision for one item, as the submit body carries it (BLK-1.3). */
export interface BulkItemOverride {
  key: string;
  mode?: 'existing' | 'new';
  project_id?: string;
  version_id?: string;
}

/** A taxonomy-coded failure, either from starting an item or from its job. */
export interface BulkItemError {
  code?: string;
  category?: string;
  message?: string;
  remediation?: string;
  retriable?: boolean;
}

/** What one item's job was started to do (BLK-1.3): the applied form of the resolution. */
export type BulkAppliedResolution = 'append-version' | 'create-project';

/** One row of the submit response: accepted with a job, or failed before one. */
export interface BulkStartItem {
  key: string;
  root_path: string;
  source_kind?: string | null;
  format?: string | null;
  predicted_target: 'project' | 'catalog';
  name: string;
  slug: string;
  state: 'accepted' | 'failed';
  job_id?: string | null;
  error?: BulkItemError | null;
  /** BLK-1.3: the decision the job was started with. */
  resolution?: BulkAppliedResolution | null;
  target_project_id?: string | null;
  version_id?: string | null;
  overridden?: boolean;
  resolution_detail?: string | null;
}

/** What a finished item *did* to the tenant (BLK-1.3), read back from the catalog. */
export type BulkOutcome = 'project-created' | 'version-appended';

/** One row of the status roll-up. */
export interface BulkStatusItem {
  key: string;
  job_id: string;
  state: string;
  percent: number;
  target?: string | null;
  project_slug?: string | null;
  project_id?: string | null;
  /** BLK-1.3: the version label the import created, and what that did. */
  version_id?: string | null;
  outcome?: BulkOutcome | null;
  error?: BulkItemError | null;
}

/** One way a re-planned batch disagrees with the plan that was reviewed (BLK-1.3). */
export interface BulkPlanDrift {
  key: string;
  change: 'resolution' | 'target' | 'version' | 'item-missing' | 'item-added' | string;
  reviewed: string;
  current: string;
  detail: string;
}

/** One row of the rendered result list: a planned spec plus what became of it. */
export interface BulkResultRow {
  key: string;
  name: string;
  format?: string | null;
  target?: string | null;
  state: string;
  percent: number;
  jobId: string | null;
  projectSlug?: string | null;
  projectId?: string | null;
  error?: BulkItemError | null;
  /** BLK-1.3: what the item was started to do — the same on a dry run as on an apply. */
  resolution: BulkAppliedResolution | null;
  targetProjectId: string | null;
  versionId: string | null;
  overridden: boolean;
  resolutionDetail: string | null;
  /** BLK-1.3: what the item actually did, once its job finished. */
  outcome: BulkOutcome | null;
}

/** Terminal job states — the batch stops polling when every item is one of these. */
export const BULK_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'canceled',
  'rolled-back',
  'not-found',
]);

/** The taxonomy code the server refuses a stale plan with (BLK-1.3). */
export const TARGET_PLAN_STALE = 'TARGET_PLAN_STALE';

/**
 * Join the start rows with their job states, so an item that never started still has a row.
 *
 * @param started The submit response's rows.
 * @param statuses The latest roll-up rows; empty before the first poll.
 * @returns One result row per started item, in submit order.
 */
export function mergeBulkRows(started: BulkStartItem[], statuses: BulkStatusItem[]): BulkResultRow[] {
  const byKey = new Map(statuses.map((row) => [row.key, row]));
  return started.map((item) => {
    const decided = {
      resolution: item.resolution ?? null,
      targetProjectId: item.target_project_id ?? null,
      versionId: item.version_id ?? null,
      overridden: Boolean(item.overridden),
      resolutionDetail: item.resolution_detail ?? null,
    };
    if (item.state === 'failed') {
      return {
        key: item.key,
        name: item.name,
        format: item.format,
        target: item.predicted_target,
        state: 'failed',
        percent: 0,
        jobId: null,
        projectSlug: null,
        projectId: null,
        error: item.error ?? null,
        outcome: null,
        ...decided,
      };
    }
    const job = byKey.get(item.key);
    return {
      key: item.key,
      name: item.name,
      format: item.format,
      target: job?.target ?? item.predicted_target,
      state: job?.state ?? 'queued',
      percent: job?.percent ?? 0,
      jobId: item.job_id ?? null,
      projectSlug: job?.project_slug ?? null,
      projectId: job?.project_id ?? null,
      error: job?.error ?? null,
      outcome: job?.outcome ?? null,
      ...decided,
      // The job's own label is what was created; the submit's is what was asked for.
      versionId: job?.version_id ?? decided.versionId,
    };
  });
}

/**
 * Render a taxonomy error as the sentence the user can act on.
 *
 * @param error The error, or nothing.
 * @returns Message, remediation and code joined; `''` when there is no error.
 */
export function bulkErrorText(error: BulkItemError | null | undefined): string {
  if (!error) return '';
  const parts = [error.message, error.remediation].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  if (error.code) parts.push(`(code ${error.code})`);
  return parts.join(' ');
}

/**
 * What one result row says about where its spec went (BLK-1.3).
 *
 * Prefers the realized `outcome` once the job has one — the roll-up read it back from the
 * catalog, so it states what happened — and falls back to what the job was *started* to do,
 * which is the same answer one tense earlier and the only one a dry run can give.
 *
 * @param row A merged result row.
 * @returns The phrase, or `''` when the item never got far enough to have a destination.
 */
export function bulkRowDestination(row: BulkResultRow): string {
  const where = row.projectSlug ?? row.targetProjectId ?? null;
  const version = row.versionId ? `v${row.versionId}` : null;
  if (row.outcome === 'version-appended') {
    return where ? `Appended ${version ?? 'a version'} to ${where}` : `Appended ${version ?? 'a version'}`;
  }
  if (row.outcome === 'project-created') {
    return where ? `Created ${where}${version ? ` at ${version}` : ''}` : `Created a project${version ? ` at ${version}` : ''}`;
  }
  if (row.resolution === 'append-version') {
    return `New version${version ? ` ${version}` : ''}${where ? ` of ${where}` : ''}`;
  }
  if (row.resolution === 'create-project') {
    return `New project${where ? ` ${where}` : ''}${version ? ` at ${version}` : ''}`;
  }
  // A server that predates BLK-1.3 reports neither a decision nor an outcome — only the slug
  // the job produced, which is the pre-BLK reading: something was created under it.
  if (row.projectSlug) return `Created ${row.projectSlug}`;
  return '';
}

/**
 * Count a finished (or running) batch for its one-line summary.
 *
 * @param rows The merged result rows.
 * @returns Completed, failed and still-pending counts.
 */
export function bulkRowCounts(rows: BulkResultRow[]): {
  completed: number;
  failed: number;
  pending: number;
} {
  const completed = rows.filter((row) => row.state === 'completed').length;
  const failed = rows.filter(
    (row) =>
      row.state === 'failed' ||
      row.state === 'canceled' ||
      row.state === 'rolled-back' ||
      row.state === 'not-found',
  ).length;
  return { completed, failed, pending: rows.length - completed - failed };
}

/**
 * The line a finished batch leads with.
 *
 * A verify pass (`dryRun`) validated rather than imported, and says so — the rows are the
 * same rows the apply will produce, but nothing landed.
 *
 * @param rows The merged result rows.
 * @param dryRun Whether the batch was the verify pass.
 * @returns For example `"Bulk import finished: 3 imported, 1 failed of 4."`.
 */
export function bulkRunSummaryLine(rows: BulkResultRow[], dryRun: boolean): string {
  const { completed, failed } = bulkRowCounts(rows);
  const verb = dryRun ? 'validated' : 'imported';
  const lead = dryRun ? 'Verify finished' : 'Bulk import finished';
  return `${lead}: ${completed} ${verb}${failed > 0 ? `, ${failed} failed` : ''} of ${rows.length}.`;
}

/**
 * Read a refused submit as a stale-plan refusal, when that is what it was (BLK-1.3).
 *
 * The UI proxy hands the REST `detail` through on a failed submit; a stale plan carries
 * `code: TARGET_PLAN_STALE` and a per-item `drift` list. Anything else is some other failure
 * and reads as `null`.
 *
 * @param payload The failed submit response body.
 * @returns The drift rows, or `null` when the refusal was not a stale plan.
 */
export function bulkStalePlanDrift(payload: unknown): BulkPlanDrift[] | null {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  if (!detail || typeof detail !== 'object') return null;
  const { code, drift } = detail as { code?: unknown; drift?: unknown };
  if (code !== TARGET_PLAN_STALE) return null;
  if (!Array.isArray(drift)) return [];
  return drift
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row) => ({
      key: String(row.key ?? ''),
      change: String(row.change ?? 'changed'),
      reviewed: String(row.reviewed ?? ''),
      current: String(row.current ?? ''),
      detail: String(row.detail ?? ''),
    }));
}
