/**
 * Export preview manifest model — IXH-4.1 (#5109).
 *
 * TypeScript mirror of `apiome-rest`'s `export_preview_manifest.py` wire models plus the
 * pure helpers behind the structural artifact explorer:
 *
 * - {@link mergeManifestEntityPages} accumulates cursor pages into one entity list;
 * - {@link buildExportManifestRows} flattens the entity list into the windowed
 *   `role="tree"` rows (sections → services/channels/types → operations/fields), with
 *   ARIA level/setsize/posinset precomputed and filter-aware force-expansion — the same
 *   projection shape the import explorer uses (`import-preview-manifest.ts`);
 * - {@link entityAtLine} resolves a clicked editor line back to the innermost located
 *   entity of that bundle file (the code → entity direction of the two-way selection);
 * - {@link decorationsForEntity} builds the selected entity's whole-line Monaco
 *   decoration (the entity → code direction), pure and type-only over `monaco-editor`
 *   so it unit-tests without a DOM (the `exportProblemMarkers.ts` convention).
 *
 * Everything here is pure — no React, no runtime Monaco import.
 */

import type { editor } from 'monaco-editor';
import { normalizeBundlePath } from './exportBundle';

/** The shared CPDO-1.3 projection statuses an entity row can carry. */
export type ExportEntityStatus =
  | 'retained'
  | 'transformed'
  | 'approximated'
  | 'synthesized'
  | 'dropped'
  | 'unavailable'
  | 'not-applicable';

/** The shared CPDO-1.3 reason codes for a non-preserved status. */
export type ExportEntityReason =
  | 'destination_unsupported'
  | 'emitter_unsupported'
  | 'source_incomplete'
  | 'source_parse_limit'
  | 'option_excluded'
  | 'security_redacted'
  | 'target_tool_unavailable'
  | 'not_applicable';

/** Where one entity lands in the emitted bundle (mirror of `ArtifactEntityLocation`). */
export interface ExportEntityLocation {
  /** Bundle-relative path of the emitted file (the download manifest's path). */
  file: string;
  /** 1-based line of the declaration in the file's serialized text, when resolvable. */
  line: number | null;
  /** RFC 6901 JSON Pointer into the emitted document, when derivable. */
  pointer: string | null;
}

/** One canonical entity row of the manifest (mirror of `ExportPreviewEntity`). */
export interface ExportManifestEntity {
  key: string;
  name: string;
  entity_kind: 'service' | 'operation' | 'channel' | 'type' | 'field';
  parent_key: string | null;
  /** Stable 0-based index in the full tree (pages interleave without re-sorting). */
  order: number;
  description: string | null;
  deprecated: boolean;
  status: ExportEntityStatus;
  reason: ExportEntityReason | null;
  severity: 'info' | 'warn' | 'critical';
  detail: string;
  target_mapping: string | null;
  /** True when the artifact carries this entity. */
  emitted: boolean;
  location: ExportEntityLocation | null;
  /** True when the status was aggregated from child constructs (service rows). */
  aggregated: boolean;
  /** False when the fidelity report was silent and the status is the retained default. */
  reported: boolean;
  native_name: string | null;
  native_id: string | null;
  source_location: string | null;
}

/** One emitted file of the bundle (mirror of `ExportManifestFile`). */
export interface ExportManifestFileInfo {
  path: string;
  media_type: string | null;
  line_count: number;
  entity_count: number;
}

/** The target + version provenance block (the fields the explorer surfaces). */
export interface ExportManifestTargetInfo {
  key: string;
  format: string;
  label: string;
  emitter_version: string;
  apiome_version: string;
  registry_version: string;
}

/** One page of the manifest (mirror of `ExportPreviewManifest`). */
export interface ExportPreviewManifestPage {
  manifest_hash: string;
  target: ExportManifestTargetInfo;
  /** Full-manifest entity count per status, zero-filled. */
  status_counts: Record<string, number>;
  /** Full-manifest entity count per reason, zero-filled. */
  reason_counts: Record<string, number>;
  entities: ExportManifestEntity[];
  total_entities: number;
  dropped_entities: number;
  files: ExportManifestFileInfo[];
  page_size: number;
  next_cursor: string | null;
  truncated: boolean;
}

