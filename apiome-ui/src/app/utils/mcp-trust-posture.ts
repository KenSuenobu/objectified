/**
 * Helpers for the MCP trust-posture panel (CLX-3.2, #4856).
 *
 * Parses the `GET …/versions/{id}/trust-posture` report and shapes it for rendering. Two concerns
 * live here rather than in the component, because they are the report's honesty guarantees and they
 * must be applied identically everywhere the report is shown:
 *
 * 1. **Exploitability labelling.** Every static finding is a *signal*, not a demonstrated exploit.
 *    {@link exploitabilityLabel} turns the report's `exploitability` into explicit copy — never a
 *    bare severity chip that a reader could mistake for "this server is exploitable". Nothing reads
 *    as "proven" unless the report itself says a dynamic probe proved it, which cannot happen until
 *    CLX-3.3 (#4857) exists.
 *
 * 2. **Skipped-rule visibility.** A rule with no evidence was *not* evaluated. {@link parsePostureReport}
 *    keeps `skippedRules` / `skipReasons` so the panel can show the coverage gaps instead of letting
 *    an unscanned lane read as clean.
 *
 * HIVE-7.8 (#5325) moved the two chip helpers onto `ui/statusVocabulary`. They were six pairs of
 * Tailwind palette classes, so a posture `error` was a different red from the lint tab's MUST and
 * from the discovery job that failed on the tab beside it; each now names the tone it *is* and
 * the shared table answers.
 */

import {
  STATUS_TONE_SOFT_CLASS,
  statusTone,
  type StatusTone,
} from '@/app/components/ui/statusVocabulary';

export type PostureExploitability = 'static_signal' | 'proven' | string;
export type PostureOrigin = 'metadata' | 'source' | 'dependency' | 'protocol' | string;
export type PostureSeverity = 'error' | 'warning' | 'info' | string;

export interface PostureFinding {
  id: string;
  path: string;
  rule: string;
  severity: PostureSeverity;
  message: string;
  origin: PostureOrigin;
  originLabel: string;
  owaspIds: string[];
  exploitability: PostureExploitability;
  exploitabilityLabel: string;
  confidence: string;
  excerpt: string | null;
  remediation: string | null;
}

export interface PostureGate {
  passed: boolean;
  failOn: string;
  minScore: number | null;
  requireFullCoverage: boolean;
  reasons: string[];
}

export interface PostureReport {
  endpointId: string;
  versionId: string;
  profile: string;
  owaspRevision: string;
  score: number;
  grade: string;
  findings: PostureFinding[];
  severityCounts: Record<string, number>;
  originCounts: Record<string, number>;
  owaspCounts: Record<string, number>;
  owaspCoverage: { covered: string[]; uncovered: string[]; [key: string]: unknown };
  evaluatedRules: string[];
  skippedRules: string[];
  skipReasons: Record<string, string>;
  provenCount: number;
  gate: PostureGate;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asCountMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'number') out[key] = val;
  }
  return out;
}

