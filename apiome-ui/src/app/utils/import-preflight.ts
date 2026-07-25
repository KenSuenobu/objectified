/**
 * Import pre-flight client contract and gate logic (IXH-2.2, #5097).
 *
 * The catalog import wizard's **quality** step scores a candidate document *before* the commit by
 * calling `POST /api/import/preflight`, the same-origin proxy for the IXH-2.1 pre-flight API
 * (`POST /v1/tenants/{tenant}/import/preflight`, #5096). Everything the step needs to decide what
 * to render — the report shape, the fetch, the pass/warn/block gate, the finding→source-line
 * resolution, and the waiver record written when a user imports against a blocking policy — lives
 * here so the component stays presentational and each rule is unit-testable on its own.
 *
 * Three invariants the callers depend on:
 *
 *  1. **A candidate that cannot be imported is a 200 with `ok: false`.** The transport succeeded;
 *     the *answer* is "do not import this". Only a genuine transport/proxy failure is an exception,
 *     and the two degrade differently (see {@link decidePreflightGate}).
 *  2. **Nothing here writes.** Pre-flight is a dry run server-side; the wizard commits only after
 *     the user confirms on this step.
 *  3. **A missing report never reads as "policy forbids override".** `allow_override` defaults to
 *     true, matching the REST default, so a client can never invent a prohibition that no policy
 *     expressed.
 */

/** Ranked lint finding on a pre-flighted candidate (REST `ImportPreflightFinding`). */
export interface PreflightFinding {
  /** 1-based position in the ranked list (severity first, then capped rule penalty). */
  rank: number;
  /** Stable finding id when the linter minted one; survives re-lints. */
  id?: string | null;
  /** Rule id that fired. */
  rule: string;
  /** `error` | `warning` | `info`, after style-guide remapping. */
  severity: string;
  /** Rule category (naming/documentation/…), when the registry has one. */
  category?: string | null;
  /** Human-readable explanation. */
  message: string;
  /** JSON pointer / canonical model path, or an empty string when the rule cannot locate it. */
  path: string;
  /** Score penalty this single finding contributes before per-rule capping. */
  weight: number;
  /** Total capped penalty its rule contributed — the ranking key. */
  rule_penalty: number;
  /** Actionable guidance for clearing the finding, when registered. */
  remediation?: string | null;
  /** Documentation pointer (page#anchor) for the rule, when registered. */
  docs_url?: string | null;
}

/** The full lint verdict a commit would persist (REST `ImportPreflightLint`). */
export interface PreflightLint {
  score?: number | null;
  grade?: string | null;
  report_fingerprint?: string | null;
  severity_counts?: Record<string, number>;
  rule_hits?: Record<string, number>;
  categories?: Array<Record<string, unknown>>;
  findings?: PreflightFinding[];
}

/** Which importer the pre-flight ran, and how confident detection was. */
export interface PreflightDetection {
  adapter_key?: string | null;
  detected_format?: string | null;
  confidence?: number;
  matched?: boolean;
  importable?: boolean;
  ambiguous?: boolean;
  agrees_with_request?: boolean;
}

/** Identity of the style guide that governed the lint. */
export interface PreflightStyleGuide {
  guide_id?: string | null;
  name: string;
  /** `builtin` | `custom` (stored guides) or `fallback` (in-code defaults). */
  source: string;
  fingerprint: string;
}

/** One quality floor the candidate falls short of (REST `ImportPreflightPolicyFailure`). */
export interface PreflightPolicyFailure {
  /** `score` | `grade` | `severity`. */
  kind: string;
  /** What policy requires: a score, a grade, or a severity name. */
  required?: number | string | null;
  /** What the candidate has — for a severity floor, how many findings sit at or above it. */
  actual?: number | string | null;
}

