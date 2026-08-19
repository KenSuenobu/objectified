/**
 * MCP version history & compare/diff view — shared types & pure presentation helpers
 * (V2-MCP-24.3 / MCAT-10.3).
 *
 * The version-history panel renders an endpoint's version timeline (newest-first) and an
 * on-demand diff between any two versions, both served by apiome-rest through the Next.js
 * proxy routes under `/api/mcp/endpoints/{id}/versions(/compare)`. This module holds the wire
 * types and the *pure* adapter/format helpers that turn those payloads into what the panel
 * renders — kept free of React so they can be unit-tested directly. JSON pretty-printing is
 * shared with the capability view via {@link mcpFormatJson}.
 *
 * HIVE-7.8 (#5325) moved the change kinds' *paint* onto `ui/statusVocabulary`. Added / removed /
 * modified were three pairs of Tailwind palette classes, so the same "breaking" red here was a
 * different red from the digest panel's two tabs away; each kind names the vocabulary string it
 * is now (`ok` / `breaking` / `info`) and the table answers with the tone.
 */

import {
  mcpFormatJson,
  mcpServerBrandingFromPayload,
  type McpBadgeVariant,
  type McpServerBranding,
} from './mcpBrowseUi';
import {
  STATUS_TONE_BORDER_CLASS,
  STATUS_TONE_SOFT_CLASS,
  statusTone,
  type StatusTone,
} from '../../../ui/statusVocabulary';

export type { McpServerBranding } from './mcpBrowseUi';

/** Per-direction tally of surface changes (a version's diff, or a compare result). */
export interface McpVersionChangeCounts {
  added: number;
  removed: number;
  modified: number;
  /** Always `added + removed + modified`. */
  total: number;
}

/** One row of an endpoint's version history (the timeline / "what changed when" view). */
export interface McpVersionSummary {
  id: string;
  endpoint_id: string;
  version_seq: number;
  version_tag: string | null;
  protocol_version: string | null;
  server_name: string | null;
  server_title: string | null;
  server_version: string | null;
  surface_fingerprint: string | null;
  /** The server's advertised branding for this snapshot, or `null` when none was advertised. */
  server_branding: McpServerBranding | null;
  score: number | null;
  grade: string | null;
  scored_at: string | null;
  /** Per-direction tally of changes this snapshot introduced relative to the prior version. */
  change_counts: McpVersionChangeCounts;
  /** True when the endpoint's `current_version_id` points at this snapshot. */
  is_current: boolean;
  /**
   * Which discovery run produced this snapshot (`manual` / `sweep` / `registry`, V2-MCP-34.5),
   * or `null` when unrecorded (a pre-provenance snapshot) — never any concrete origin.
   */
  discovery_trigger: string | null;
  /** The producing discovery job's id (an audit pointer), or `null` when unrecorded. */
  discovery_job_id: string | null;
  discovered_at: string | null;
  created_at: string | null;
}

/** Lightweight reference to one side of a compare (identity, no full surface). */
export interface McpVersionRef {
  id: string;
  version_seq: number;
  version_tag: string | null;
  surface_fingerprint: string | null;
}

/** The three diff directions, mirroring the REST `change_type` values. */
export type McpChangeType = 'added' | 'removed' | 'modified';

/** One field that differs between a modified item's before and after states. */
export interface McpFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** The before/after payload of a single change (a removal has `before`, an addition `after`). */
export interface McpVersionChangeDetail {
  before?: unknown;
  after?: unknown;
  /** Per-field breakdown for a `modified` capability item. */
  fields?: McpFieldChange[];
}

/** One add / remove / modify entry in a compare result. */
export interface McpVersionChange {
  change_type: string;
  item_type: string;
  item_name: string;
  detail: McpVersionChangeDetail;
}

