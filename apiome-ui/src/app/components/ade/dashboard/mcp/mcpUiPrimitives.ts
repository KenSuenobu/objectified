/**
 * Shared MCP UI primitives — design tokens & pure presentation helpers (V2-MCP-24.7 / MCAT-10.7).
 *
 * Every MCP catalog screen (browse grid, endpoint detail, lint & score, import flow) reuses the
 * same visual atoms the mockup defines — the A–F grade glyph, the transport / visibility / auth /
 * capability-annotation badges, the health & "last discovered" pills, the MUST/SHOULD finding
 * severity styling, and the detail tab strip. This module holds the *pure*, React-free
 * mappings those primitives render from, so they can be unit-tested directly and so the React
 * components stay free of color/branching literals.
 *
 * Colors are expressed as Tailwind utility classes (the project's token layer, mapped centrally to
 * the brand indigo / slate / emerald / amber / red scales and their `dark:` variants in
 * `globals.css`). Consumers never hard-code a hex or spacing value — they pass a domain value
 * (e.g. a transport string) and receive a {@link McpBadgeTone} + label.
 *
 * HIVE-2.4 (#5283) moved the three mappings that answer a *status* question — the grade bands,
 * the health pill and the freshness pill — onto the app-wide vocabulary in
 * `ui/statusVocabulary.ts`. They keep their names and their shapes, and gained a `tone`; what
 * changed is that the colour is now the same one every other surface gives that state, and it
 * follows the reader's theme through the Hive token layer instead of a `dark:` variant. The
 * mappings that answer a *property* question (transport, auth, provenance, lint tier) are
 * untouched — they are not part of the status vocabulary.
 */

import type { McpLintTier } from './mcpLintUi';
import {
  GRADE_BANDS,
  GRADE_BAND_UNSCORED,
  GRADE_LETTERS,
  STATUS_TONE_DOT_CLASS,
  STATUS_TONE_TEXT_CLASS,
  statusTone,
  type GradeLetter,
  type StatusTone,
} from '../../../ui/statusVocabulary';

// --- Grade glyph ----------------------------------------------------------------------------
// The A–F glyph is the lead signal on cards, headers, and the lint gauge. Since HIVE-2.4 (#5283)
// the bands themselves live in the shared status vocabulary, alongside the catalog's `GradeChip`
// — the two used to carry a palette each, so the same B was two different greens. The helpers
// below stay, because the MCP surface asks for a grade by this name; they are now a thin
// projection of `ui/statusVocabulary`.

/** Normalized A–F letter grade (anything unrecognized collapses to `null` → unscored). */
export type McpGradeLetter = GradeLetter;

/** Visual styling for one grade glyph: the solid chip fill and the matching on-surface text tint. */
export interface McpGradeGlyphStyle {
  /** A–F, or `null` when the endpoint/version is unscored. */
  letter: McpGradeLetter | null;
  /** The status tone the band belongs to — its place in the wider vocabulary. */
  tone: StatusTone;
  /** Classes for the solid square chip (background + readable foreground). */
  chipClass: string;
  /** Text-color class for the letter when drawn over a surface (e.g. the gauge center). */
  textClass: string;
  /** Color class for the gauge ring arc (the arc strokes `currentColor`). */
  ringClass: string;
}

/** The five bands, as a set, for the exact-match normalization below. */
const GRADE_LETTER_SET: ReadonlySet<string> = new Set(GRADE_LETTERS);

/**
 * Coerce an arbitrary grade value to a known A–F letter, or `null` when unrecognized/empty.
 *
 * Deliberately stricter than the catalog's `normalizeGradeLetter`, which reads the leading
 * character so a fuller `A-` still lands on its band: an MCP grade is always a bare letter, so a
 * value like `A+` is a sign the caller has the wrong field rather than a grade to round off.
 */
export function mcpNormalizeGrade(grade: string | null | undefined): McpGradeLetter | null {
  if (typeof grade !== 'string') return null;
  const upper = grade.trim().toUpperCase();
  return GRADE_LETTER_SET.has(upper) ? (upper as McpGradeLetter) : null;
}