/** Policy verdict for the candidate, under the tenant's quality policy (IXH-2.3, #5098). */
export interface PreflightPolicy {
  verdict: 'pass' | 'warn' | 'block';
  blocking: boolean;
  /** Which tier resolved the thresholds: `format_override` | `tenant` | `default`. */
  source: string;
  reason: string;
  threshold_score?: number | null;
  /**
   * Whether a user may commit anyway by recording a waiver. Only meaningful when `blocking`.
   * Absent on reports from a pre-`allow_override` server — treated as permitted, never forbidden.
   */
  allow_override?: boolean;
  /** `import` | `export` — always `import` on a pre-flight report. */
  scope?: string;
  /** Adapter key the thresholds were resolved for. */
  format_key?: string | null;
  /** Minimum letter grade policy requires, when it sets a grade floor. */
  min_grade?: string | null;
  /** Severity at or above which findings are unacceptable, when severity is gated. */
  block_on_severity?: string | null;
  /** `advisory` (report only) or `block` (refuse the commit). */
  enforcement?: string;
  /** Every floor the candidate misses; empty on a pass. */
  failures?: PreflightPolicyFailure[];
  /** Role slugs permitted to record a waiver for a blocking verdict. */
  override_roles?: string[];
  /** Tenant policy version applied, or null under the built-in default. */
  policy_version_id?: string | null;
  policy_content_fingerprint?: string | null;
  /** An active waiver that already downgraded this verdict, when one applied. */
  waiver_id?: string | null;
  waiver_expires_at?: string | null;
}

/** Stable taxonomy error explaining why a candidate is not importable. */
export interface PreflightError {
  code: string;
  category: string;
  message: string;
  remediation: string;
  retriable: boolean;
}

/** Canonical entity counts the candidate would contribute. */
export interface PreflightCounts {
  services?: number;
  operations?: number;
  types?: number;
  channels?: number;
}

/** The pre-flight verdict for one candidate document (REST `ImportPreflightReport`). */
export interface PreflightReport {
  ok: boolean;
  detection: PreflightDetection;
  routing?: Record<string, unknown> | null;
  paradigm?: string | null;
  format?: string | null;
  counts?: PreflightCounts;
  fingerprint?: string | null;
  lint?: PreflightLint | null;
  style_guide?: PreflightStyleGuide | null;
  policy: PreflightPolicy;
  secret_scrub?: Record<string, unknown> | null;
  error?: PreflightError | null;
  cache?: { hit: boolean; key: string; content_hash: string };
}

/** The candidate to score. Mirrors REST `ImportPreflightRequest`. */
export interface PreflightRequest {
  document_base64: string;
  source_kind?: string | null;
  filename?: string | null;
  content_type?: string | null;
  url?: string | null;
  input_kind?: 'file' | 'url' | 'paste' | 'discovery' | 'fileset' | null;
  import_target?: 'catalog' | 'types' | 'project' | null;
}

/** Severities in the order the tally and the ranked list present them. */
export const PREFLIGHT_SEVERITIES = ['error', 'warning', 'info'] as const;
export type PreflightSeverity = (typeof PREFLIGHT_SEVERITIES)[number];

/**
 * Fetch a pre-flight report for one candidate.
 *
 * @param request The candidate payload (base64 document plus format/intake hints).
 * @param signal Optional abort signal so a step exit cancels an in-flight scoring run.
 * @returns The parsed report. `ok: false` reports resolve normally — they are a *verdict*, not a
 *   failure.
 * @throws Error when the proxy/transport failed (non-2xx, `success: false`, or unparseable body).
 *   Callers surface this as the degraded "could not score" path.
 */
export async function fetchImportPreflight(
  request: PreflightRequest,
  signal?: AbortSignal,
): Promise<PreflightReport> {
  const res = await fetch('/api/import/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data?.success === false) {
    throw new Error(
      typeof data?.error === 'string' && data.error
        ? data.error
        : 'Could not score this source before importing.',
    );
  }
  if (typeof data?.ok !== 'boolean' || !data?.policy) {
    throw new Error('The pre-flight report was incomplete.');
  }
  return data as unknown as PreflightReport;
}

/** How the quality step must behave for one pre-flight outcome. */
export interface PreflightGate {
  /** `pass` | `warn` | `block` from policy; `error` when the candidate is not importable at all;
   *  `unscored` when pre-flight itself could not run. */
  tone: 'pass' | 'warn' | 'block' | 'error' | 'unscored';
  /** Whether the plain "Import" exit may commit. */
  canImport: boolean;
  /** Whether the "Import anyway" waiver exit may be offered (blocking + policy permits override). */
  canOverride: boolean;
  /** Whether a retry of the pre-flight is worth offering. */
  canRetry: boolean;
  /** One-sentence justification shown next to the disabled/enabled primary action. */
  reason: string;
}