/** On-demand structured diff between any two versions, normalized older→newer by the API. */
export interface McpVersionCompare {
  base: McpVersionRef;
  target: McpVersionRef;
  /** False exactly when the two surfaces are semantically identical (equal fingerprints). */
  fingerprint_changed: boolean;
  counts: McpVersionChangeCounts;
  changes: McpVersionChange[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function asScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Parse a `{ added, removed, modified, total }` block defensively, deriving `total` from the
 * three parts when it is absent or inconsistent so the summary line can never disagree with the
 * rows it describes.
 */
export function mcpChangeCountsFromPayload(raw: unknown): McpVersionChangeCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const added = asInt(r.added);
  const removed = asInt(r.removed);
  const modified = asInt(r.modified);
  return { added, removed, modified, total: added + removed + modified };
}

/** Parse one version-history row defensively (missing/invalid fields fall back to safe defaults). */
export function mcpVersionSummaryFromPayload(raw: unknown): McpVersionSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    endpoint_id: String(r.endpoint_id ?? ''),
    version_seq: asInt(r.version_seq),
    version_tag: asString(r.version_tag),
    protocol_version: asString(r.protocol_version),
    server_name: asString(r.server_name),
    server_title: asString(r.server_title),
    server_version: asString(r.server_version),
    surface_fingerprint: asString(r.surface_fingerprint),
    server_branding: mcpServerBrandingFromPayload(r.server_branding),
    score: asScore(r.score),
    grade: asString(r.grade),
    scored_at: asString(r.scored_at),
    change_counts: mcpChangeCountsFromPayload(r.change_counts),
    is_current: r.is_current === true,
    discovery_trigger: asString(r.discovery_trigger),
    discovery_job_id: asString(r.discovery_job_id),
    discovered_at: asString(r.discovered_at),
    created_at: asString(r.created_at),
  };
}

/**
 * Parse a `{ versions: [...] }` history payload into a newest-first list. The REST API already
 * orders newest-first, but we re-sort by `version_seq` descending defensively so the timeline is
 * stable regardless of payload order.
 */
export function mcpVersionListFromPayload(data: unknown): McpVersionSummary[] {
  const payload = (data ?? {}) as Record<string, unknown>;
  const versions = Array.isArray(payload.versions) ? payload.versions : [];
  return versions
    .map(mcpVersionSummaryFromPayload)
    .sort((a, b) => b.version_seq - a.version_seq);
}

/** Parse one compare-side reference defensively. */
export function mcpVersionRefFromPayload(raw: unknown): McpVersionRef {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    version_seq: asInt(r.version_seq),
    version_tag: asString(r.version_tag),
    surface_fingerprint: asString(r.surface_fingerprint),
  };
}

/** Parse one change entry's `detail` block, keeping only the recognized before/after/fields keys. */
function mcpChangeDetailFromPayload(raw: unknown): McpVersionChangeDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const detail: McpVersionChangeDetail = {};
  if ('before' in r) detail.before = r.before;
  if ('after' in r) detail.after = r.after;
  if (Array.isArray(r.fields)) {
    detail.fields = r.fields.map((f) => {
      const field = (f ?? {}) as Record<string, unknown>;
      return { field: String(field.field ?? ''), before: field.before, after: field.after };
    });
  }
  return detail;
}

/** Parse one add/remove/modify change entry defensively. */
export function mcpVersionChangeFromPayload(raw: unknown): McpVersionChange {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    change_type: String(r.change_type ?? ''),
    item_type: String(r.item_type ?? ''),
    item_name: String(r.item_name ?? ''),
    detail: mcpChangeDetailFromPayload(r.detail),
  };
}

/** Parse a compare payload into a {@link McpVersionCompare}, or NULL when it is malformed. */
export function mcpVersionCompareFromPayload(data: unknown): McpVersionCompare | null {
  const payload = (data ?? {}) as Record<string, unknown>;
  if (!payload.base || !payload.target) return null;
  const changes = (Array.isArray(payload.changes) ? payload.changes : []).map(
    mcpVersionChangeFromPayload,
  );
  return {
    base: mcpVersionRefFromPayload(payload.base),
    target: mcpVersionRefFromPayload(payload.target),
    fingerprint_changed: payload.fingerprint_changed === true,
    counts: mcpChangeCountsFromPayload(payload.counts),
    changes,
  };
}

