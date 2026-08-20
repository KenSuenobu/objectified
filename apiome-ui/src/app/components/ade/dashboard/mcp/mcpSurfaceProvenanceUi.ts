/**
 * Declared-vs-observed surface attribution, as the UI needs it — FMT-1.7 (#5418).
 *
 * The pure half of the panel: the payload adapter, the vocabulary, and the grouping. Kept out
 * of the component for the reason every `*Ui.ts` sibling here is — the interesting rules are
 * about *what may be claimed*, and those are worth testing without mounting anything.
 *
 * Two rules the adapter enforces on the way in, mirroring `app.mcp_surface_provenance`:
 *
 * * **An unrecognised origin is `unrecorded`, never a source.** A payload from an older or
 *   newer server must not be able to make a fact read as observed when nothing observed it.
 * * **Absence is not agreement.** An endpoint with no manifest resolves to `observed_only`,
 *   whose summary says the surface has never been declared — not that the two sources concur.
 */

/** Where a surface fact came from. */
export type McpFactOrigin = 'declared' | 'observed' | 'both' | 'unrecorded';

/** Whether the two sources concur about a fact they both carry. */
export type McpFactAgreement = 'uncontested' | 'agrees' | 'conflicts';

/** How the declared and observed surfaces relate as wholes. */
export type McpSurfaceMatch =
  | 'none'
  | 'declared_only'
  | 'observed_only'
  | 'identical'
  | 'divergent';

/** One attributable fact about an endpoint's surface. */
export interface McpSurfaceFact {
  /** `surface` for an identity field, else the capability kind. */
  scope: string;
  /** Stable identifier within the scope — a field path or a capability name. */
  key: string;
  /** What the reader sees for this fact. */
  label: string;
  /** Human label for the fact's scope (`Tool`, `Server identity`, …). */
  kindLabel: string;
  /** Which source(s) carry it. */
  origin: McpFactOrigin;
  /** Whether those sources concur. */
  agreement: McpFactAgreement;
  /** The manifest's value, when it states one. */
  declared: unknown;
  /** The probe's value, when it saw one. */
  observed: unknown;
}

/** The whole attribution for one endpoint. */
export interface McpSurfaceProvenance {
  surfaceMatch: McpSurfaceMatch;
  declaredFingerprint: string | null;
  observedFingerprint: string | null;
  fingerprintsMatch: boolean;
  conflictCount: number;
  originCounts: Record<McpFactOrigin, number>;
  facts: McpSurfaceFact[];
}

/** A group of facts sharing a scope, in render order. */
export interface McpSurfaceFactGroup {
  scope: string;
  kindLabel: string;
  facts: McpSurfaceFact[];
}

const ORIGINS: readonly McpFactOrigin[] = ['declared', 'observed', 'both', 'unrecorded'];
const AGREEMENTS: readonly McpFactAgreement[] = ['uncontested', 'agrees', 'conflicts'];
const SURFACE_MATCHES: readonly McpSurfaceMatch[] = [
  'none',
  'declared_only',
  'observed_only',
  'identical',
  'divergent',
];

/** The order fact groups are drawn in: identity first, then the four capability kinds. */
const SCOPE_ORDER: readonly string[] = [
  'surface',
  'tool',
  'resource',
  'resource_template',
  'prompt',
];

/** The badge tone each origin wears. Names only — the tone owns its own ink/ground pair. */
export const MCP_ORIGIN_TONE: Readonly<Record<McpFactOrigin, string>> = {
  declared: 'accent',
  observed: 'ok',
  both: 'violet',
  unrecorded: 'neutral',
};

/** The short label each origin wears on its pill. */
export const MCP_ORIGIN_LABEL: Readonly<Record<McpFactOrigin, string>> = {
  declared: 'Declared',
  observed: 'Observed',
  both: 'Both',
  unrecorded: 'Unrecorded',
};

/** What each origin means, spelled once for the legend and the pill's tooltip. */
export const MCP_ORIGIN_MEANING: Readonly<Record<McpFactOrigin, string>> = {
  declared: 'Stated by an imported manifest. Nothing has watched the server offer it.',
  observed: 'Seen during discovery. No manifest mentions it.',
  both: 'An imported manifest states it and discovery saw it.',
  unrecorded: 'The source of this fact was not recorded.',
};

/** The badge tone each agreement state wears. */
export const MCP_AGREEMENT_TONE: Readonly<Record<McpFactAgreement, string>> = {
  uncontested: 'neutral',
  agrees: 'ok',
  conflicts: 'warn',
};

/** The headline each surface relationship gets. */
export const MCP_SURFACE_MATCH_TITLE: Readonly<Record<McpSurfaceMatch, string>> = {
  none: 'Nothing known about this surface',
  declared_only: 'Declared, never observed',
  observed_only: 'Observed, never declared',
  identical: 'The manifest matches what discovery saw',
  divergent: 'The manifest and the last discovery disagree',
};

/** The sentence under that headline. */
export const MCP_SURFACE_MATCH_SUMMARY: Readonly<Record<McpSurfaceMatch, string>> = {
  none: 'This endpoint has neither an imported manifest nor a discovered snapshot, so there is nothing to attribute yet.',
  declared_only:
    'Every fact below comes from an imported manifest. Run discovery to confirm the server offers what the manifest claims.',
  observed_only:
    'Every fact below was seen during discovery. No manifest has been imported for this endpoint.',
  identical:
    'The imported manifest and the current snapshot produce the same surface fingerprint, so every fact below is corroborated by both.',
  divergent:
    'The imported manifest and the current snapshot produce different surface fingerprints. Each fact below names the source it came from; conflicting facts show both values.',
};

