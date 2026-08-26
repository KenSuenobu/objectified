/**
 * Where an import job's status comes from (BLK-1.4, #5526).
 *
 * The workspace runs import jobs in two places. The Projects importer and the single-file
 * Map & import wizard drive the in-process tsx worker behind `lib/db/import-actions`; the
 * catalog importer and every bulk batch start ordinary REST jobs and poll them through
 * `/api/catalog/import/{jobId}`. The two shared panels — `ImportExecutionPanel` and
 * `ImportCompletePanel` — were bound to the first, so a bulk row's *Summary* asked the local
 * job store about a REST job and was told "Job not found".
 *
 * This is the seam that lets one panel read either store. A panel takes an
 * {@link ImportJobClient}; the default is the local one, so nothing that already renders the
 * panels changes, and a bulk row hands them {@link restImportJobClient}. The two stores do not
 * offer the same verbs — the REST client can cancel a job but does not commit, roll back or
 * retry one — so a client declares only what it can do and the panels draw only that.
 *
 * {@link adaptRestImportStatus} is the other half: the REST poll payload is `snake_case` and
 * its `result` carries both the version *label* and the version *record id*, while the panels
 * read the tsx worker's `camelCase` shape whose `versionId` is the record id the Canvas link
 * needs. An adapter import's summary counts services and types rather than classes and paths;
 * those are folded onto the fields the completion panel reads so a protobuf batch does not
 * report "0 classes" for a job that landed forty types.
 */

import {
  cancelImport,
  commitImport,
  getImportStatus,
  retryImport,
  rollbackCompletedImport,
  rollbackImport,
} from '@lib/db/import-actions';
import type { ImportJobState } from './importWizardModel';

/** One structured log line, as both stores emit it. */
export interface ImportJobEvent {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  context?: unknown;
}

/** What the panels read from a job, whichever store answered. */
export interface ImportJobStatusLike {
  jobId: string;
  state: ImportJobState | string;
  percent: number;
  events: ImportJobEvent[];
  progress?: unknown;
  summary?: Record<string, unknown> | null;
  transactionPending?: boolean;
  /** `versionId` is the version **record id** — what the Canvas link needs. */
  result?: { projectId?: string; versionId?: string };
  /** A typed failure, where the store has one (REST). */
  error?: { code?: string; message?: string; remediation?: string } | null;
}

/** The verbs a job store offers. Optional ones are not offered by every store. */
export interface ImportJobClient {
  /** Which store this reads, for a test or a log to name. */
  kind: 'local' | 'rest';
  getStatus(jobId: string): Promise<ImportJobStatusLike>;
  cancel?(jobId: string): Promise<{ success: boolean }>;
  commit?(jobId: string): Promise<{ success: boolean; error?: string }>;
  rollback?(jobId: string): Promise<{ success: boolean; error?: string }>;
  rollbackCompleted?(jobId: string): Promise<{ success: boolean; error?: string }>;
  retry?(jobId: string): Promise<{ success: boolean; jobId?: string; error?: string }>;
}

/** The in-process tsx worker's jobs — what the panels always read before this seam existed. */
export const localImportJobClient: ImportJobClient = {
  kind: 'local',
  getStatus: (jobId) => getImportStatus(jobId) as Promise<ImportJobStatusLike>,
  cancel: async (jobId) => {
    const result = (await cancelImport(jobId)) as { success?: boolean } | undefined;
    return { success: result?.success !== false };
  },
  commit: (jobId) => commitImport(jobId),
  rollback: (jobId) => rollbackImport(jobId),
  rollbackCompleted: (jobId) => rollbackCompletedImport(jobId),
  retry: (jobId) => retryImport(jobId),
};

