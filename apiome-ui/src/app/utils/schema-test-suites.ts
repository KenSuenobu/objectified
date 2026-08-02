/**
 * Saved schema test suites — pure client logic (IXH-5.7, #5119).
 *
 * Types mirroring the REST models, verdict/regression display helpers, and the corpus-envelope
 * download/parse pair for the export/import round trip. Everything here is DOM-free and
 * testable without a component; the panel (`BenchSuitesPanel`) and the badge
 * (`SuiteRegressionBadge`) consume it.
 */

import type { BenchSurface } from '@/app/utils/schema-test-bench';

/** One payload of a suite, as the REST API returns it. */
export interface SuitePayload {
  name: string;
  payload_text: string;
  media_type: 'application/json' | 'application/xml';
  /** IXH-1.1 corpus class; `valid` is the only class expected to validate. */
  validity_class: 'valid' | 'invalid' | 'adversarial' | 'scale';
  synthetic: boolean;
  notes?: string | null;
  position?: number | null;
}

/** A run's verdict for one payload, with its diff against the baseline run. */
export interface SuiteRunResult {
  payload_id?: string | null;
  payload_name: string;
  expected_valid: boolean;
  valid: boolean | null;
  validated: boolean;
  status: 'passed' | 'failed' | 'error';
  previous_status?: 'passed' | 'failed' | 'error' | null;
  regression: boolean;
  findings: Array<Record<string, unknown>>;
  message?: string | null;
}

/** One run of a suite, without its results. */
export interface SuiteRunSummary {
  id: string;
  suite_version: number;
  requested_ref: string;
  resolved_revision_id?: string | null;
  resolved_version_label?: string | null;
  trigger: 'manual' | 'revision';
  status: 'completed' | 'error';
  total: number;
  passed: number;
  failed: number;
  errored: number;
  regression: boolean;
  baseline_run_id?: string | null;
  message?: string | null;
  created_at?: string | null;
}

/** A run with its per-payload results. */
export interface SuiteRunDetail extends SuiteRunSummary {
  results: SuiteRunResult[];
}

/** A suite as the REST API returns it (payloads only on detail reads). */
export interface SchemaTestSuite {
  id: string;
  name: string;
  description?: string | null;
  ref: string;
  ref_kind: 'project' | 'catalog';
  ref_artifact: string;
  ref_type?: string | null;
  suite_version: number;
  payload_count: number;
  payloads?: SuitePayload[] | null;
  latest_run?: SuiteRunSummary | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** The export envelope: the suite, an IXH-1.1 corpus manifest, and the payload files. */
export interface SuiteExportEnvelope {
  suite?: SchemaTestSuite;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; content: string }>;
}

/** The stable (version-independent) suite reference for a bench surface + artifact. */
export function suiteRefForSurface(surface: BenchSurface, artifact: string): string {
  return `${surface}/${artifact}`;
}

/** Chip classes per verdict, matching the bench's tone vocabulary. */
export function verdictToneClass(status: SuiteRunResult['status'] | SuiteRunSummary['status']): string {
  switch (status) {
    case 'passed':
    case 'completed':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300';
    case 'failed':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300';
    default:
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300';
  }
}

/**
 * The verdict diff a result row displays: `previous → current` when a baseline verdict
 * exists and differs, the bare status otherwise.
 */
export function verdictDiffLabel(result: Pick<SuiteRunResult, 'status' | 'previous_status'>): string {
  if (result.previous_status && result.previous_status !== result.status) {
    return `${result.previous_status} → ${result.status}`;
  }
  return result.status;
}

/** How many of these suites' newest runs flag a regression (feeds the badge). */
export function countRegressedSuites(suites: Array<Pick<SchemaTestSuite, 'latest_run'>>): number {
  return suites.filter((suite) => suite.latest_run?.regression === true).length;
}

/** Serialize an export envelope for download as a standalone JSON document. */
export function serializeSuiteEnvelope(envelope: SuiteExportEnvelope): string {
  return JSON.stringify(
    { manifest: envelope.manifest, files: envelope.files },
    null,
    2
  );
}

/**
 * Parse an imported envelope document (the file the export download produced, or a
 * hand-assembled one). Accepts only the exact `{ manifest, files }` shape the import
 * endpoint consumes.
 *
 * @returns The parsed envelope, or an error message describing what is missing.
 */
export function parseSuiteEnvelope(
  text: string
): { envelope: SuiteExportEnvelope } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'The file is not valid JSON.' };
  }
  if (typeof data !== 'object' || data === null) {
    return { error: 'The file must hold a JSON object with `manifest` and `files`.' };
  }
  const record = data as Record<string, unknown>;
  const manifest = record.manifest;
  if (typeof manifest !== 'object' || manifest === null ||
      !Array.isArray((manifest as Record<string, unknown>).entries)) {
    return { error: 'The `manifest` must be an IXH-1.1 corpus manifest with an `entries` list.' };
  }
  const files = record.files;
  if (!Array.isArray(files) || files.some(
    (file) => typeof file !== 'object' || file === null ||
      typeof (file as Record<string, unknown>).path !== 'string' ||
      typeof (file as Record<string, unknown>).content !== 'string'
  )) {
    return { error: 'The `files` list must hold `{ path, content }` entries.' };
  }
  return {
    envelope: {
      manifest: manifest as Record<string, unknown>,
      files: files as Array<{ path: string; content: string }>,
    },
  };
}

/** A unique payload name for "add current payload": `payload N`, skipping taken names. */
export function nextPayloadName(existing: Array<Pick<SuitePayload, 'name'>>): string {
  const taken = new Set(existing.map((payload) => payload.name));
  let index = existing.length + 1;
  let candidate = `payload ${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `payload ${index}`;
  }
  return candidate;
}