/** The canonical short label for a version, e.g. `v3` from its sequence number. */
export function mcpVersionSeqLabel(versionSeq: number): string {
  return `v${versionSeq}`;
}

/**
 * The timeline's date/time tag for a version: the server-supplied `version_tag` when present,
 * else the formatted `discovered_at`/`created_at` timestamp, else the bare sequence label.
 */
export function mcpVersionDateTag(version: McpVersionSummary): string {
  if (version.version_tag) return version.version_tag;
  const iso = version.discovered_at ?? version.created_at;
  if (iso) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return new Date(ms).toLocaleString();
  }
  return mcpVersionSeqLabel(version.version_seq);
}

/** The compare panel header, e.g. `v2 → v5`, derived from the (already older→newer) refs. */
export function mcpCompareHeader(compare: McpVersionCompare): string {
  return `${mcpVersionSeqLabel(compare.base.version_seq)} → ${mcpVersionSeqLabel(
    compare.target.version_seq,
  )}`;
}

/** One styled token of the change-count summary line (e.g. `+3 added`). */
export interface McpChangeCountPart {
  key: 'added' | 'removed' | 'modified' | 'fingerprint';
  label: string;
  /**
   * The token's paint: its tone's `-soft` fill **and** the `-fg` ink calibrated to it.
   *
   * A pair, not an ink. Until HIVE-7.8 (#5325) this was the `-fg` ink alone, drawn on whatever
   * was behind it — and the browser sweep that ticket added measured `+3` at 1.58:1 in
   * Solarized, 1.64:1 in Blueprint and 2.38:1 in High contrast, because only `:root` and
   * `[data-theme="dark"]` recalibrate the semantic pairs. Render it with `.mcp-tone-figure`,
   * which supplies the chip's shape.
   */
  colorClass: string;
}

/**
 * The vocabulary string each change kind speaks.
 *
 * Additive is `ok`, a removal is `breaking` (which the table answers with danger, because a
 * client aligned to the older surface may break), and a modification is `info` — the tone the
 * vocabulary spends on "informational, worth a look". The mockup's add-green / remove-red /
 * modify-blue language is preserved exactly; what changed is that all three follow the reader's
 * theme instead of one light palette and one dark one.
 */
const CHANGE_VOCABULARY: Record<McpChangeType | 'unknown', string> = {
  added: 'ok',
  removed: 'breaking',
  modified: 'info',
  unknown: 'unknown',
};

/** The resolved tone per change kind, so the count parts and the rows cannot disagree. */
const CHANGE_TONE = {
  added: statusTone(CHANGE_VOCABULARY.added),
  removed: statusTone(CHANGE_VOCABULARY.removed),
  modified: statusTone(CHANGE_VOCABULARY.modified),
  unknown: statusTone(CHANGE_VOCABULARY.unknown),
} as const;

/**
 * Build the change-count summary tokens for a compare result, in the canonical
 * `+added · −removed · ~modified · fingerprint changed` order. The three count tokens are always
 * present (so a zero count reads explicitly); the trailing `fingerprint changed` token is added
 * only when the fingerprint actually changed.
 */
export function mcpChangeCountParts(compare: McpVersionCompare): McpChangeCountPart[] {
  const { counts } = compare;
  const parts: McpChangeCountPart[] = [
    {
      key: 'added',
      label: `+${counts.added} added`,
      colorClass: STATUS_TONE_SOFT_CLASS[CHANGE_TONE.added],
    },
    {
      key: 'removed',
      label: `−${counts.removed} removed`,
      colorClass: STATUS_TONE_SOFT_CLASS[CHANGE_TONE.removed],
    },
    {
      key: 'modified',
      label: `~${counts.modified} modified`,
      colorClass: STATUS_TONE_SOFT_CLASS[CHANGE_TONE.modified],
    },
  ];
  if (compare.fingerprint_changed) {
    // Not a change *kind* — a fact about the pair — so it stays the page's quiet ink rather
    // than borrowing one of the three tones beside it.
    parts.push({
      key: 'fingerprint',
      label: 'fingerprint changed',
      colorClass: STATUS_TONE_SOFT_CLASS.neutral,
    });
  }
  return parts;
}

