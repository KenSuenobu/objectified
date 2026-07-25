/**
 * Import preview manifest client contract and tree projection (IXH-3.2, #5104).
 *
 * The catalog import wizard's **quality** step shows what a candidate would add to the catalog
 * *before* the commit by calling `POST /api/import/preview-manifest`, the same-origin proxy for the
 * IXH-3.1 manifest API (`POST /v1/tenants/{tenant}/import/preview-manifest`, #5103). The server
 * extends the pre-flight into a full entity manifest: the canonical tree (services → operations,
 * channels, types) with stable keys, per-entity provenance and source locations, and a coverage
 * ledger. Everything the preview panel needs that is not DOM — the response shape, the fetch, the
 * flat-tree projection the windowed ARIA tree renders, page merging, and the coverage presentation
 * maps — lives here so each rule is unit-testable on its own.
 *
 * Invariants the callers depend on:
 *
 *  1. **A candidate that cannot be previewed is a 200 with `ok: false` and `manifest: null`.** The
 *     transport succeeded; the answer is "there is nothing to preview". Only a genuine
 *     transport/proxy failure throws.
 *  2. **The manifest is cursor-paginated over the flat entity list.** Identity fields
 *     (`manifest_hash`, `counts`, `total_entities`) always describe the *full* manifest; the list
 *     fields carry one page. {@link mergeManifestPages} accumulates pages client-side.
 *  3. **The four coverage classes are never conflated.** In particular
 *     `unsupported-by-canonical-model` (the canonical model cannot represent it) and
 *     `not-parsed-by-adapter` (the adapter never read it) are distinct verdicts server-side and keep
 *     distinct labels and tones here.
 */

import type { PreflightCounts, PreflightReport, PreflightRequest } from './import-preflight';
import type {
  ProjectionEdge,
  ProjectionNode,
} from '../components/ade/dashboard/export/projectionEvidence';

/** How much of a source construct survives the canonical projection (REST `CoverageClass`). */
export type PreviewCoverageClass =
  | 'mapped'
  | 'partially-mapped'
  | 'unsupported-by-canonical-model'
  | 'not-parsed-by-adapter';

/** One canonical entity the import would create (REST `ImportPreviewEntity`). */
export interface ImportPreviewEntity {
  /** Stable key within the manifest (also the tree-row key). */
  key: string;
  /** Canonical display name. */
  name: string;
  /** What the entity is in the canonical model. */
  entity_kind: 'service' | 'operation' | 'type' | 'channel';
  /** Owning service's key on an operation; null on services, channels, and types. */
  parent_key?: string | null;
  /** 0-based index in the *full* entity tree (stable across pages). */
  order: number;
  description?: string | null;
  deprecated: boolean;
  /** This entity's coverage verdict from the ledger. */
  coverage: PreviewCoverageClass;
  /** The construct's name in the source document, when it differs from the canonical name. */
  native_name?: string | null;
  /** The construct's identifier in the source document, when the format has one. */
  native_id?: string | null;
  /** `"line:col"` in the raw source, or null when the parser reported none (never fabricated). */
  source_location?: string | null;
  /** Source facets the canonical model does not carry; non-empty iff `partially-mapped`. */
  unmodeled_extras: string[];
}

/** CLX-2.4 capability-registry reference (REST `CapabilityReference`). */
export interface ImportCapabilityReference {
  /** Format key the capability entry describes. */
  format: string;
  /** `native` | `adapted` | `unsupported`. */
  mode: string;
  /** Whether the registry says this format is importable at all. */
  importable: boolean;
  /** Tracking issues for the gap, when the registry names any. */
  related_issues: string[];
  /** Registry prose about the capability, when present. */
  notes?: string | null;
}