/** Resolve the glyph styling for a grade letter (defensively normalized); unscored → neutral. */
export function mcpGradeGlyphStyle(grade: string | null | undefined): McpGradeGlyphStyle {
  const letter = mcpNormalizeGrade(grade);
  const band = letter ? GRADE_BANDS[letter] : GRADE_BAND_UNSCORED;
  return {
    letter: band.letter,
    tone: band.tone,
    chipClass: band.solidClass,
    textClass: band.textClass,
    ringClass: band.arcClass,
  };
}

// --- Badge tones ----------------------------------------------------------------------------
// The mockup's `.badge.*` palette: a soft tinted fill + matching text + hairline border, in seven
// semantic tones. McpBadge renders any tone; the resolvers below map a domain value (transport,
// visibility, auth scheme, capability annotation) to the tone + label the mockup specifies.

/** The seven semantic badge tones the MCP surface uses (mirrors the mockup `.badge.*` classes). */
export type McpBadgeTone = 'indigo' | 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'violet';

/** A resolved badge: the tone to paint it and the human label to show. */
export interface McpBadgeSpec {
  tone: McpBadgeTone;
  label: string;
}

/**
 * Resolve an endpoint's transport to a badge. Both the modern `streamable_http` and the legacy
 * `http+sse` transports render as neutral slate chips; the legacy one is labelled as such so it
 * reads as deprecated, matching the mockup.
 */
export function mcpTransportBadge(transport: string | null | undefined): McpBadgeSpec {
  const value = (transport ?? '').trim().toLowerCase();
  if (value === 'streamable_http' || value === 'streamable-http' || value === 'streamablehttp') {
    return { tone: 'slate', label: 'streamable_http' };
  }
  if (
    value === 'http+sse' ||
    value === 'http_sse' ||
    value === 'sse' ||
    value === 'legacy' ||
    value === 'http+sse (legacy)'
  ) {
    return { tone: 'slate', label: 'http+sse (legacy)' };
  }
  return { tone: 'slate', label: transport && transport.trim() ? transport : 'unknown transport' };
}

/** Resolve an endpoint's published flag to a badge: published → green, unpublished → slate. */
export function mcpPublishedBadge(published: boolean): McpBadgeSpec {
  return published
    ? { tone: 'green', label: 'Published' }
    : { tone: 'slate', label: 'Unpublished' };
}

/** Resolve an endpoint's visibility to a badge: private → indigo, public → green. */
export function mcpVisibilityBadge(visibility: string | null | undefined): McpBadgeSpec {
  const value = (visibility ?? '').trim().toLowerCase();
  if (value === 'public') return { tone: 'green', label: 'Public' };
  if (value === 'private') return { tone: 'indigo', label: 'Private' };
  return { tone: 'slate', label: visibility && visibility.trim() ? visibility : 'Unknown' };
}

/**
 * Resolve an auth scheme to a badge: bearer / header token auth → green, OAuth 2.1 → violet, and
 * an explicit "none" → neutral slate.
 */
export function mcpAuthBadge(scheme: string | null | undefined): McpBadgeSpec {
  const value = (scheme ?? '').trim().toLowerCase();
  if (value === 'bearer') return { tone: 'green', label: 'bearer' };
  if (value === 'header') return { tone: 'green', label: 'header' };
  if (value === 'oauth' || value === 'oauth2' || value === 'oauth_2_1' || value === 'oauth 2.1') {
    return { tone: 'violet', label: 'OAuth 2.1' };
  }
  if (value === 'none' || value === '') return { tone: 'slate', label: 'No auth' };
  return { tone: 'slate', label: scheme as string };
}

/**
 * The MCP tool behavioural annotations, in spec order, with the tone + label the mockup shows when
 * the hint is asserted: readOnly → green, idempotent → blue, destructive → red, openWorld → amber.
 */
const CAPABILITY_ANNOTATION_BADGES: Record<string, McpBadgeSpec> = {
  readOnlyHint: { tone: 'green', label: 'readOnly' },
  idempotentHint: { tone: 'blue', label: 'idempotent' },
  destructiveHint: { tone: 'red', label: 'destructive' },
  openWorldHint: { tone: 'amber', label: 'openWorld' },
};

/** Spec order for the capability-annotation badges, so a card renders them predictably. */
export const MCP_CAPABILITY_ANNOTATION_ORDER: readonly string[] = [
  'readOnlyHint',
  'idempotentHint',
  'destructiveHint',
  'openWorldHint',
] as const;