/**
 * Decide the step's exits from a pre-flight outcome.
 *
 * The three inputs are mutually exclusive by construction: a report, a transport failure, or
 * neither (still scoring).
 *
 * @param report The pre-flight report, or `null` when none was obtained.
 * @param transportError Message from a failed pre-flight call, or `null`.
 * @returns The gate: tone, which exits are live, and why.
 *
 * Rules:
 *  - **Transport failure** → `unscored`. Nothing is known about the candidate *or* the policy, so
 *    retry is offered and proceed-without-score stays available (a policy that never answered
 *    cannot be treated as a block). This is AC "retry or proceed-without-score where policy allows".
 *  - **`ok: false`** → `error`. The candidate cannot be imported; committing would fail with the
 *    same taxonomy code, so no exit commits. Retry is offered only when the taxonomy says the error
 *    is retriable.
 *  - **Blocking policy** → `block`. The primary action is disabled with the policy's reason; the
 *    waiver exit appears only when `allow_override` is not explicitly false.
 *  - **Otherwise** → `pass` / `warn`; importing is allowed and the reason explains the verdict.
 */
export function decidePreflightGate(
  report: PreflightReport | null,
  transportError: string | null,
): PreflightGate {
  if (transportError) {
    return {
      tone: 'unscored',
      canImport: true,
      canOverride: false,
      canRetry: true,
      reason: `${transportError} No quality score was captured for this import.`,
    };
  }
  if (!report) {
    return {
      tone: 'unscored',
      canImport: false,
      canOverride: false,
      canRetry: false,
      reason: 'Scoring this source before import…',
    };
  }
  if (!report.ok) {
    return {
      tone: 'error',
      canImport: false,
      canOverride: false,
      canRetry: report.error?.retriable === true,
      reason:
        report.error?.message ??
        'This source cannot be imported as submitted, so there is nothing to commit.',
    };
  }
  const policy = report.policy;
  if (policy.blocking) {
    return {
      tone: 'block',
      canImport: false,
      canOverride: policy.allow_override !== false,
      canRetry: false,
      reason: policy.reason,
    };
  }
  return {
    tone: policy.verdict === 'warn' ? 'warn' : 'pass',
    canImport: true,
    canOverride: false,
    canRetry: false,
    reason: policy.reason,
  };
}

/** Findings for one severity, in rank order. Empty severities are still reported (count 0). */
export interface PreflightSeverityTally {
  severity: PreflightSeverity | string;
  count: number;
}

/**
 * Severity tally for the report header.
 *
 * Prefers the server's `severity_counts` (authoritative — it counts findings the list may cap) and
 * falls back to counting the findings when the server omitted it.
 *
 * @param lint The lint verdict, or null/undefined when the candidate never reached lint.
 * @returns One row per known severity in error → warning → info order, plus any unknown severity
 *   the server reported, so nothing is silently dropped.
 */
export function preflightSeverityTally(
  lint: PreflightLint | null | undefined,
): PreflightSeverityTally[] {
  const counts: Record<string, number> = {};
  const reported = lint?.severity_counts;
  if (reported && Object.keys(reported).length > 0) {
    for (const [severity, count] of Object.entries(reported)) {
      counts[severity] = Number(count) || 0;
    }
  } else {
    for (const finding of lint?.findings ?? []) {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    }
  }
  const rows: PreflightSeverityTally[] = PREFLIGHT_SEVERITIES.map((severity) => ({
    severity,
    count: counts[severity] ?? 0,
  }));
  for (const [severity, count] of Object.entries(counts)) {
    if (!(PREFLIGHT_SEVERITIES as readonly string[]).includes(severity)) {
      rows.push({ severity, count });
    }
  }
  return rows;
}

/**
 * Compare the candidate's score against the policy threshold, for the "82 / needs 90" strip.
 *
 * @param report The pre-flight report, or null.
 * @returns `null` when either the score or the threshold is unknown (nothing honest to compare),
 *   otherwise the score, the threshold, the signed shortfall, and whether the score clears it.
 */