/** The tone the summary card wears for each relationship. */
export const MCP_SURFACE_MATCH_TONE: Readonly<Record<McpSurfaceMatch, string>> = {
  none: 'neutral',
  declared_only: 'accent',
  observed_only: 'ok',
  identical: 'ok',
  divergent: 'warn',
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function asOrigin(value: unknown): McpFactOrigin {
  const candidate = asString(value) as McpFactOrigin;
  return ORIGINS.includes(candidate) ? candidate : 'unrecorded';
}

function asAgreement(value: unknown): McpFactAgreement {
  const candidate = asString(value) as McpFactAgreement;
  return AGREEMENTS.includes(candidate) ? candidate : 'uncontested';
}

function asSurfaceMatch(value: unknown): McpSurfaceMatch {
  const candidate = asString(value) as McpSurfaceMatch;
  return SURFACE_MATCHES.includes(candidate) ? candidate : 'none';
}

function factFromPayload(raw: unknown): McpSurfaceFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const key = asString(entry.key);
  if (!key) return null;
  return {
    scope: asString(entry.scope) || 'surface',
    key,
    label: asString(entry.label) || key,
    kindLabel: asString(entry.kind_label) || 'Fact',
    origin: asOrigin(entry.origin),
    agreement: asAgreement(entry.agreement),
    declared: entry.declared ?? null,
    observed: entry.observed ?? null,
  };
}

/**
 * Adapt the REST payload into the panel's shape.
 *
 * @param payload The `GET …/surface-provenance` body, or anything else.
 * @returns The attribution. A payload that is missing, malformed, or from a version this build
 *   does not understand resolves to the empty `none` report — which claims nothing — rather
 *   than to a partially-filled one that would.
 */
export function mcpSurfaceProvenanceFromPayload(payload: unknown): McpSurfaceProvenance {
  const empty: McpSurfaceProvenance = {
    surfaceMatch: 'none',
    declaredFingerprint: null,
    observedFingerprint: null,
    fingerprintsMatch: false,
    conflictCount: 0,
    originCounts: { declared: 0, observed: 0, both: 0, unrecorded: 0 },
    facts: [],
  };
  if (!payload || typeof payload !== 'object') return empty;

  const body = payload as Record<string, unknown>;
  const rawCounts = (body.origin_counts ?? {}) as Record<string, unknown>;
  const facts = Array.isArray(body.facts)
    ? body.facts.map(factFromPayload).filter((fact): fact is McpSurfaceFact => fact !== null)
    : [];

  return {
    surfaceMatch: asSurfaceMatch(body.surface_match),
    declaredFingerprint: asString(body.declared_fingerprint) || null,
    observedFingerprint: asString(body.observed_fingerprint) || null,
    fingerprintsMatch: body.fingerprints_match === true,
    conflictCount: asCount(body.conflict_count),
    originCounts: {
      declared: asCount(rawCounts.declared),
      observed: asCount(rawCounts.observed),
      both: asCount(rawCounts.both),
      unrecorded: asCount(rawCounts.unrecorded),
    },
    facts,
  };
}

/**
 * Group facts by scope in render order — identity first, then tools, resources, templates, prompts.
 *
 * @param facts The attributed facts.
 * @returns One group per non-empty scope. A scope the server sent that this build does not know
 *   is kept and appended, so a new capability kind renders rather than vanishing.
 */
export function groupSurfaceFacts(facts: readonly McpSurfaceFact[]): McpSurfaceFactGroup[] {
  const groups = new Map<string, McpSurfaceFactGroup>();
  for (const fact of facts) {
    const existing = groups.get(fact.scope);
    if (existing) {
      existing.facts.push(fact);
    } else {
      groups.set(fact.scope, { scope: fact.scope, kindLabel: fact.kindLabel, facts: [fact] });
    }
  }
  const rank = (scope: string) => {
    const index = SCOPE_ORDER.indexOf(scope);
    return index === -1 ? SCOPE_ORDER.length : index;
  };
  return [...groups.values()].sort(
    (a, b) => rank(a.scope) - rank(b.scope) || a.scope.localeCompare(b.scope),
  );
}

/**
 * Render a fact's value for the conflict comparison.
 *
 * @param value The declared or observed value.
 * @returns Pretty JSON for a structured value, the string itself for text, and an em dash when
 *   the source states nothing — never `"null"` or `"undefined"`, which read as data.
 */
export function formatFactValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '—';
  } catch {
    return String(value);
  }
}

/**
 * Shorten a surface fingerprint for display.
 *
 * @param fingerprint The full hex digest, or null.
 * @returns Its first twelve characters, or `—` when there is none. Never a fabricated value:
 *   an absent fingerprint means that source does not exist for this endpoint.
 */
export function shortFingerprint(fingerprint: string | null): string {
  if (!fingerprint) return '—';
  return fingerprint.length <= 12 ? fingerprint : `${fingerprint.slice(0, 12)}…`;
}