/**
 * Resolve one capability annotation hint to a badge, or `null` when the hint key is unknown. Only
 * *asserted* (true) hints get a badge — a `false` hint means "this behaviour does not apply" and so
 * is not surfaced, matching the mockup which only shows the chips that are on.
 */
export function mcpCapabilityAnnotationBadge(
  hintKey: string,
  value: boolean,
): McpBadgeSpec | null {
  if (!value) return null;
  return CAPABILITY_ANNOTATION_BADGES[hintKey] ?? null;
}

/**
 * The lifecycle stages the server-side detector rolls a capability up to (V2-MCP-34.4), with the
 * tone + label a capability card shows: deprecated → red, experimental → amber, beta → violet,
 * and an *explicitly declared* stable → green.
 */
const CAPABILITY_LIFECYCLE_BADGES: Record<string, McpBadgeSpec> = {
  deprecated: { tone: 'red', label: 'deprecated' },
  experimental: { tone: 'amber', label: 'experimental' },
  beta: { tone: 'violet', label: 'beta' },
  stable: { tone: 'green', label: 'stable (declared)' },
};

/**
 * Resolve a capability's rolled-up lifecycle stage to a badge, or `null` when there is nothing to
 * show. `unspecified` (and any unknown stage) deliberately renders **no** badge — a capability the
 * server says nothing about must never read as "stable"; only an explicit annotation declaration
 * earns the green chip.
 */
export function mcpLifecycleBadge(stage: string | null | undefined): McpBadgeSpec | null {
  const value = (stage ?? '').trim().toLowerCase();
  return CAPABILITY_LIFECYCLE_BADGES[value] ?? null;
}

/**
 * The discovery-run origins provenance records (V2-MCP-34.5), with the tone + label the identity
 * card's provenance strip shows: manual → blue, sweep → indigo, registry → violet. `unrecorded`
 * (a pre-provenance snapshot) renders a neutral slate chip — stated plainly, never presented as
 * any concrete origin.
 */
const PROVENANCE_TRIGGER_BADGES: Record<string, McpBadgeSpec> = {
  manual: { tone: 'blue', label: 'manual run' },
  sweep: { tone: 'indigo', label: 'scheduled sweep' },
  registry: { tone: 'violet', label: 'registry refresh' },
  unrecorded: { tone: 'slate', label: 'unrecorded' },
};

/**
 * Resolve which discovery run produced a snapshot to a badge. A missing or unknown trigger
 * resolves to the neutral `unrecorded` chip rather than `null`: on a provenance strip, "we don't
 * know" is itself the information to show.
 */
export function mcpProvenanceTriggerBadge(trigger: string | null | undefined): McpBadgeSpec {
  const value = (trigger ?? '').trim().toLowerCase();
  return PROVENANCE_TRIGGER_BADGES[value] ?? PROVENANCE_TRIGGER_BADGES.unrecorded;
}

/**
 * The ways an endpoint can enter the catalog (`mcp_endpoints.added_via`, V2-MCP-34.5), labelled
 * for the provenance strip: manual registration → blue, registry import → violet, bulk import →
 * indigo.
 */
const PROVENANCE_ADDED_VIA_BADGES: Record<string, McpBadgeSpec> = {
  manual: { tone: 'blue', label: 'added manually' },
  registry: { tone: 'violet', label: 'added from registry' },
  import: { tone: 'indigo', label: 'added via import' },
};

/**
 * Resolve how an endpoint entered the catalog to a badge. An unknown stored value falls back to a
 * neutral slate chip carrying the raw value, so a future origin is shown verbatim rather than
 * mislabeled.
 */
export function mcpProvenanceAddedViaBadge(addedVia: string | null | undefined): McpBadgeSpec {
  const value = (addedVia ?? '').trim().toLowerCase();
  if (value === '') return PROVENANCE_ADDED_VIA_BADGES.manual;
  return PROVENANCE_ADDED_VIA_BADGES[value] ?? { tone: 'slate', label: `added via ${value}` };
}