export function preflightThresholdComparison(
  report: PreflightReport | null,
): { score: number; threshold: number; delta: number; meets: boolean } | null {
  const score = report?.lint?.score;
  const threshold = report?.policy?.threshold_score;
  if (typeof score !== 'number' || typeof threshold !== 'number') return null;
  return { score, threshold, delta: score - threshold, meets: score >= threshold };
}

/**
 * Resolve a finding's `path` to a 1-based line in the raw source, best effort.
 *
 * Findings carry a JSON pointer (`/paths/~1pets/get`) or a canonical model path (`Query.hello`),
 * neither of which the server maps to a byte offset. Rather than invent a parser per format, this
 * walks the path's segments in order and, for each, finds the first line *after* the previous match
 * that mentions that segment as a token. That is exactly how a reader would find it, works for JSON,
 * YAML, SDL, and proto alike, and degrades to `null` rather than to a wrong line.
 *
 * @param path The finding's path (JSON pointer, dotted path, or empty).
 * @param source The raw candidate text as the user pasted/uploaded it.
 * @returns The 1-based line number of the deepest segment matched, or `null` when the path is empty,
 *   the source is empty, or no segment could be located.
 */
export function locateFindingLine(path: string, source: string): number | null {
  if (!path || !source) return null;
  const segments = path
    .split(/[/.]/)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~').trim())
    .filter((segment) => segment.length > 0 && segment !== '#');
  if (segments.length === 0) return null;

  const lines = source.split('\n');
  let cursor = 0;
  let matched: number | null = null;
  for (const segment of segments) {
    const needle = segment.toLowerCase();
    for (let i = cursor; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        matched = i + 1;
        cursor = i + 1;
        break;
      }
    }
  }
  return matched;
}

/**
 * A recorded waiver: a user committed an import that policy would have blocked.
 *
 * The ledger is server-side (IXH-2.3): {@link recordImportQualityWaiver} POSTs the record to
 * `/api/quality-policy/waivers`, where the tenant policy decides whether the caller's role may
 * waive at all and stamps the expiry. The same record is also kept in localStorage as a fallback,
 * because a user who chose to import must never be stopped by an unreachable ledger — but only
 * the server copy makes the server-side import gate let the commit through.
 */
export interface ImportQualityWaiver {
  /** ISO-8601 instant the waiver was recorded. */
  recordedAt: string;
  /** Candidate filename / label as shown in the wizard. */
  label: string;
  /** SHA-256 of the candidate bytes, from the pre-flight cache key. */
  contentHash: string | null;
  /** Fingerprint of the lint verdict that was waived. */
  reportFingerprint: string | null;
  /** Score and grade at the time of the waiver. */
  score: number | null;
  grade: string | null;
  /** The policy verdict that was overridden. */
  policyVerdict: string;
  policySource: string;
  policyReason: string;
  thresholdScore: number | null;
  /** The user's justification, when the step collected one. */
  justification: string | null;
}

const WAIVER_STORAGE_KEY = 'apiome.import-quality-waivers.v1';

/** Request body for `POST /api/quality-policy/waivers` (REST `QualityWaiverCreateRequest`). */
export interface ImportQualityWaiverRequest {
  scope: 'import';
  subjectKey: string;
  subjectLabel?: string | null;
  formatKey?: string | null;
  reportFingerprint?: string | null;
  score?: number | null;
  grade?: string | null;
  reason: string;
}

/**
 * Project a waiver record onto the server's grant request.
 *
 * @param waiver The record built by {@link buildImportQualityWaiver}.
 * @param formatKey Adapter key the verdict was resolved for, so the waiver cannot silently cover
 *   another format's gate for the same bytes.
 * @returns The request body, or `null` when the record carries no content hash — the server
 *   matches waivers on that hash, so a record without one could never be honoured.
 */
export function buildImportQualityWaiverRequest(
  waiver: ImportQualityWaiver,
  formatKey?: string | null,
): ImportQualityWaiverRequest | null {
  if (!waiver.contentHash) return null;
  return {
    scope: 'import',
    subjectKey: waiver.contentHash,
    subjectLabel: waiver.label,
    formatKey: formatKey ?? null,
    reportFingerprint: waiver.reportFingerprint,
    score: waiver.score,
    grade: waiver.grade,
    reason: waiver.justification || waiver.policyReason || 'Imported against a blocking quality policy',
  };
}

