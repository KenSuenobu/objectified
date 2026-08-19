/**
 * MCP lint & score panel — shared types & pure presentation helpers (V2-MCP-24.4 / MCAT-10.4).
 *
 * The "Lint & Score" tab and the Overview grade summary both render an endpoint version's lint
 * report, served by apiome-rest through the Next.js proxy route
 * `/api/mcp/endpoints/{id}/versions/{versionId}/lint`. This module holds the wire types and the
 * *pure* adapter/derive helpers that turn that payload into what the panel renders — kept free of
 * React so they can be unit-tested directly.
 *
 * The lint surface mirrors the OpenAPI lint surface: a deterministic 0-100 score, an A-F grade,
 * per-rule / per-severity tallies, and itemized findings. Findings split into MUST (an `error`
 * severity — a hard requirement) and SHOULD (a `warning` — a recommendation), with `info`
 * findings surfaced as advisories. Each finding carries a `path` (e.g. `tools.search`) that this
 * module resolves back to the offending capability item so the UI can deep-link to it.
 *
 * HIVE-7.8 (#5325) moved the tier's *paint* onto `ui/statusVocabulary`, the same move HIVE-2.4
 * made for the grade bands and HIVE-7.7 for `McpBadge`'s tones. A MUST finding was
 * `border-l-4 border-red-500 bg-red-50 dark:bg-red-900/20`, which froze it on one light palette
 * and one dark one; it names the vocabulary string it *is* (`failed`) now, and the table answers
 * with the tone every other failure on the screen wears. The tinted row went with it — see
 * {@link McpLintTierMeta.rowClass}.
 */

import type { McpBadgeVariant } from './mcpBrowseUi';
import {
  STATUS_TONE_BORDER_CLASS,
  STATUS_TONE_DOT_CLASS,
  statusTone,
  type StatusTone,
} from '../../../ui/statusVocabulary';

/** Lint finding severities as emitted by the scorer. */
export type McpLintSeverity = 'error' | 'warning' | 'info';

/** One itemized lint finding (the wire shape of `LintFindingOut`). */
export interface McpLintFinding {
  id: string;
  /** Surface location, e.g. `tools.search` or `surface` (see {@link mcpLintFindingTarget}). */
  path: string;
  /** Rule group, e.g. `naming` / `structure` / `annotation` / `security` / `hygiene`. */
  category: string;
  /** Dotted rule id, e.g. `structure.duplicate-item-name`. */
  rule: string;
  severity: string;
  message: string;
}

/** A version snapshot's full lint report (the wire shape of `McpLintReportResponse`). */
export interface McpLintReport {
  endpoint_id: string;
  version_id: string;
  version_seq: number;
  version_tag: string | null;
  /** Deterministic 0-100 quality score. */
  score: number;
  /** A-F letter grade derived from the score by the server. */
  grade: string;
  findings: McpLintFinding[];
  /** Count of findings per rule id. */
  rule_hits: Record<string, number>;
  /** Count of findings per severity (`error` / `warning` / `info`). */
  severity_counts: Record<string, number>;
  report_fingerprint: string;
  /** `stored` when served from persistence, `computed` when scored live for the request. */
  source: string;
  scored_at: string | null;
  /** Multi-axis scoring algorithm id (CLX-1.2). */
  algorithm_id?: string | null;
  /** Per-axis scores and coverage (CLX-1.2); raw wire axes for {@link lintAxisEvaluationFromLintReport}. */
  axes?: unknown[] | null;
  composite_score?: number | null;
  composite_grade?: string | null;
  required_coverage_met?: boolean | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Coerce an arbitrary value to a `Record<string, number>`, dropping non-numeric entries. */
function asCountMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = Math.trunc(raw);
  }
  return out;
}

/** Parse one lint finding defensively (missing/invalid fields fall back to safe defaults). */
export function mcpLintFindingFromPayload(raw: unknown): McpLintFinding {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    path: String(r.path ?? ''),
    category: String(r.category ?? ''),
    rule: String(r.rule ?? ''),
    severity: String(r.severity ?? 'info'),
    message: String(r.message ?? ''),
  };
}

/**
 * Parse a lint-report payload into a {@link McpLintReport}, or NULL when it is malformed. Accepts
 * both the REST camelCase aliases (`versionId`, `ruleHits`, …) and their snake_case originals so
 * the helper is robust to either serialization.
 */