// --- Health pill ----------------------------------------------------------------------------
// An endpoint's reachability, distilled from its last discovery status into three signal states
// (plus an "unknown" fallback before the first discovery).
//
// Since HIVE-2.4 (#5283) the colour is not decided here: each state names the vocabulary string
// it *is* (`healthy`, `degraded`, `unreachable`, `unknown`) and the shared vocabulary answers
// with the tone. That is the whole point of the ticket — a degraded MCP endpoint and a degraded
// anything-else are the same amber, because the same table answered both.

/** Endpoint health signal states, strongest (healthy) to weakest (unreachable). */
export type McpHealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

/** Visual + label metadata for one health state. */
export interface McpHealthMeta {
  status: McpHealthStatus;
  label: string;
  /** The shared vocabulary tone this state resolves to. */
  tone: StatusTone;
  /** Token class for the status-dot fill. */
  dotClass: string;
  /** Token class for the accompanying label. */
  textClass: string;
}

/** The vocabulary string each health state speaks, for {@link statusTone} to answer. */
const HEALTH_VOCABULARY: Record<McpHealthStatus, string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  unreachable: 'unreachable',
  unknown: 'unknown',
};

/** Human labels; the MCP surface says "Unreachable" where the vocabulary says `down`. */
const HEALTH_LABEL: Record<McpHealthStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
};

/** Build one health entry from the shared vocabulary, so no colour is chosen locally. */
function healthEntry(status: McpHealthStatus): McpHealthMeta {
  const tone = statusTone(HEALTH_VOCABULARY[status]);
  return {
    status,
    label: HEALTH_LABEL[status],
    tone,
    dotClass: STATUS_TONE_DOT_CLASS[tone],
    textClass: STATUS_TONE_TEXT_CLASS[tone],
  };
}

const HEALTH_META: Record<McpHealthStatus, McpHealthMeta> = {
  healthy: healthEntry('healthy'),
  degraded: healthEntry('degraded'),
  unreachable: healthEntry('unreachable'),
  unknown: healthEntry('unknown'),
};

/** Resolve the display metadata for a health status. */
export function mcpHealthMeta(status: McpHealthStatus): McpHealthMeta {
  return HEALTH_META[status];
}

/**
 * Map a raw discovery status (as recorded on the endpoint) to a {@link McpHealthStatus}.
 *
 * Successful discovery runs stamp `changed` (new version) or `unchanged` (same surface fingerprint)
 * — both mean the server was reached. Absent/blank statuses — an endpoint not yet discovered —
 * resolve to `unknown`; anything unrecognized is treated conservatively as `unreachable`.
 */