/** Most recent waivers retained; older entries are dropped so the key cannot grow without bound. */
export const IMPORT_QUALITY_WAIVER_LIMIT = 50;

/**
 * Build the waiver record for an override, without persisting it.
 *
 * @param report The blocking report being overridden.
 * @param label Candidate filename / label.
 * @param justification The user's stated reason, or null when none was given.
 * @param recordedAt ISO instant to stamp (injectable so tests are deterministic).
 */
export function buildImportQualityWaiver(
  report: PreflightReport,
  label: string,
  justification: string | null,
  recordedAt: string,
): ImportQualityWaiver {
  return {
    recordedAt,
    label,
    contentHash: report.cache?.content_hash ?? null,
    reportFingerprint: report.lint?.report_fingerprint ?? null,
    score: typeof report.lint?.score === 'number' ? report.lint.score : null,
    grade: report.lint?.grade ?? null,
    policyVerdict: report.policy.verdict,
    policySource: report.policy.source,
    policyReason: report.policy.reason,
    thresholdScore:
      typeof report.policy.threshold_score === 'number' ? report.policy.threshold_score : null,
    justification: justification && justification.trim() ? justification.trim() : null,
  };
}

/** Read the recorded waivers, newest first. Returns `[]` off-browser or on unreadable storage. */
export function readImportQualityWaivers(): ImportQualityWaiver[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(WAIVER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ImportQualityWaiver[]) : [];
  } catch {
    return [];
  }
}

/**
 * Keep one waiver in the local fallback list, newest first, capped at
 * {@link IMPORT_QUALITY_WAIVER_LIMIT}.
 *
 * Storage failures (quota, private mode) are swallowed: an unrecordable waiver must never block the
 * import the user explicitly chose to make.
 */
export function cacheImportQualityWaiverLocally(waiver: ImportQualityWaiver): void {
  if (typeof window === 'undefined') return;
  try {
    const next = [waiver, ...readImportQualityWaivers()].slice(0, IMPORT_QUALITY_WAIVER_LIMIT);
    window.localStorage.setItem(WAIVER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — the import still proceeds */
  }
}

/** What recording a waiver produced, so the step can explain a refusal instead of silently failing. */
export interface ImportQualityWaiverOutcome {
  /** True when the server accepted and stored the waiver — the only case the import gate honours. */
  recorded: boolean;
  /** Server-issued waiver id, when it was recorded. */
  id?: string | null;
  /** When the waiver stops being honoured (ISO-8601), when the server said so. */
  expiresAt?: string | null;
  /** Why the grant failed — a role the policy does not name, or an unreachable ledger. */
  error?: string;
}

/**
 * Record one waiver in the tenant's server-side ledger, falling back to local storage.
 *
 * The server is the authority: it checks that the tenant's policy permits an override and names
 * the caller's role, and it stamps the expiry from the policy's TTL. A rejected grant is reported
 * back so the step can say *why* rather than pretending the waiver exists — the subsequent commit
 * would be refused by the same policy anyway.
 *
 * @param waiver The record to store.
 * @param formatKey Adapter key the verdict was resolved for.
 * @returns The outcome; `recorded` is false when the server refused or could not be reached.
 */
export async function recordImportQualityWaiver(
  waiver: ImportQualityWaiver,
  formatKey?: string | null,
): Promise<ImportQualityWaiverOutcome> {
  cacheImportQualityWaiverLocally(waiver);
  const body = buildImportQualityWaiverRequest(waiver, formatKey);
  if (!body) {
    return { recorded: false, error: 'This report carries no content hash to waive against.' };
  }
  try {
    const res = await fetch('/api/quality-policy/waivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { id?: string; expiresAt?: string };
      error?: unknown;
    };
    if (!res.ok || json.success === false) {
      const error = json.error;
      return {
        recorded: false,
        error:
          typeof error === 'string' && error
            ? error
            : 'The waiver could not be recorded for this tenant.',
      };
    }
    return { recorded: true, id: json.data?.id ?? null, expiresAt: json.data?.expiresAt ?? null };
  } catch {
    return { recorded: false, error: 'The waiver ledger could not be reached.' };
  }
}