/**
 * The `+N −N ~N` triple for one snapshot's own change counts (HIVE-7.8, #5325).
 *
 * The same three tones {@link mcpChangeCountParts} gives a compare, in the compact form a
 * timeline row prints. It exists so the two cannot drift: the timeline used to spell
 * `text-green-600 dark:text-green-400` and its two siblings inline, which is how a row's "+3"
 * ended up a different green from the diff header's above it.
 *
 * @param counts A snapshot's `change_counts`.
 * @returns Three tokens, always — a zero count reads explicitly rather than disappearing.
 */
export function mcpVersionChangeCountParts(
  counts: McpVersionChangeCounts,
): McpChangeCountPart[] {
  return [
    {
      key: 'added',
      label: `+${counts.added}`,
      colorClass: STATUS_TONE_SOFT_CLASS[CHANGE_TONE.added],
    },
    {
      key: 'removed',
      label: `−${counts.removed}`,
      colorClass: STATUS_TONE_SOFT_CLASS[CHANGE_TONE.removed],
    },
    {
      key: 'modified',
      label: `~${counts.modified}`,
      colorClass: STATUS_TONE_SOFT_CLASS[CHANGE_TONE.modified],
    },
  ];
}

/** Color-coded presentation for one change row, keyed off its direction. */
export interface McpChangeStyle {
  /** Human label for the direction (`Added` / `Removed` / `Modified` / `Changed`). */
  label: string;
  /** Sign glyph used in the summary and row badge (`+` / `−` / `~`). */
  sign: string;
  /**
   * The leading edge a change row is marked with.
   *
   * A *rule*, not a fill. It was `border-l-4 border-green-500 bg-green-50 dark:bg-green-900/20`
   * until HIVE-7.8 (#5325) — a tinted row — and a diff of twelve of those is a wall of colour
   * in which the *content* of the change is the thing that stops being legible. The row's own
   * kind badge carries the tone in a form a reader can name.
   */
  rowClass: string;
  /** Badge variant for the direction chip. */
  badgeVariant: McpBadgeVariant;
  /** The tone this change kind *is*, in the shared status vocabulary (HIVE-7.8, #5325). */
  tone: StatusTone;
}

/** Build one change kind's styling, taking its colour from the shared vocabulary. */
function changeStyle(
  label: string,
  sign: string,
  tone: StatusTone,
  badgeVariant: McpBadgeVariant,
): McpChangeStyle {
  return {
    label,
    sign,
    tone,
    badgeVariant,
    rowClass: `border-l-2 ${STATUS_TONE_BORDER_CLASS[tone]}`,
  };
}

const MCP_CHANGE_STYLES: Record<McpChangeType, McpChangeStyle> = {
  added: changeStyle('Added', '+', CHANGE_TONE.added, 'success'),
  removed: changeStyle('Removed', '−', CHANGE_TONE.removed, 'error'),
  modified: changeStyle('Modified', '~', CHANGE_TONE.modified, 'default'),
};

/** Neutral fallback styling for an unrecognized `change_type` (defensive; never expected). */
const MCP_CHANGE_STYLE_FALLBACK: McpChangeStyle = changeStyle(
  'Changed',
  '~',
  CHANGE_TONE.unknown,
  'secondary',
);

/** Resolve the color-coded styling for a change row from its `change_type`. */
export function mcpChangeStyle(changeType: string): McpChangeStyle {
  return MCP_CHANGE_STYLES[changeType as McpChangeType] ?? MCP_CHANGE_STYLE_FALLBACK;
}

/** Human label for a change's `item_type` (server metadata reads as "Server"). */
export function mcpChangeKindLabel(itemType: string): string {
  switch (itemType) {
    case 'tool':
      return 'Tool';
    case 'resource':
      return 'Resource';
    case 'resource_template':
      return 'Resource template';
    case 'prompt':
      return 'Prompt';
    case 'server':
      return 'Server';
    default:
      return itemType || 'Item';
  }
}