/** The endpoint's response (mirror of `ExportPreviewManifestResponse`). */
export interface ExportPreviewManifestResponse {
  artifact: string;
  version: string | null;
  version_record_id: string;
  version_label: string | null;
  manifest: ExportPreviewManifestPage;
}

/** A one-shot "reveal this entity in the code viewer" request; nonce re-triggers repeats. */
export interface EntityRevealRequest {
  entity: ExportManifestEntity;
  nonce: number;
}

/** Entities requested per page — the server's maximum, matching the import manifest. */
export const EXPORT_MANIFEST_PAGE_SIZE = 1000;

/**
 * Accumulate cursor pages into one entity list, deduplicated by key (a re-walked page
 * never doubles rows) and kept in stable full-tree order via each row's `order`.
 */
export function mergeManifestEntityPages(
  pages: ExportManifestEntity[][],
): ExportManifestEntity[] {
  const byKey = new Map<string, ExportManifestEntity>();
  for (const page of pages) {
    for (const entity of page) {
      if (!byKey.has(entity.key)) byKey.set(entity.key, entity);
    }
  }
  return [...byKey.values()].sort((a, b) => a.order - b.order);
}

/** A location's bundle path, normalized to correlate with client zip paths. */
export function normalizedLocationFile(entity: ExportManifestEntity): string | null {
  if (!entity.location) return null;
  return normalizeBundlePath(entity.location.file) || entity.location.file;
}

/**
 * Whether an entity matches a filter query — case-insensitive substring over the name,
 * canonical key, entity kind, status, and reason (so "dropped" filters to losses).
 */
export function exportEntityMatchesFilter(entity: ExportManifestEntity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entity.name.toLowerCase().includes(q) ||
    entity.key.toLowerCase().includes(q) ||
    entity.entity_kind.toLowerCase().includes(q) ||
    entity.status.toLowerCase().includes(q) ||
    (entity.reason ?? '').toLowerCase().includes(q)
  );
}

/** Synthetic section-row keys — stable, so expansion survives page loads and filtering. */
export const EXPORT_MANIFEST_SECTION_KEYS = {
  services: 'section:services',
  channels: 'section:channels',
  types: 'section:types',
} as const;

/** One row of the flattened, expansion-aware tree the windowed `role="tree"` renders. */
export interface ExportManifestTreeRow {
  /** Section key (`section:*`) or the entity's canonical key. */
  key: string;
  kind: 'section' | 'entity';
  /** The manifest entity, null on section rows. */
  entity: ExportManifestEntity | null;
  /** Display label (section title or entity name). */
  label: string;
  /** Full-manifest count badge on section rows; null on entity rows. */
  count: number | null;
  /** 1-based tree depth → `aria-level`. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Sibling count → `aria-setsize`. */
  setSize: number;
  /** 1-based position among siblings → `aria-posinset`. */
  posInSet: number;
}

/** Sections expanded, services/types collapsed — the large-manifest-safe first paint. */
export function defaultExportExpandedKeys(): Set<string> {
  return new Set<string>(Object.values(EXPORT_MANIFEST_SECTION_KEYS));
}

interface SectionSpec {
  key: string;
  label: string;
  count: number | null;
  children: ExportManifestEntity[];
}