export function mcpLintReportFromPayload(data: unknown): McpLintReport | null {
  const r = (data ?? {}) as Record<string, unknown>;
  const versionId = asString(r.versionId) ?? asString(r.version_id);
  if (!versionId) return null;
  const findings = (Array.isArray(r.findings) ? r.findings : []).map(mcpLintFindingFromPayload);
  return {
    endpoint_id: asString(r.endpointId) ?? asString(r.endpoint_id) ?? '',
    version_id: versionId,
    version_seq: asInt(r.versionSeq ?? r.version_seq),
    version_tag: asString(r.versionTag) ?? asString(r.version_tag),
    score: asInt(r.score),
    grade: asString(r.grade) ?? 'F',
    findings,
    rule_hits: asCountMap(r.ruleHits ?? r.rule_hits),
    severity_counts: asCountMap(r.severityCounts ?? r.severity_counts),
    report_fingerprint: asString(r.reportFingerprint) ?? asString(r.report_fingerprint) ?? '',
    source: asString(r.source) ?? 'computed',
    scored_at: asString(r.scoredAt) ?? asString(r.scored_at),
    algorithm_id: asString(r.algorithmId) ?? asString(r.algorithm_id),
    axes: Array.isArray(r.axes) ? r.axes : null,
    composite_score:
      typeof (r.compositeScore ?? r.composite_score) === 'number'
        ? asInt(r.compositeScore ?? r.composite_score)
        : null,
    composite_grade: asString(r.compositeGrade) ?? asString(r.composite_grade),
    required_coverage_met:
      r.requiredCoverageMet === true || r.required_coverage_met === true,
  };
}

// --- Severity / requirement tiers -----------------------------------------------------------
// MUST vs SHOULD is the headline split the mockup calls for: an `error` is a hard requirement
// (MUST), a `warning` a recommendation (SHOULD), and `info` an advisory. Each tier carries its
// own label, badge variant, and color-coded row styling so the panel renders consistently.

/** The three requirement tiers a finding can fall into, strongest first. */
export type McpLintTier = 'must' | 'should' | 'advisory';

/** Map a finding severity to its requirement tier. */
export const MCP_LINT_SEVERITY_TIER: Record<string, McpLintTier> = {
  error: 'must',
  warning: 'should',
  info: 'advisory',
};

/** Resolve a finding's requirement tier from its severity (defaults to `advisory`). */
export function mcpLintFindingTier(finding: McpLintFinding): McpLintTier {
  return MCP_LINT_SEVERITY_TIER[finding.severity] ?? 'advisory';
}

/** Display metadata + color-coded styling for one requirement tier. */
export interface McpLintTierMeta {
  key: McpLintTier;
  /** Headline label (`MUST` / `SHOULD` / `Advisory`). */
  label: string;
  severity: McpLintSeverity;
  badgeVariant: McpBadgeVariant;
  /**
   * The tone this tier *is*, in the shared status vocabulary.
   *
   * Added by HIVE-7.8 (#5325), and the reason the three class fields below no longer name a
   * palette: a MUST finding and a failed job are the same danger, because the same table
   * answered both.
   */
  tone: StatusTone;
  /**
   * The leading edge a finding row is marked with.
   *
   * A *rule*, not a fill. It was `border-l-4 border-red-500 bg-red-50 dark:bg-red-900/20` — a
   * tinted row — and a list of eight of those is a wall of colour in which nothing stands out;
   * the tier's badge is where a reader looks, and it carries the tone already.
   */
  rowClass: string;
  /** The tone as a solid bar fill, for a count bar or a meter. */
  barClass: string;
  description: string;
}

/** Build one tier's metadata, taking every colour from the shared vocabulary. */
function lintTierMeta(
  key: McpLintTier,
  label: string,
  severity: McpLintSeverity,
  badgeVariant: McpBadgeVariant,
  vocabulary: string,
  description: string,
): McpLintTierMeta {
  const tone = statusTone(vocabulary);
  return {
    key,
    label,
    severity,
    badgeVariant,
    tone,
    rowClass: `border-l-2 ${STATUS_TONE_BORDER_CLASS[tone]}`,
    barClass: STATUS_TONE_DOT_CLASS[tone],
    description,
  };
}