/** One coverage-ledger row (REST `CoverageEntry`). */
export interface ImportPreviewCoverageEntry {
  /** The source construct the row describes (a path or a named facet). */
  source_construct: string;
  coverage: PreviewCoverageClass;
  /** CPDO projection status (`retained`, `approximated`, `dropped`, …). */
  status: string;
  /** CPDO projection reason, when the status calls for one. */
  reason?: string | null;
  /** Human-readable explanation of the verdict. */
  detail: string;
  /** The manifest entity the row belongs to, when it is entity-scoped. */
  entity_key?: string | null;
  /** True for document-scoped facts; false for adapter-level declared parser limits. */
  document_scoped: boolean;
  /** Capability-registry reference; always present on `not-parsed-by-adapter`. */
  capability_reference?: ImportCapabilityReference | null;
}

/** Which adapter produced the manifest, and what it is known (not) to parse. */
export interface ImportPreviewAdapter {
  adapter_key: string;
  adapter_label: string;
  paradigm: string;
  formats: string[];
  capability: ImportCapabilityReference;
  /** Known parser limits, surfaced so "not parsed" rows have a stated cause. */
  parser_limits: string[];
}

/** One page of the preview manifest (REST `ImportPreviewManifest`). */
export interface ImportPreviewManifest {
  /** Byte-stable hash of the *full* manifest per (input, adapter version, options). */
  manifest_hash: string;
  adapter: ImportPreviewAdapter;
  /** Full-manifest entity counts (not this page's). */
  counts: PreflightCounts;
  /** Full-manifest tallies, zero-filled per class. */
  coverage_counts: Record<string, number>;
  status_counts: Record<string, number>;
  reason_counts: Record<string, number>;
  /** This page of the flat entity tree, in tree order. */
  entities: ImportPreviewEntity[];
  /** Entity count of the full tree. */
  total_entities: number;
  /** CPDO-1.3 projection graph slice for this page — the shared node/edge vocabulary the
   *  export surfaces use (`projectionEvidence.ts`), rendered by the IXH-3.3 projection map. */
  nodes: ProjectionNode[];
  edges: ProjectionEdge[];
  /** This page's coverage-ledger rows. */
  coverage: ImportPreviewCoverageEntry[];
  total_coverage_entries: number;
  /** The applied (clamped) page size. */
  page_size: number;
  /** Opaque cursor for the next page, or null on the last page. */
  next_cursor?: string | null;
  /** True whenever this response omits part of the full manifest. */
  truncated: boolean;
}

/** The candidate to preview: the pre-flight request plus pagination. */
export interface ImportPreviewManifestRequest extends PreflightRequest {
  cursor?: string | null;
  page_size?: number;
}

/** The manifest verdict for one candidate (REST `ImportPreviewManifestResponse`). */
export interface ImportPreviewManifestResponse {
  /** Mirrors `preflight.ok`; `manifest` is null exactly when false. */
  ok: boolean;
  preflight: PreflightReport;
  manifest: ImportPreviewManifest | null;
}

/** Page size the panel requests — the server maximum, so big specs need few round trips. */
export const PREVIEW_PAGE_SIZE = 1000;

/**
 * Fetch one page of the preview manifest for a candidate.
 *
 * @param request The candidate payload plus optional `cursor` / `page_size`.
 * @param signal Optional abort signal so leaving the step cancels an in-flight request.
 * @returns The parsed response. `ok: false` resolves normally — it is a *verdict*, not a failure.
 * @throws Error when the proxy/transport failed (non-2xx, `success: false`, or unparseable body).
 */
export async function fetchImportPreviewManifest(
  request: ImportPreviewManifestRequest,
  signal?: AbortSignal,
): Promise<ImportPreviewManifestResponse> {
  const res = await fetch('/api/import/preview-manifest', {
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
        : 'Could not build the import preview for this source.',
    );
  }
  if (typeof data?.ok !== 'boolean' || !data?.preflight) {
    throw new Error('The import preview manifest was incomplete.');
  }
  return data as unknown as ImportPreviewManifestResponse;
}