/**
 * Flatten the manifest's entity list into the visible tree rows.
 *
 * Three synthetic depth-1 sections — **Services**, **Channels**, **Types** — hold the
 * root entities; operations hang off their service and fields off their type at depth 3.
 * An orphan child (its parent not loaded mid-truncation) stays a direct section child
 * rather than being dropped. While `filter` is non-empty the tree force-expands and keeps
 * exactly the matching entities plus their ancestors (a parent also survives when a child
 * matches), so every match is visible.
 *
 * @param entities The loaded (accumulated) manifest entities, in manifest tree order.
 * @param entityCounts Full-manifest per-kind entity counts for the section badges
 *   (services / channels / types), or null while unknown.
 * @param expandedKeys Keys of currently expanded rows (see {@link defaultExportExpandedKeys}).
 * @param filter The filter query ('' for none).
 * @returns The rows to render, top to bottom, with ARIA metadata precomputed.
 */
export function buildExportManifestRows(
  entities: ExportManifestEntity[],
  entityCounts: { services: number; channels: number; types: number } | null,
  expandedKeys: ReadonlySet<string>,
  filter: string,
): ExportManifestTreeRow[] {
  const filtering = filter.trim() !== '';

  const services: ExportManifestEntity[] = [];
  const channels: ExportManifestEntity[] = [];
  const types: ExportManifestEntity[] = [];
  const childrenByParent = new Map<string, ExportManifestEntity[]>();
  const orphans: { operation: ExportManifestEntity[]; field: ExportManifestEntity[] } = {
    operation: [],
    field: [],
  };
  const rootKeys = new Set(
    entities
      .filter((e) => e.entity_kind === 'service' || e.entity_kind === 'type')
      .map((e) => e.key),
  );

  for (const entity of entities) {
    switch (entity.entity_kind) {
      case 'service':
        services.push(entity);
        break;
      case 'channel':
        channels.push(entity);
        break;
      case 'type':
        types.push(entity);
        break;
      case 'operation':
      case 'field': {
        if (entity.parent_key && rootKeys.has(entity.parent_key)) {
          const list = childrenByParent.get(entity.parent_key) ?? [];
          list.push(entity);
          childrenByParent.set(entity.parent_key, list);
        } else {
          orphans[entity.entity_kind].push(entity);
        }
        break;
      }
    }
  }

  const matches = (entity: ExportManifestEntity) =>
    !filtering || exportEntityMatchesFilter(entity, filter);
  const childMatches = (parent: ExportManifestEntity) =>
    (childrenByParent.get(parent.key) ?? []).some(matches);

  const sections: SectionSpec[] = [
    {
      key: EXPORT_MANIFEST_SECTION_KEYS.services,
      label: 'Services',
      count: entityCounts?.services ?? null,
      children: [...services, ...orphans.operation],
    },
    {
      key: EXPORT_MANIFEST_SECTION_KEYS.channels,
      label: 'Channels',
      count: entityCounts?.channels ?? null,
      children: channels,
    },
    {
      key: EXPORT_MANIFEST_SECTION_KEYS.types,
      label: 'Types',
      count: entityCounts?.types ?? null,
      children: [...types, ...orphans.field],
    },
  ].filter((section) => section.children.length > 0 || (section.count ?? 0) > 0);

  const isExpanded = (key: string) => filtering || expandedKeys.has(key);

  const visibleSections = sections
    .map((section) => {
      if (!filtering) return section;
      const children = section.children.filter(
        (child) => matches(child) || childMatches(child),
      );
      return { ...section, children };
    })
    .filter((section) => (filtering ? section.children.length > 0 : true));

  const rows: ExportManifestTreeRow[] = [];
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
      const nested = (childrenByParent.get(child.key) ?? []).filter(matches);
      const childHasChildren = nested.length > 0;
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
      nested.forEach((leaf, leafIndex) => {
        rows.push({
          key: leaf.key,
          kind: 'entity',
          entity: leaf,
          label: leaf.name,
          count: null,
          depth: 3,
          hasChildren: false,
          expanded: false,
          setSize: nested.length,
          posInSet: leafIndex + 1,
        });
      });
    });
  });

  return rows;
}

/**
 * Find the next row whose label starts with the type-ahead buffer, ARIA-tree style:
 * search starts *after* `fromIndex`, wraps around, case-insensitive.
 */