const MCP_LINT_TIER_META: Record<McpLintTier, McpLintTierMeta> = {
  must: lintTierMeta(
    'must',
    'MUST',
    'error',
    'error',
    'failed',
    'Hard requirements — fix these to raise the grade.',
  ),
  should: lintTierMeta(
    'should',
    'SHOULD',
    'warning',
    'warning',
    'degraded',
    'Recommendations — address these to polish the surface.',
  ),
  advisory: lintTierMeta(
    'advisory',
    'Advisory',
    'info',
    'secondary',
    'unknown',
    'Informational notes about the surface.',
  ),
};

/** The requirement tiers in display order (strongest first). */
export const MCP_LINT_TIER_ORDER: readonly McpLintTier[] = ['must', 'should', 'advisory'] as const;

/** Resolve the display metadata for a requirement tier. */
export function mcpLintTierMeta(tier: McpLintTier): McpLintTierMeta {
  return MCP_LINT_TIER_META[tier];
}

/** Per-tier finding tallies (MUST / SHOULD / advisory). */
export interface McpLintTierCounts {
  must: number;
  should: number;
  advisory: number;
}

/**
 * Count findings per requirement tier, derived from the findings themselves so the totals always
 * agree with the rows the panel renders.
 */
export function mcpLintTierCounts(findings: McpLintFinding[]): McpLintTierCounts {
  const counts: McpLintTierCounts = { must: 0, should: 0, advisory: 0 };
  for (const finding of findings) counts[mcpLintFindingTier(finding)] += 1;
  return counts;
}

/** A requirement tier with its findings, for sectioned rendering. */
export interface McpLintTierGroup {
  meta: McpLintTierMeta;
  findings: McpLintFinding[];
}

/**
 * Group findings by requirement tier in display order (MUST → SHOULD → advisory). Every tier is
 * returned (even when empty) so the panel can render a stable section order; findings within a
 * tier keep the server's deterministic order.
 */
export function mcpLintGroupByTier(findings: McpLintFinding[]): McpLintTierGroup[] {
  return MCP_LINT_TIER_ORDER.map((tier) => ({
    meta: MCP_LINT_TIER_META[tier],
    findings: findings.filter((finding) => mcpLintFindingTier(finding) === tier),
  }));
}

// --- Category bars --------------------------------------------------------------------------
// The mockup shows a small bar per rule category (naming, structure, …). We present per-category
// finding counts, the bar length scaled to the busiest category, and the bar tinted by the worst
// severity present in that category, so a category with a MUST failure reads red.

/** Human labels for the known rule categories; unknown categories fall back to a title-cased id. */
const MCP_LINT_CATEGORY_LABELS: Record<string, string> = {
  naming: 'Naming',
  structure: 'Structure',
  annotation: 'Annotations',
  security: 'Security',
  hygiene: 'Hygiene',
};

/** Humanize a rule category id for display (known labels, else title-cased). */
export function mcpLintCategoryLabel(category: string): string {
  if (!category) return 'Other';
  return (
    MCP_LINT_CATEGORY_LABELS[category] ??
    category
      .split(/[-_]/)
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(' ')
  );
}

/** Rank severities so the worst one in a category drives its bar color. */
const MCP_SEVERITY_RANK: Record<string, number> = { error: 3, warning: 2, info: 1 };

/** One category's bar: its finding count, worst severity, and bar width (0-100). */
export interface McpLintCategoryBar {
  category: string;
  label: string;
  count: number;
  /** The most severe finding severity present in the category. */
  severity: McpLintSeverity;
  /** Tailwind background class for the bar, keyed off {@link severity}. */
  barClass: string;
  /** Bar width 0-100, scaled to the busiest category so the widest bar is full. */
  percent: number;
}

/** Tailwind background class for a bar, keyed off a finding severity. */
export function mcpLintSeverityBarClass(severity: string): string {
  return MCP_LINT_TIER_META[MCP_LINT_SEVERITY_TIER[severity] ?? 'advisory'].barClass;
}

/**
 * Build the per-category count bars for a report's findings, ordered by count descending (then
 * category name) so the busiest category leads. Each bar's width is scaled to the busiest
 * category and tinted by the worst severity present in that category. Returns an empty list when
 * there are no findings.
 */