/**
 * Merge the next manifest page into the pages accumulated so far.
 *
 * List fields append; identity fields stay from the base (they describe the full manifest, so they
 * are equal by construction); `page_size`, `next_cursor`, and `truncated` come from the new page,
 * which knows whether anything remains.
 *
 * @returns The merged manifest — or `next` alone when its `manifest_hash` differs from the base's
 *   (the server's cached manifest rolled between requests; the pages describe different manifests
 *   and must not be mixed, so accumulation restarts from the new page).
 */
export function mergeManifestPages(
  base: ImportPreviewManifest,
  next: ImportPreviewManifest,
): ImportPreviewManifest {
  if (next.manifest_hash !== base.manifest_hash) return next;
  return {
    ...base,
    entities: [...base.entities, ...next.entities],
    nodes: [...base.nodes, ...next.nodes],
    edges: [...base.edges, ...next.edges],
    coverage: [...base.coverage, ...next.coverage],
    total_entities: next.total_entities,
    total_coverage_entries: next.total_coverage_entries,
    page_size: next.page_size,
    next_cursor: next.next_cursor ?? null,
    truncated: next.truncated,
  };
}

/**
 * Parse a manifest `source_location` (`"line:col"`, or a bare `"line"`) into numbers.
 *
 * @returns 1-based line and column, or `null` when the string is absent, malformed, or non-positive
 *   — a bad location degrades to "no link" rather than to a wrong line.
 */
export function parseSourceLocation(
  location: string | null | undefined,
): { line: number; column: number } | null {
  if (!location) return null;
  const match = /^(\d+)(?::(\d+))?$/.exec(location.trim());
  if (!match) return null;
  const line = Number(match[1]);
  const column = match[2] !== undefined ? Number(match[2]) : 1;
  if (!Number.isInteger(line) || line <= 0 || !Number.isInteger(column) || column <= 0) return null;
  return { line, column };
}

/** The coverage classes in ledger-severity order, for the legend and stable iteration. */
export const PREVIEW_COVERAGE_CLASSES: readonly PreviewCoverageClass[] = [
  'mapped',
  'partially-mapped',
  'unsupported-by-canonical-model',
  'not-parsed-by-adapter',
] as const;

/**
 * Badge label per coverage class. Each class keeps a distinct wording; in particular the two
 * "did not make it" classes are never conflated: one names the canonical model as the limit, the
 * other names the adapter.
 */
export const PREVIEW_COVERAGE_LABEL: Record<PreviewCoverageClass, string> = {
  mapped: 'Mapped',
  'partially-mapped': 'Partially mapped',
  'unsupported-by-canonical-model': 'Not in canonical model',
  'not-parsed-by-adapter': 'Not parsed by adapter',
};

/**
 * Badge tone classes per coverage class. Full Tailwind literals (never concatenated) so the classes
 * survive purging; four distinct hues so the classes are told apart at a glance.
 */
export const PREVIEW_COVERAGE_TONE: Record<PreviewCoverageClass, string> = {
  mapped: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'partially-mapped': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  'unsupported-by-canonical-model':
    'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  'not-parsed-by-adapter': 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};

/**
 * Project an entity kind onto the parsed-model tag vocabulary, so the tree's kind chips reuse
 * `parsedTagToneClass` from `CatalogParsedModel` (SERVICE / OPERATION / CHANNEL are mapped there;
 * TYPE takes its slate fallback).
 */
export function entityKindTag(kind: ImportPreviewEntity['entity_kind']): string {
  return kind.toUpperCase();
}

/**
 * Whether an entity matches a filter query — case-insensitive substring on the canonical name, the
 * native name, the entity kind, and the manifest key (the parsed-model filter's semantics, extended
 * to the manifest's provenance fields).
 */
export function previewEntityMatchesFilter(entity: ImportPreviewEntity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entity.name.toLowerCase().includes(q) ||
    (entity.native_name ?? '').toLowerCase().includes(q) ||
    entity.entity_kind.toLowerCase().includes(q) ||
    entity.key.toLowerCase().includes(q)
  );
}