export function findExportTypeaheadIndex(
  rows: ExportManifestTreeRow[],
  fromIndex: number,
  buffer: string,
): number | null {
  const needle = buffer.trim().toLowerCase();
  if (!needle || rows.length === 0) return null;
  for (let step = 1; step <= rows.length; step += 1) {
    const index = (((fromIndex + step) % rows.length) + rows.length) % rows.length;
    if (rows[index].label.toLowerCase().startsWith(needle)) return index;
  }
  return null;
}

/** Depth rank for {@link entityAtLine}: a field/operation declaration beats its parent. */
const KIND_INNERMOST_RANK: Record<ExportManifestEntity['entity_kind'], number> = {
  field: 0,
  operation: 1,
  type: 2,
  channel: 3,
  service: 4,
};

/**
 * Resolve a clicked editor line back to the **innermost located entity** of one bundle
 * file (the code → entity direction). The manifest carries declaration *start* lines, so
 * the innermost entity is the one declared closest at-or-above the clicked line; among
 * entities on the same line, the deeper kind wins (a field over its type, an operation
 * over its service).
 *
 * @param entities The manifest entities (any order).
 * @param file The active bundle file path (client-normalized).
 * @param line The clicked 1-based line.
 * @returns The entity, or null when nothing in this file is declared at or above `line`.
 */
export function entityAtLine(
  entities: ExportManifestEntity[],
  file: string,
  line: number,
): ExportManifestEntity | null {
  const normalizedFile = normalizeBundlePath(file) || file;
  let best: ExportManifestEntity | null = null;
  for (const entity of entities) {
    if (!entity.location || entity.location.line == null) continue;
    if (normalizedLocationFile(entity) !== normalizedFile) continue;
    if (entity.location.line > line) continue;
    if (
      best === null ||
      entity.location.line > (best.location?.line ?? 0) ||
      (entity.location.line === best.location?.line &&
        KIND_INNERMOST_RANK[entity.entity_kind] < KIND_INNERMOST_RANK[best.entity_kind])
    ) {
      best = entity;
    }
  }
  return best;
}

/** The selected entity's whole-line highlight class (styled in `globals.css`). */
export const ENTITY_LINE_CLASS = 'manifest-entity-line--selected';

/**
 * Build the selected entity's Monaco decoration: a whole-line highlight on its
 * declaration line, clamped to the document. An entity without a resolvable line (or in
 * another file — the caller passes only the active file's selection) decorates nothing.
 *
 * @param entity The selected entity, or null for none.
 * @param text The active file's text (for clamping).
 * @returns Zero or one `IModelDeltaDecoration`.
 */
export function decorationsForEntity(
  entity: ExportManifestEntity | null,
  text: string,
): editor.IModelDeltaDecoration[] {
  if (!entity?.location || entity.location.line == null) return [];
  const lineCount = Math.max(1, text.split('\n').length);
  const line = Math.min(Math.max(1, entity.location.line), lineCount);
  return [
    {
      range: {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: 1,
      },
      options: {
        isWholeLine: true,
        className: ENTITY_LINE_CLASS,
        stickiness: 1, // NeverGrowsWhenTypingAtEdges — read-only viewer, value irrelevant but explicit
      },
    },
  ];
}

/** Kind badge text for a tree row (SERVICE / OPERATION / …). */
export function exportEntityKindTag(kind: ExportManifestEntity['entity_kind']): string {
  return kind.toUpperCase();
}

/** Per-kind full-manifest counts derived from loaded entities (section badges fallback). */
export function countEntitiesByKind(
  entities: ExportManifestEntity[],
): { services: number; channels: number; types: number } {
  let services = 0;
  let channels = 0;
  let types = 0;
  for (const entity of entities) {
    if (entity.entity_kind === 'service') services += 1;
    else if (entity.entity_kind === 'channel') channels += 1;
    else if (entity.entity_kind === 'type') types += 1;
  }
  return { services, channels, types };
}
