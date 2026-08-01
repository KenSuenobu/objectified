/**
 * Repository health badge — types, parsing and presentation (REPO-6.5, #2798).
 *
 * The REST surface rolls a repository's scan success rate over the last 30 days, its
 * discovered-spec parse errors and its linked-account token health (REPO-7.4) into one
 * three-valued badge, returned as `health` on every repository record. This module owns
 * the client-side contract for it: how the payload is parsed, what each level is called,
 * which CSS classes it wears, and the copy the badge tooltip renders.
 *
 * Nothing here is a second opinion on the API's verdict — the level is rendered exactly as
 * the server computed it. What lives here is presentation, plus the defensive parsing that
 * lets an older API payload (no `health` key at all) render nothing rather than crash.
 */

/** The three badge levels, in increasing severity. Mirrors the REST `HealthLevel`. */
export type RepositoryHealthLevel = 'healthy' | 'warnings' | 'error';

/** One reason contributing to the level. `code` is a stable REST machine code. */
export interface RepositoryHealthFactor {
  code: string;
  level: RepositoryHealthLevel;
  /** One-sentence, operator-facing explanation. Rendered verbatim. */
  summary: string;
  /** ISO timestamp of when the factor was last observed; null for a standing condition. */
  observed_at: string | null;
}

/** The computed badge for one repository, as returned on the repository record. */
export interface RepositoryHealth {
  level: RepositoryHealthLevel;
  /** 0-100 weighted roll-up; informational — the level is what the badge renders. */
  score: number;
  /** Trailing window the scan success rate was measured over, in days. */
  window_days: number;
  /** Finished (succeeded or failed) scan jobs in the window. */
  scans_attempted: number;
  /** Of those, how many succeeded. */
  scans_succeeded: number;
  /** `scans_succeeded / scans_attempted`; null when no scan finished in the window. */
  scan_success_rate: number | null;
  /** Discovered specs on the default branch that could not be parsed or scored. */
  parse_error_count: number;
  /** The most recently observed factor — what the tooltip leads with; null when healthy. */
  primary_factor: RepositoryHealthFactor | null;
  /** Every contributing factor, most severe first. Empty when healthy. */
  factors: RepositoryHealthFactor[];
}

/** Severity ranking, used to sort or compare levels. Higher is worse. */
export function repositoryHealthRank(level: RepositoryHealthLevel): number {
  if (level === 'error') return 2;
  if (level === 'warnings') return 1;
  return 0;
}

function normalizeLevel(value: unknown): RepositoryHealthLevel {
  const v = String(value ?? '').toLowerCase();
  if (v === 'error') return 'error';
  if (v === 'warnings' || v === 'warning') return 'warnings';
  return 'healthy';
}

function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseFactor(x: unknown): RepositoryHealthFactor | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const summary = String(o.summary ?? '').trim();
  if (!summary) return null;
  const observed = o.observed_at;
  return {
    code: String(o.code ?? '').trim() || 'unknown',
    level: normalizeLevel(o.level),
    summary,
    observed_at: observed == null || String(observed).trim() === '' ? null : String(observed),
  };
}

/**
 * Parse a `health` object from a repository payload.
 *
 * @param x The raw `health` value from the API (may be absent, null, or malformed).
 * @returns The parsed health, or null when the payload carries none — a repository whose
 *   health could not be computed renders no badge rather than a guessed one.
 */
export function parseRepositoryHealth(x: unknown): RepositoryHealth | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.level == null) return null;
  const rawFactors = Array.isArray(o.factors) ? o.factors : [];
  const factors = rawFactors
    .map(parseFactor)
    .filter((f): f is RepositoryHealthFactor => f != null);
  const rate = o.scan_success_rate;
  return {
    level: normalizeLevel(o.level),
    score: Math.max(0, Math.min(100, toInt(o.score, 0))),
    window_days: Math.max(1, toInt(o.window_days, 30)),
    scans_attempted: Math.max(0, toInt(o.scans_attempted, 0)),
    scans_succeeded: Math.max(0, toInt(o.scans_succeeded, 0)),
    scan_success_rate: typeof rate === 'number' && Number.isFinite(rate) ? rate : null,
    parse_error_count: Math.max(0, toInt(o.parse_error_count, 0)),
    primary_factor: parseFactor(o.primary_factor) ?? factors[0] ?? null,
    factors,
  };
}

/** Short badge text for a level. */
export function repositoryHealthLabel(level: RepositoryHealthLevel): string {
  if (level === 'error') return 'Error';
  if (level === 'warnings') return 'Warnings';
  return 'Healthy';
}

/**
 * Badge colour classes for a level.
 *
 * Deliberately the same palette the repository status pill uses (`repositoryStatusClass`),
 * so "green means fine, amber means look, rose means broken" reads identically across the
 * two pills sitting next to each other on a row.
 */
export function repositoryHealthClass(level: RepositoryHealthLevel): string {
  switch (level) {
    case 'error':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300';
    case 'warnings':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
    default:
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  }
}

/** Human sentence for the scan-rate line in the tooltip. */
function scanRateLine(health: RepositoryHealth): string {
  if (health.scans_attempted === 0) {
    return `No scans finished in the last ${health.window_days} days.`;
  }
  const pct = Math.round(((health.scan_success_rate ?? 0) * 100));
  const noun = health.scans_attempted === 1 ? 'scan' : 'scans';
  return `${health.scans_succeeded} of ${health.scans_attempted} ${noun} succeeded in the last ${health.window_days} days (${pct}%).`;
}

/**
 * Tooltip lines for the badge.
 *
 * The first line is the most recent contributing factor — what an operator wants to know is
 * "what changed" — followed by any other contributing factors, and finally the scan-rate
 * line that puts the verdict in context.
 *
 * @param health The parsed health.
 * @returns One or more lines; never empty.
 */
export function repositoryHealthTooltipLines(health: RepositoryHealth): string[] {
  if (health.level === 'healthy' || health.factors.length === 0) {
    return [
      'No scan failures, spec parse errors or credential problems.',
      scanRateLine(health),
    ];
  }
  const primary = health.primary_factor;
  const lines: string[] = [];
  if (primary) lines.push(primary.summary);
  for (const factor of health.factors) {
    if (primary && factor.code === primary.code) continue;
    lines.push(factor.summary);
  }
  lines.push(scanRateLine(health));
  return lines;
}

/**
 * Single-sentence screen-reader label for the badge.
 *
 * @param health The parsed health.
 * @returns A label naming the level and the reason behind it.
 */
export function repositoryHealthAriaLabel(health: RepositoryHealth): string {
  const level = repositoryHealthLabel(health.level).toLowerCase();
  const reason = health.primary_factor?.summary;
  return reason ? `Repository health: ${level}. ${reason}` : `Repository health: ${level}.`;
}