/** The item path shown on a change row, e.g. `Tool · search` or `Server · instructions`. */
export function mcpChangeItemPath(change: McpVersionChange): string {
  return `${mcpChangeKindLabel(change.item_type)} · ${change.item_name}`;
}

/** A before/after pair for a change, pretty-printed as JSON (NULL when that side is absent). */
export interface McpChangeBeforeAfter {
  before: string | null;
  after: string | null;
}

/**
 * Extract the before/after JSON blocks for a change row. A removal yields only `before`, an
 * addition only `after`, and a modification both; each side is pretty-printed, or NULL when the
 * change carries no payload for it.
 */
export function mcpChangeBeforeAfter(change: McpVersionChange): McpChangeBeforeAfter {
  const { detail } = change;
  return {
    before: detail.before === undefined ? null : mcpFormatJson(detail.before),
    after: detail.after === undefined ? null : mcpFormatJson(detail.after),
  };
}

/**
 * Toggle a version id within a two-slot selection (the timeline "tick two versions" model).
 *
 * - Ticking an already-selected id removes it.
 * - Ticking a new id when fewer than two are selected appends it.
 * - Ticking a new id when two are already selected drops the oldest pick and keeps the newest
 *   two, so a third tick rolls the selection forward rather than being ignored.
 *
 * Selection order is preserved (pick order), not chronological; chronological base→target
 * ordering is derived separately by {@link mcpOrderedPair}.
 */
export function mcpToggleSelection(current: string[], id: string): string[] {
  if (current.includes(id)) return current.filter((existing) => existing !== id);
  if (current.length < 2) return [...current, id];
  return [current[1], id];
}

/**
 * Order two selected versions chronologically (older→newer) so `added`/`removed` always read
 * relative to the older surface, auto-swapping regardless of pick order. Returns `null` until
 * two distinct slots are filled; when both ids are the same version, that single version is
 * returned as both base and target (the "identical surface" / same-version case).
 */
export function mcpOrderedPair(
  selection: string[],
  versions: McpVersionSummary[],
): { base: McpVersionSummary; target: McpVersionSummary } | null {
  const picked = selection
    .map((id) => versions.find((v) => v.id === id))
    .filter((v): v is McpVersionSummary => Boolean(v));
  if (picked.length === 0) return null;
  if (picked.length === 1) return { base: picked[0], target: picked[0] };
  const [a, b] = picked;
  return a.version_seq <= b.version_seq ? { base: a, target: b } : { base: b, target: a };
}

/** Stable cache/identity key for a base→target compare pair. */
export function mcpComparePairKey(baseId: string, targetId: string): string {
  return `${baseId}::${targetId}`;
}

/**
 * Build the two-slot compare selection that opens *the diff a version introduced* — the deep-link
 * target used by the churn timeline (MCAT-16.1 → MCAT-10.3). A snapshot's churn is measured against
 * its immediate predecessor, so the selection is `[version, predecessor]`: in the newest-first
 * `versions` list the predecessor is the next entry (one lower `version_seq`). The very first
 * snapshot has no predecessor, so it selects alone (the diff panel then compares it to itself — an
 * "identical surface" read, since there is nothing earlier to diff against). An id absent from the
 * list yields an empty selection (no change).
 *
 * @param versionId The snapshot to open the diff for.
 * @param versions  The endpoint's version list, newest-first (as {@link mcpVersionListFromPayload}
 *   returns).
 * @returns The version ids to tick into the compare selection, or `[]` when the id is unknown.
 */
export function mcpDiffSelectionForVersion(
  versionId: string,
  versions: McpVersionSummary[],
): string[] {
  const index = versions.findIndex((v) => v.id === versionId);
  if (index === -1) return [];
  // The list is newest-first, so the chronological predecessor sits at the next index.
  const predecessor = versions[index + 1];
  return predecessor ? [versionId, predecessor.id] : [versionId];
}