/** Pick a value under either its camelCase or snake_case key (the proxy passes REST aliases through). */
function pick(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function parseFinding(value: unknown): PostureFinding | null {
  const r = asRecord(value);
  if (!r) return null;
  const id = asString(r.id);
  const rule = asString(r.rule);
  if (!id || !rule) return null;
  const exploitability = asString(r.exploitability, 'static_signal');
  return {
    id,
    path: asString(r.path),
    rule,
    severity: asString(r.severity, 'info'),
    message: asString(r.message),
    origin: asString(r.origin, 'metadata'),
    originLabel: asString(pick(r, 'originLabel', 'origin_label')),
    owaspIds: asStringArray(pick(r, 'owaspIds', 'owasp_ids')),
    exploitability,
    // Prefer the server's own label — it ships the honest wording with the data — but never let a
    // missing label collapse into silence: a finding with no exploitability text must still read as
    // a signal, not as nothing.
    exploitabilityLabel:
      asString(pick(r, 'exploitabilityLabel', 'exploitability_label')) ||
      exploitabilityLabel(exploitability),
    confidence: asString(r.confidence, 'high'),
    excerpt: typeof r.excerpt === 'string' ? r.excerpt : null,
    remediation: typeof r.remediation === 'string' ? r.remediation : null,
  };
}

/**
 * Human label for an exploitability state.
 *
 * The `static_signal` wording is deliberately explicit rather than neutral: a reader skimming a
 * list of red chips must not come away believing the server was *demonstrated* to be exploitable.
 * This is the client-side backstop for the report's AC5 guarantee — used only when the server did
 * not ship its own label.
 */
export function exploitabilityLabel(exploitability: PostureExploitability): string {
  switch (exploitability) {
    case 'proven':
      return 'Proven by dynamic probe';
    case 'static_signal':
    default:
      return 'Signal — not proven exploitable';
  }
}

/** CSS classes for a severity chip (token utilities only — no hard-coded colors). */
export function severityChipClass(severity: PostureSeverity): string {
  return STATUS_TONE_SOFT_CLASS[postureSeverityTone(severity)];
}

/**
 * The tone a posture finding's severity resolves to (HIVE-7.8, #5325).
 *
 * The three severities are already vocabulary strings — `error`, `warning`, `info` — so the
 * shared table answers all three, which is what makes a posture error the same red as a lint
 * MUST and a failed discovery job two tabs away. They were three pairs of palette classes
 * (`bg-rose-100 text-rose-800 dark:bg-rose-900/40 …`) until this ticket.
 *
 * @param severity The finding's severity.
 * @returns The status tone.
 */
export function postureSeverityTone(severity: PostureSeverity): StatusTone {
  return statusTone(severity);
}

/**
 * The tone a finding's evidence lane resolves to.
 *
 * Not a status — a *kind* — so it does not come from the vocabulary table; what it does take
 * from the vocabulary is the token layer, so the four lanes follow the reader's theme. Source
 * is violet for the reason `private` and `false_positive` are: it records where a claim came
 * from, not how bad it is. Protocol is accent, the tone the vocabulary spends on
 * "informational, observed"; a dependency is `ok`'s green because it is the one lane that
 * reads a real manifest; and metadata — what the server said about itself — is neutral.
 *
 * @param origin The evidence lane.
 * @returns The status tone.
 */
export function postureOriginTone(origin: PostureOrigin): StatusTone {
  switch (origin) {
    case 'source':
      return 'violet';
    case 'dependency':
      return 'ok';
    case 'protocol':
      return 'accent';
    case 'metadata':
    default:
      return 'neutral';
  }
}

/** CSS classes for an origin chip, so a reader can tell a claim from code at a glance. */
export function originChipClass(origin: PostureOrigin): string {
  return STATUS_TONE_SOFT_CLASS[postureOriginTone(origin)];
}

/** Normalize the REST / proxy trust-posture payload into a typed report. */
export function parsePostureReport(payload: unknown): PostureReport | null {
  const r = asRecord(payload);
  if (!r) return null;
  if (r.success === false) return null;

  const findings = Array.isArray(r.findings)
    ? r.findings.map(parseFinding).filter((f): f is PostureFinding => f != null)
    : [];

  const gateRaw = asRecord(r.gate) ?? {};
  const gate: PostureGate = {
    passed: Boolean(gateRaw.passed),
    failOn: asString(pick(gateRaw, 'failOn', 'fail_on'), 'error'),
    minScore: typeof pick(gateRaw, 'minScore', 'min_score') === 'number'
      ? (pick(gateRaw, 'minScore', 'min_score') as number)
      : null,
    requireFullCoverage: Boolean(pick(gateRaw, 'requireFullCoverage', 'require_full_coverage')),
    reasons: asStringArray(gateRaw.reasons),
  };

  const coverageRaw = asRecord(pick(r, 'owaspCoverage', 'owasp_coverage')) ?? {};

  return {
    endpointId: asString(pick(r, 'endpointId', 'endpoint_id')),
    versionId: asString(pick(r, 'versionId', 'version_id')),
    profile: asString(r.profile),
    owaspRevision: asString(pick(r, 'owaspRevision', 'owasp_revision')),
    score: asNumber(r.score),
    grade: asString(r.grade),
    findings,
    severityCounts: asCountMap(pick(r, 'severityCounts', 'severity_counts')),
    originCounts: asCountMap(pick(r, 'originCounts', 'origin_counts')),
    owaspCounts: asCountMap(pick(r, 'owaspCounts', 'owasp_counts')),
    owaspCoverage: {
      covered: asStringArray(coverageRaw.covered),
      uncovered: asStringArray(coverageRaw.uncovered),
    },
    evaluatedRules: asStringArray(pick(r, 'evaluatedRules', 'evaluated_rules')),
    skippedRules: asStringArray(pick(r, 'skippedRules', 'skipped_rules')),
    skipReasons: (() => {
      const record = asRecord(pick(r, 'skipReasons', 'skip_reasons'));
      if (!record) return {};
      const out: Record<string, string> = {};
      for (const [key, val] of Object.entries(record)) {
        if (typeof val === 'string') out[key] = val;
      }
      return out;
    })(),
    provenCount: asNumber(pick(r, 'provenCount', 'proven_count')),
    gate,
  };
}

/** Group a report's findings by OWASP risk id, so the panel can render one section per risk. */
export function groupFindingsByOwasp(
  findings: PostureFinding[],
): Array<{ riskId: string; findings: PostureFinding[] }> {
  const byRisk = new Map<string, PostureFinding[]>();
  for (const finding of findings) {
    // A finding may instance several risks; it appears under each. "unmapped" catches the
    // (shouldn't-happen) case of a finding with no risk, so nothing is silently dropped.
    const ids = finding.owaspIds.length ? finding.owaspIds : ['unmapped'];
    for (const riskId of ids) {
      const bucket = byRisk.get(riskId) ?? [];
      bucket.push(finding);
      byRisk.set(riskId, bucket);
    }
  }
  return [...byRisk.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([riskId, group]) => ({ riskId, findings: group }));
}

/**
 * True when the report contains any finding a dynamic probe actually proved exploitable.
 *
 * Today this is always false — no probe exists (CLX-3.3, #4857). The panel uses it so that when a
 * probe does exist, the "everything here is a signal" banner disappears on its own rather than
 * needing to be remembered and removed.
 */
export function hasProvenFindings(report: PostureReport): boolean {
  return report.provenCount > 0;
}

export async function fetchPostureReport(
  endpointId: string,
  versionId: string,
  options?: { profile?: string; signal?: AbortSignal },
): Promise<PostureReport> {
  const query = options?.profile ? `?profile=${encodeURIComponent(options.profile)}` : '';
  const response = await fetch(
    `/api/mcp/endpoints/${encodeURIComponent(endpointId)}/versions/${encodeURIComponent(versionId)}/trust-posture${query}`,
    { method: 'GET', signal: options?.signal },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.success === false) {
    const message =
      (data && (data.error || data.detail)) ||
      `Failed to load trust posture (HTTP ${response.status})`;
    throw new Error(typeof message === 'string' ? message : 'Failed to load trust posture');
  }
  const report = parsePostureReport(data);
  if (!report) throw new Error('Malformed trust-posture report');
  return report;
}