/** Synthetic section-row keys — stable, so expansion state survives page loads and filtering. */
export const PREVIEW_SECTION_KEYS = {
  services: 'section:services',
  channels: 'section:channels',
  types: 'section:types',
} as const;

/** One row of the flattened, expansion-aware tree the windowed `role="tree"` renders. */
export interface PreviewTreeRow {
  /** Section key (`section:*`) or the entity's manifest key. */
  key: string;
  kind: 'section' | 'entity';
  /** The manifest entity, null on section rows. */
  entity: ImportPreviewEntity | null;
  /** Display label (section title or entity name). */
  label: string;
  /** Full-manifest count badge on section rows; null on entity rows. */
  count: number | null;
  /** 1-based tree depth → `aria-level`. */
  depth: number;
  /** Whether the row has loaded children (drives the chevron and `aria-expanded`). */
  hasChildren: boolean;
  expanded: boolean;
  /** Sibling-count → `aria-setsize`. */
  setSize: number;
  /** 1-based position among siblings → `aria-posinset`. */
  posInSet: number;
}

/** Sections expanded, services collapsed — the 10k-safe first paint. */
export function defaultExpandedKeys(): Set<string> {
  return new Set<string>(Object.values(PREVIEW_SECTION_KEYS));
}

interface SectionSpec {
  key: string;
  label: string;
  count: number | null;
  /** Depth-2 children in tree order; operations hang off services at depth 3. */
  children: ImportPreviewEntity[];
}

/**
 * Flatten the manifest's entity list into the visible tree rows.
 *
 * The tree has three synthetic depth-1 sections — **Services**, **Channels**, **Types** — with
 * full-manifest counts. Services parent their operations (`parent_key`) at depth 3. An operation
 * whose service is not in `entities` (possible mid-truncation) is kept as a direct child of the
 * Services section rather than dropped. A section renders when it has loaded children *or* a
 * non-zero full-manifest count (so truncation cannot silently hide a whole kind).
 *
 * Expansion: a row's children render only when its key is in `expandedKeys` — except while `filter`
 * is non-empty, when the tree force-expands and keeps exactly the matching entities plus their
 * ancestors, so every match is visible.
 *
 * @param entities The loaded (accumulated) manifest entities, in manifest tree order.
 * @param counts Full-manifest entity counts, for the section badges.
 * @param expandedKeys Keys of currently expanded rows (see {@link defaultExpandedKeys}).
 * @param filter The filter query ('' for none).
 * @returns The rows to render, top to bottom, with ARIA level/setsize/posinset precomputed.
 */