export function mcpHealthFromDiscoveryStatus(status: string | null | undefined): McpHealthStatus {
  const value = (status ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  // Success outcomes from the discovery engine / sweep (`changed` / `unchanged`) plus legacy aliases.
  if (
    [
      'ok',
      'success',
      'succeeded',
      'healthy',
      'reachable',
      'complete',
      'completed',
      'changed',
      'unchanged',
    ].includes(value)
  ) {
    return 'healthy';
  }
  if (['degraded', 'partial', 'partial_page', 'warning', 'warn', 'stale'].includes(value)) {
    return 'degraded';
  }
  if (
    [
      'error',
      'failed',
      'failure',
      'unreachable',
      'timeout',
      'timed_out',
      'connect_timeout',
      'connect_error',
      'tls_error',
      'refused',
    ].includes(value)
  ) {
    return 'unreachable';
  }
  // Specific discovery error codes (auth_required, rate_limited, protocol_error, …) are still
  // failures to reach a usable surface — treat them as unreachable rather than inventing new pills.
  return 'unreachable';
}

// --- Freshness pill -------------------------------------------------------------------------
// Catalog staleness: cadence overdue, failing streak, backoff hold, or quarantine. Healthy endpoints
// stay unbadged (`fresh`).

/** Freshness labels returned by the catalog freshness report and browse cards. */
export type McpFreshnessStatus = 'fresh' | 'stale' | 'failing' | 'backoff' | 'quarantined';

export interface McpFreshnessMeta {
  status: McpFreshnessStatus;
  label: string;
  /** The shared vocabulary tone this state resolves to. */
  tone: StatusTone;
  /** Token class for the status-dot fill. */
  dotClass: string;
  /** Token class for the accompanying label. */
  textClass: string;
}

/** Human labels for the four states that are worth showing (`fresh` renders nothing). */
const FRESHNESS_LABEL: Record<Exclude<McpFreshnessStatus, 'fresh'>, string> = {
  stale: 'Stale',
  failing: 'Failing',
  backoff: 'Backoff',
  quarantined: 'Quarantined',
};

/**
 * Build one freshness entry from the shared vocabulary (HIVE-2.4, #5283).
 *
 * Every freshness value is already a status string the vocabulary knows — `stale` and `backoff`
 * are warnings, `failing` and `quarantined` are failures — so the tone comes from the same table
 * that colours the version lifecycle and the health pill.
 */
function freshnessEntry(status: Exclude<McpFreshnessStatus, 'fresh'>): McpFreshnessMeta {
  const tone = statusTone(status === 'failing' ? 'failed' : status);
  return {
    status,
    label: FRESHNESS_LABEL[status],
    tone,
    dotClass: STATUS_TONE_DOT_CLASS[tone],
    textClass: STATUS_TONE_TEXT_CLASS[tone],
  };
}

const FRESHNESS_META: Record<Exclude<McpFreshnessStatus, 'fresh'>, McpFreshnessMeta> = {
  stale: freshnessEntry('stale'),
  failing: freshnessEntry('failing'),
  backoff: freshnessEntry('backoff'),
  quarantined: freshnessEntry('quarantined'),
};

export function mcpFreshnessMeta(status: string | null | undefined): McpFreshnessMeta | null {
  const value = (status ?? '').trim().toLowerCase();
  if (!value || value === 'fresh') return null;
  if (value in FRESHNESS_META) {
    return FRESHNESS_META[value as Exclude<McpFreshnessStatus, 'fresh'>];
  }
  return FRESHNESS_META.stale;
}

// --- Recency --------------------------------------------------------------------------------
// "Last discovered …" recency, rendered as a compact relative span (just now / 5m / 2h / 3d), and
// falling back to an absolute date for anything older than ~30 days or when the timestamp is
// unparseable. `nowMs` is injected so the formatting is deterministic under test.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Format an ISO timestamp as a short relative recency string, given the current time in ms.
 *
 * @param iso   The ISO-8601 instant to describe, or `null`/invalid.
 * @param nowMs The current time in epoch ms (injected for deterministic tests). Defaults to the
 *              wall clock; the default lives here, in a plain module function, so React components
 *              never read the clock during render (which the React-compiler purity rule forbids).
 * @returns `never` when absent/unparseable, otherwise `just now` / `5m ago` / `2h ago` / `3d ago`,
 *          or a locale date string for instants more than ~30 days old.
 */
export function mcpRelativeTime(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'never';
  const diff = nowMs - ms;
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// --- Finding severity -----------------------------------------------------------------------
// The MUST vs SHOULD split is the lint surface's headline. The tier metadata itself lives in
// `mcpLintUi` (so it stays the single source of truth shared with the lint helpers); here we only
// add the human one-word severity label used by the <FindingSeverity> chip.

/** Short, human label for a requirement tier (`MUST` / `SHOULD` / `Advisory`). */
export const MCP_LINT_TIER_LABEL: Record<McpLintTier, string> = {
  must: 'MUST',
  should: 'SHOULD',
  advisory: 'Advisory',
};

// --- Detail tabs ----------------------------------------------------------------------------
// The detail tab shell. The constant is the single definition of the tab set + order +
// labels; a screen renders the full set or any subset it has content for.

/** One tab in the endpoint detail shell. */
export interface McpDetailTab {
  /** Stable value used as the Radix tab key and content id. */
  value: string;
  /** Human label shown in the tab strip. */
  label: string;
}

/**
 * The canonical MCP endpoint detail strip, in display order (matches the mockup). The `insight` tab
 * (V2-MCP-28.4) sits after Capabilities as the home for the server-profile / evolution / reliability
 * visualizations; a screen renders the full set or any subset it has content for.
 */
export const MCP_DETAIL_TABS: readonly McpDetailTab[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'capabilities', label: 'Capabilities' },
  { value: 'insight', label: 'Insight' },
  { value: 'versions', label: 'Versions' },
  { value: 'lint', label: 'Lint & Score' },
  { value: 'test', label: 'Test' },
  { value: 'credentials', label: 'Credentials' },
  { value: 'settings', label: 'Settings' },
] as const;