export function mcpLintCategoryBars(findings: McpLintFinding[]): McpLintCategoryBar[] {
  const byCategory = new Map<string, { count: number; worst: string }>();
  for (const finding of findings) {
    const key = finding.category || 'other';
    const entry = byCategory.get(key) ?? { count: 0, worst: 'info' };
    entry.count += 1;
    if ((MCP_SEVERITY_RANK[finding.severity] ?? 0) > (MCP_SEVERITY_RANK[entry.worst] ?? 0)) {
      entry.worst = finding.severity;
    }
    byCategory.set(key, entry);
  }
  const max = Math.max(0, ...Array.from(byCategory.values(), (e) => e.count));
  return Array.from(byCategory.entries())
    .map(([category, { count, worst }]) => ({
      category,
      label: mcpLintCategoryLabel(category),
      count,
      severity: (MCP_LINT_SEVERITY_TIER[worst] ? worst : 'info') as McpLintSeverity,
      barClass: mcpLintSeverityBarClass(worst),
      percent: max > 0 ? Math.round((count / max) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

// --- Score breakdown (point-cost reconstruction) --------------------------------------------
// The Lint & Score tab shows a single grade; the Insight tab's score-breakdown panel (MCAT-17.3)
// reconstructs *how* that score was reached by replaying the scorer's model (apiome-rest
// `mcp_score.py`) in the browser: each finding costs its severity's penalty, the penalties are
// summed per rule and capped, and the capped per-rule penalties are grouped by rule category so an
// evaluator can see which rule groups cost the most points. Mirroring the server constants keeps the
// reconstruction faithful — for any current report the summed point cost equals `100 - score`.

/** Penalty each finding severity contributes to the score. Mirrors apiome-rest `SEVERITY_PENALTY`. */
export const MCP_LINT_SEVERITY_PENALTY: Record<string, number> = {
  error: 10,
  warning: 4,
  info: 1,
};

/** Max total penalty a single rule may contribute. Mirrors apiome-rest `PER_RULE_PENALTY_CAP`. */
export const MCP_LINT_PER_RULE_PENALTY_CAP = 20;

/** One rule group's contribution to the score deduction. */
export interface McpLintScoreCategory {
  category: string;
  label: string;
  /** Points this group deducted from the score (per-rule penalties, each capped, then summed). */
  points: number;
  /** The uncapped penalty before the per-rule cap is applied; always `>= points`. */
  rawPoints: number;
  /** True when at least one rule in this group hit the per-rule penalty cap. */
  capped: boolean;
  /** How many findings fall in this group. */
  findingCount: number;
  /** The most severe finding severity present in the group. */
  severity: McpLintSeverity;
  /** Tailwind background class for the bar, keyed off {@link severity}. */
  barClass: string;
  /** Bar width 0-100, scaled to the costliest group so the widest bar is full. */
  percent: number;
}

/** The full score-cost decomposition for a report's findings. */
export interface McpLintScoreBreakdown {
  /** Rule groups that cost points, ordered by cost descending (then category name). */
  categories: McpLintScoreCategory[];
  /** Total points deducted across all groups (equals `100 - reconstructedScore`). */
  totalPenalty: number;
  /** The 0-100 score reconstructed from the findings (`100 - totalPenalty`, clamped). */
  reconstructedScore: number;
}

/**
 * Reconstruct the per-category score deduction for a report's findings by replaying the scorer's
 * model: sum each severity's penalty per rule, cap each rule's contribution at
 * {@link MCP_LINT_PER_RULE_PENALTY_CAP}, then group the capped per-rule penalties by rule category.
 * Because every finding of a rule shares that rule's category, summing the capped per-rule penalties
 * by category reproduces the scorer's total deduction exactly, so `totalPenalty === 100 - score` for
 * a current report. A category's `rawPoints` exposes the pre-cap penalty so the panel can flag when a
 * chatty rule group's cost was capped. Returns an empty breakdown (no categories, zero penalty,
 * score 100) when the findings cost nothing.
 *
 * @param findings The report's findings (any order; the result is order-independent).
 * @returns The ordered per-group point costs, the total deduction, and the reconstructed score.
 */
export function mcpLintScoreBreakdown(findings: McpLintFinding[]): McpLintScoreBreakdown {
  // Fold findings into per-rule accumulators — the scorer caps each *rule's* penalty, not each
  // category's, so the cap has to be applied at rule granularity before rolling up by category.
  const byRule = new Map<string, { category: string; raw: number; worst: string; count: number }>();
  for (const finding of findings) {
    const ruleKey = finding.rule || finding.category || 'other';
    const entry =
      byRule.get(ruleKey) ?? { category: finding.category || 'other', raw: 0, worst: 'info', count: 0 };
    entry.raw += MCP_LINT_SEVERITY_PENALTY[finding.severity] ?? 0;
    entry.count += 1;
    if ((MCP_SEVERITY_RANK[finding.severity] ?? 0) > (MCP_SEVERITY_RANK[entry.worst] ?? 0)) {
      entry.worst = finding.severity;
    }
    byRule.set(ruleKey, entry);
  }

  // Roll the capped per-rule penalties up by category.
  const byCategory = new Map<
    string,
    { points: number; raw: number; worst: string; count: number; capped: boolean }
  >();
  for (const rule of byRule.values()) {
    const capped = Math.min(rule.raw, MCP_LINT_PER_RULE_PENALTY_CAP);
    const key = rule.category || 'other';
    const entry =
      byCategory.get(key) ?? { points: 0, raw: 0, worst: 'info', count: 0, capped: false };
    entry.points += capped;
    entry.raw += rule.raw;
    entry.count += rule.count;
    entry.capped = entry.capped || rule.raw > MCP_LINT_PER_RULE_PENALTY_CAP;
    if ((MCP_SEVERITY_RANK[rule.worst] ?? 0) > (MCP_SEVERITY_RANK[entry.worst] ?? 0)) {
      entry.worst = rule.worst;
    }
    byCategory.set(key, entry);
  }

  const maxPoints = Math.max(0, ...Array.from(byCategory.values(), (e) => e.points));
  const categories: McpLintScoreCategory[] = Array.from(byCategory.entries())
    .map(([category, e]) => ({
      category,
      label: mcpLintCategoryLabel(category),
      points: e.points,
      rawPoints: e.raw,
      capped: e.capped,
      findingCount: e.count,
      severity: (MCP_LINT_SEVERITY_TIER[e.worst] ? e.worst : 'info') as McpLintSeverity,
      barClass: mcpLintSeverityBarClass(e.worst),
      percent: maxPoints > 0 ? Math.round((e.points / maxPoints) * 100) : 0,
    }))
    .sort((a, b) => b.points - a.points || a.category.localeCompare(b.category));

  const totalPenalty = categories.reduce((sum, c) => sum + c.points, 0);
  const reconstructedScore = Math.max(0, Math.min(100, Math.round(100 - totalPenalty)));

  return { categories, totalPenalty, reconstructedScore };
}

// --- Offending-item resolution & deep-linking -----------------------------------------------
// A finding's `path` is `<collection>.<name>` (e.g. `tools.search`); surface-level findings use
// the bare path `surface`. We resolve the collection segment back to a capability item_type so a
// finding can deep-link to the matching card on the Capabilities tab, addressed by a shared
// anchor id both producers compute the same way.

/** Maps a finding-path collection segment to its capability `item_type`. */
export const MCP_LINT_COLLECTION_ITEM_TYPE: Record<string, string> = {
  tools: 'tool',
  resources: 'resource',
  resourceTemplates: 'resource_template',
  prompts: 'prompt',
};

/** The offending capability item a finding refers to (item kind + programmatic name). */
export interface McpLintTarget {
  item_type: string;
  name: string;
}

/**
 * Resolve a finding's `path` to the capability item it refers to, or NULL when the finding is not
 * item-scoped (e.g. the surface-level `surface` path) or its collection is unrecognized. The path
 * is split on its first `.` only, so item names that themselves contain dots survive intact.
 */
export function mcpLintFindingTarget(path: string): McpLintTarget | null {
  const dot = path.indexOf('.');
  if (dot <= 0) return null;
  const collection = path.slice(0, dot);
  const name = path.slice(dot + 1);
  const itemType = MCP_LINT_COLLECTION_ITEM_TYPE[collection];
  if (!itemType || !name) return null;
  return { item_type: itemType, name };
}

/**
 * The shared DOM anchor id for a capability item, computed identically by the Capabilities tab
 * (which renders the anchor) and the Lint tab (which links to it). Non-id-safe characters in the
 * name are collapsed to hyphens so the id is always a valid, stable token.
 */
export function mcpCapabilityAnchorId(itemType: string, name: string): string {
  const safeName = (name || 'unnamed').replace(/[^A-Za-z0-9_-]+/g, '-');
  return `mcp-cap-${itemType}-${safeName}`;
}