export function buildPreviewTreeRows(
  entities: ImportPreviewEntity[],
  counts: PreflightCounts | undefined,
  expandedKeys: ReadonlySet<string>,
  filter: string,
): PreviewTreeRow[] {
  const filtering = filter.trim() !== '';
  const serviceKeys = new Set(
    entities.filter((e) => e.entity_kind === 'service').map((e) => e.key),
  );

  const services: ImportPreviewEntity[] = [];
  const operationsByService = new Map<string, ImportPreviewEntity[]>();
  const orphanOperations: ImportPreviewEntity[] = [];
  const channels: ImportPreviewEntity[] = [];
  const types: ImportPreviewEntity[] = [];
  for (const entity of entities) {
    switch (entity.entity_kind) {
      case 'service':
        services.push(entity);
        break;
      case 'operation':
        if (entity.parent_key && serviceKeys.has(entity.parent_key)) {
          const list = operationsByService.get(entity.parent_key) ?? [];
          list.push(entity);
          operationsByService.set(entity.parent_key, list);
        } else {
          orphanOperations.push(entity);
        }
        break;
      case 'channel':
        channels.push(entity);
        break;
      default:
        types.push(entity);
        break;
    }
  }

  const matches = (entity: ImportPreviewEntity) =>
    !filtering || previewEntityMatchesFilter(entity, filter);

  const sections: SectionSpec[] = [
    {
      key: PREVIEW_SECTION_KEYS.services,
      label: 'Services',
      count: counts?.services ?? null,
      children: [...services, ...orphanOperations],
    },
    {
      key: PREVIEW_SECTION_KEYS.channels,
      label: 'Channels',
      count: counts?.channels ?? null,
      children: channels,
    },
    { key: PREVIEW_SECTION_KEYS.types, label: 'Types', count: counts?.types ?? null, children: types },
  ].filter((section) => section.children.length > 0 || (section.count ?? 0) > 0);

  const rows: PreviewTreeRow[] = [];
  const isExpanded = (key: string) => filtering || expandedKeys.has(key);

  // A section survives filtering when any descendant matches; a service survives when it or any of
  // its operations matches (ancestors of a match always stay visible).
  const visibleSections = sections
    .map((section) => {
      if (!filtering) return section;
      const children = section.children.filter((child) => {
        if (child.entity_kind === 'service') {
          return matches(child) || (operationsByService.get(child.key) ?? []).some(matches);
        }
        return matches(child);
      });
      return { ...section, children };
    })
    .filter((section) => (filtering ? section.children.length > 0 : true));

  visibleSections.forEach((section, sectionIndex) => {
    const hasChildren = section.children.length > 0;
    const expanded = hasChildren && isExpanded(section.key);
    rows.push({
      key: section.key,
      kind: 'section',
      entity: null,
      label: section.label,
      count: section.count,
      depth: 1,
      hasChildren,
      expanded,
      setSize: visibleSections.length,
      posInSet: sectionIndex + 1,
    });
    if (!expanded) return;

    section.children.forEach((child, childIndex) => {
      const operations =
        child.entity_kind === 'service'
          ? (operationsByService.get(child.key) ?? []).filter(matches)
          : [];
      const childHasChildren = operations.length > 0;
      const childExpanded = childHasChildren && isExpanded(child.key);
      rows.push({
        key: child.key,
        kind: 'entity',
        entity: child,
        label: child.name,
        count: null,
        depth: 2,
        hasChildren: childHasChildren,
        expanded: childExpanded,
        setSize: section.children.length,
        posInSet: childIndex + 1,
      });
      if (!childExpanded) return;
      operations.forEach((operation, operationIndex) => {
        rows.push({
          key: operation.key,
          kind: 'entity',
          entity: operation,
          label: operation.name,
          count: null,
          depth: 3,
          hasChildren: false,
          expanded: false,
          setSize: operations.length,
          posInSet: operationIndex + 1,
        });
      });
    });
  });

  return rows;
}

/**
 * Find the next row whose label starts with the type-ahead buffer, ARIA-tree style: the search
 * starts *after* `fromIndex`, wraps around, and is case-insensitive.
 *
 * @returns The matching row index, or `null` when the buffer is empty or nothing matches.
 */
export function findTypeaheadIndex(
  rows: PreviewTreeRow[],
  fromIndex: number,
  buffer: string,
): number | null {
  const needle = buffer.trim().toLowerCase();
  if (!needle || rows.length === 0) return null;
  for (let step = 1; step <= rows.length; step++) {
    const index = (((fromIndex + step) % rows.length) + rows.length) % rows.length;
    if (rows[index].label.toLowerCase().startsWith(needle)) return index;
  }
  return null;
}

/**
 * Index the entity-scoped coverage-ledger rows by entity key, for the selected row's provenance
 * strip. First row wins per key. Best-effort while pages are still loading — an entity's own
 * `coverage` badge never depends on this (it rides on the entity row itself).
 */
export function coverageDetailByEntityKey(
  entries: ImportPreviewCoverageEntry[],
): Map<string, ImportPreviewCoverageEntry> {
  const byKey = new Map<string, ImportPreviewCoverageEntry>();
  for (const entry of entries) {
    if (entry.entity_key && !byKey.has(entry.entity_key)) byKey.set(entry.entity_key, entry);
  }
  return byKey;
}
