/**
 * catalog-detail-insights — pure derivations for the catalog item detail's Overview tab.
 *
 * The detail payload (MFI-23.2/25.2) already carries everything needed for real observability —
 * the normalized counts, the parsed entity groups with their fields, and the captured quality
 * score — but the Overview used to render only four bare numbers. These helpers fold that payload
 * into the richer read the import wizard's preview gives (IXH-3.2): what the surface is made of,
 * how well it is documented, and how the entity kinds distribute.
 *
 * Everything here is presentation-agnostic (no Tailwind classes, no JSX) so it can be pinned by
 * plain unit tests; the client maps the results onto the app's shared tone palette.
 */

/** The field shape the derivations need (structurally compatible with `CatalogParsedField`). */
export interface InsightParsedField {
  description?: string | null;
  required?: boolean | null;
}

/** The entity shape the derivations need (structurally compatible with `CatalogParsedEntity`). */
export interface InsightParsedEntity {
  name: string;
  tag: string;
  fields: InsightParsedField[];
}

/** The group shape the derivations need (structurally compatible with `CatalogParsedGroup`). */
export interface InsightParsedGroup {
  title: string;
  entities: InsightParsedEntity[];
}

/** One entity-kind slice of the parsed model (e.g. QUERY 8 · 42%). */
export interface TagDistributionRow {
  /** The uppercased entity tag (QUERY, OBJECT, SERVICE, …). */
  tag: string;
  count: number;
  /** Share of all tagged entities, rounded to a whole percent. */
  percent: number;
}

/**
 * Tally entity kinds across every parsed group into a distribution, largest slice first (ties keep
 * first-seen order). Tags are uppercased so `query`/`QUERY` fold together; untagged entities are
 * skipped. Returns `[]` when there is no parsed model or nothing is tagged.
 */
export function deriveTagDistribution(
  parsed: InsightParsedGroup[] | null | undefined,
): TagDistributionRow[] {
  if (!parsed || parsed.length === 0) return [];
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const group of parsed) {
    for (const entity of group.entities) {
      const tag = (entity.tag ?? '').trim().toUpperCase();
      if (!tag) continue;
      if (!counts.has(tag)) order.push(tag);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return order
    .map((tag) => ({
      tag,
      count: counts.get(tag)!,
      percent: Math.round(((counts.get(tag) ?? 0) / total) * 100),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Documentation / requiredness roll-up of the parsed model's field rows. */
export interface ParsedFieldStats {
  entityCount: number;
  fieldCount: number;
  /** Fields carrying a non-blank description. */
  documentedFieldCount: number;
  requiredFieldCount: number;
  /** Whole-percent share of documented fields, or `null` when there are no fields to measure. */
  documentedPercent: number | null;
  /** Whole-percent share of required fields, or `null` when there are no fields to measure. */
  requiredPercent: number | null;
}

/**
 * Roll the parsed groups' field rows up into documentation-coverage stats — the "how usable is
 * this model" read the Overview surfaces. A missing/empty model yields all-zero counts with `null`
 * percentages so callers can render an explicit "nothing to measure" state.
 */
export function deriveParsedFieldStats(
  parsed: InsightParsedGroup[] | null | undefined,
): ParsedFieldStats {
  let entityCount = 0;
  let fieldCount = 0;
  let documentedFieldCount = 0;
  let requiredFieldCount = 0;
  for (const group of parsed ?? []) {
    for (const entity of group.entities) {
      entityCount += 1;
      for (const field of entity.fields) {
        fieldCount += 1;
        if (typeof field.description === 'string' && field.description.trim() !== '') {
          documentedFieldCount += 1;
        }
        if (field.required) requiredFieldCount += 1;
      }
    }
  }
  const pct = (n: number) => (fieldCount > 0 ? Math.round((n / fieldCount) * 100) : null);
  return {
    entityCount,
    fieldCount,
    documentedFieldCount,
    requiredFieldCount,
    documentedPercent: pct(documentedFieldCount),
    requiredPercent: pct(requiredFieldCount),
  };
}

/** The normalized-summary keys, in display order. */
export const SURFACE_KEYS = ['services', 'operations', 'types', 'channels'] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

/** One non-empty slice of the normalized summary's composition bar. */
export interface SurfaceSegment {
  key: SurfaceKey;
  count: number;
  /** Share of the summed captured counts, rounded to a whole percent. */
  percent: number;
}

/** The normalized summary folded into a stacked-bar composition. */
export interface SurfaceComposition {
  /** Sum of every captured (numeric) count. */
  total: number;
  /** Non-zero slices in display order; empty when nothing was captured or all counts are zero. */
  segments: SurfaceSegment[];
}

/**
 * Fold the normalized-summary counts into the composition the Overview's stacked bar renders.
 * Null (uncaptured) counts are skipped rather than treated as zero, so a partially-captured
 * summary still yields an honest share-of-what-we-know bar.
 */
export function deriveSurfaceComposition(
  summary: Partial<Record<SurfaceKey, number | null | undefined>> | null | undefined,
): SurfaceComposition {
  const counts = SURFACE_KEYS.map((key) => ({
    key,
    count: typeof summary?.[key] === 'number' ? (summary![key] as number) : null,
  }));
  const total = counts.reduce((sum, c) => sum + (c.count ?? 0), 0);
  if (total <= 0) return { total: 0, segments: [] };
  return {
    total,
    segments: counts
      .filter((c): c is { key: SurfaceKey; count: number } => (c.count ?? 0) > 0)
      .map((c) => ({ key: c.key, count: c.count, percent: Math.round((c.count / total) * 100) })),
  };
}

/**
 * Render an ISO instant as a coarse relative phrase ("3 days ago") for the provenance timeline.
 * Returns `null` for absent/invalid input; instants under a minute old (or in the future, e.g.
 * clock skew) read as "just now". `nowMs` is injectable so tests stay deterministic.
 */
export function formatRelativeTimestamp(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const seconds = Math.floor((nowMs - ms) / 1000);
  if (seconds < 60) return 'just now';
  const units: readonly [limit: number, divisor: number, label: string][] = [
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [2592000, 86400, 'day'],
    [31536000, 2592000, 'month'],
  ];
  for (const [limit, divisor, label] of units) {
    if (seconds < limit) {
      const n = Math.floor(seconds / divisor);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  const years = Math.floor(seconds / 31536000);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