const LEVELS = new Set(['info', 'warn', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Fold a REST job summary onto the fields the completion panel reads.
 *
 * An OpenAPI job that ran through the tsx worker already carries `classesCreated` and friends
 * and passes through untouched. An adapter job (AsyncAPI, protobuf, SQL DDL, …) carries
 * `counts` instead; its types are what the designer calls classes and its operations are what
 * the panel calls paths, so those are what the panel is shown.
 *
 * @param raw The REST `summary`.
 * @param ids The produced project and version-record ids, when the job has them.
 * @returns The summary with the panel's fields present.
 */
function restSummaryForPanel(
  raw: Record<string, unknown>,
  ids: { projectId?: string; versionId?: string },
): Record<string, unknown> {
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    ...raw,
    classesCreated: asNumber(raw.classesCreated) ?? asNumber(counts.types) ?? 0,
    propertiesCreated: asNumber(raw.propertiesCreated) ?? 0,
    pathsImported: asNumber(raw.pathsImported) ?? asNumber(counts.operations) ?? 0,
    warnings: asNumber(raw.warnings) ?? 0,
    failed: asNumber(raw.failed) ?? 0,
    sourceName: asString(raw.sourceName) ?? asString(raw.format) ?? asString(raw.source),
    dryRun: raw.dryRun === true || raw.dry_run === true,
    incrementalMode: raw.incrementalMode === true || raw.incremental_mode === true,
    projectId: asString(raw.projectId) ?? ids.projectId,
    versionId: asString(raw.versionId) ?? ids.versionId,
  };
}

/**
 * Read a REST job poll payload (`GET …/imports/{job_id}`) as what the panels expect.
 *
 * Pure, and tolerant: every field is optional on the wire, and a payload this cannot read
 * comes back as an empty queued job rather than a throw, so a panel mid-poll never crashes on
 * one odd response.
 *
 * @param payload The parsed response body.
 * @returns The job in the panels' shape.
 */
export function adaptRestImportStatus(payload: unknown): ImportJobStatusLike {
  const p = isRecord(payload) ? payload : {};
  const result = isRecord(p.result) ? p.result : {};
  const error = isRecord(p.error) ? p.error : null;

  const events: ImportJobEvent[] = (Array.isArray(p.events) ? p.events : [])
    .filter(isRecord)
    .map((event) => ({
      id: asString(event.id) ?? '',
      ts: asNumber(event.ts) ?? 0,
      level: (LEVELS.has(String(event.level)) ? String(event.level) : 'info') as ImportJobEvent['level'],
      code: asString(event.code) ?? '',
      message: asString(event.message) ?? '',
      context: event.context,
    }));

  // The REST engine reports a terminal failure as a typed `error` beside the log. The panels
  // read failures out of the log, so the error joins it — once, and only when no error line
  // already says the same thing.
  const message = error ? asString(error.message) : undefined;
  if (message && !events.some((event) => event.level === 'error' && event.message === message)) {
    const remediation = asString(error?.remediation);
    events.push({
      id: 'rest-error',
      ts: events.reduce((latest, event) => Math.max(latest, event.ts), 0),
      level: 'error',
      code: asString(error?.code) ?? 'IMPORT_FAILED',
      message: remediation ? `${message} ${remediation}` : message,
    });
  }

  const projectId = asString(result.project_id);
  const versionId = asString(result.version_record_id);
  const summary = isRecord(p.summary) ? restSummaryForPanel(p.summary, { projectId, versionId }) : undefined;

  return {
    jobId: asString(p.job_id) ?? '',
    state: asString(p.state) ?? 'queued',
    percent: asNumber(p.percent) ?? 0,
    events,
    progress: isRecord(p.progress) ? p.progress : undefined,
    summary,
    result: projectId || versionId ? { projectId, versionId } : undefined,
    error: error
      ? {
          code: asString(error.code),
          message,
          remediation: asString(error.remediation),
        }
      : null,
  };
}

/**
 * The REST engine's jobs, read through the catalog import proxy.
 *
 * Offers what the proxy offers: a read and a cancel. A batch item runs to completion on its
 * own, so there is no commit step to accept, and re-running one item is the batch's call.
 */
export const restImportJobClient: ImportJobClient = {
  kind: 'rest',
  async getStatus(jobId) {
    const res = await fetch(`/api/catalog/import/${encodeURIComponent(jobId)}`, {
      credentials: 'include',
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!res.ok || json?.success === false) {
      throw new Error(typeof json?.error === 'string' ? json.error : res.statusText);
    }
    return adaptRestImportStatus(json);
  },
  async cancel(jobId) {
    const res = await fetch(`/api/catalog/import/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return { success: res.ok };
  },
};
