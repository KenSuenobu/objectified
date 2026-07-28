/**
 * Revision-scoped payload-analysis contract and tree derivations (CPDO-2.1, #4797).
 *
 * `GET /api/catalog/{id}/analysis` returns the immutable record CPDO-1.1 (#4794) defined and
 * CPDO-1.2 (#4795) fills: the native structure of one imported source revision in the analyzer's
 * own vocabulary (X12 `interchange → functional_group → transaction_set → segment → element`;
 * copybook `record → group → field → condition`; generic `object / array / scalar / opaque`),
 * its source locations, its analyzer's warnings and capability declaration, and the redaction
 * metadata stating what was withheld. The catalog detail read embeds only the *summary*.
 *
 * This module mirrors those Python models field-for-field in the camelCase the API serializes, and
 * owns every derivation the **Format details** tab needs — so the panel is a renderer and the rules
 * below are unit-testable without a DOM:
 *
 * - {@link buildAnalysisTreeRows} — flatten the native tree into the visible rows, with
 *   `aria-level` / `aria-setsize` / `aria-posinset` precomputed and filter-driven force-expansion;
 * - {@link analysisStatusPresentation} — the five states the tab must render distinctly
 *   (available, partial, unavailable, failed, plus the analyzer-warning and redacted overlays);
 * - {@link nodeSourceLine} / {@link sourceLocationText} — what a node can point at, and the
 *   narrower question of whether it can point at a *line* the raw viewer can open;
 * - {@link nodeValueStatement} — the value sentence, which never guesses: a withheld value, an
 *   observed-empty value and an absent value are three different statements.
 *
 * **The rule this module exists to keep.** Nothing here invents structure. A record with no tree
 * yields no rows; a location with no line yields no source link (X12 locates by envelope path and
 * ordinal, so its nodes deliberately have nothing the line-addressed viewer can open); a node whose
 * value the policy withheld says *withheld*, never "empty". Absence is explained from CPDO-2.4's
 * registry (`formatCapabilityRegistry.ts`), which is the only place reviewed wording lives.
 */

/** Analysis statuses, in the order the contract documents them (mirrors `ANALYSIS_STATUSES`). */
export const ANALYSIS_STATUSES = ['available', 'partial', 'unavailable', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Warning severities, weakest first (mirrors `WARNING_SEVERITIES`). */
export const WARNING_SEVERITIES = ['info', 'warning', 'error'] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];

/** Value-visibility levels, most restrictive first (mirrors `ValueVisibility.ALL`). */
export const VALUE_VISIBILITIES = ['none', 'structural', 'full'] as const;
export type ValueVisibilityLevel = (typeof VALUE_VISIBILITIES)[number];

/** Where in the original source a node came from (mirrors Python `SourceLocation`). */
export interface AnalysisSourceLocation {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  offset?: number | null;
  length?: number | null;
  ordinal?: number | null;
  path?: string | null;
}

/** Something the analyzer could not do in *this* source (mirrors Python `AnalysisWarning`). */
export interface AnalysisWarning {
  code: string;
  severity: string;
  message: string;
  nodeId?: string | null;
  location?: AnalysisSourceLocation | null;
}

/** One node of the native tree, in the analyzer's own vocabulary (mirrors `AnalysisNode`). */
export interface AnalysisNode {
  id: string;
  kind: string;
  name?: string | null;
  label?: string | null;
  ordinal?: number | null;
  attributes?: Record<string, unknown>;
  location?: AnalysisSourceLocation | null;
  /** Whether the source carried a value here — present-and-empty is not the same as absent. */
  valuePresent?: boolean | null;
  valueLength?: number | null;
  /** The observed value; only under `full` visibility. */
  value?: string | null;
  /** True when a value was observed and withheld by policy. */
  redacted?: boolean;
  children?: AnalysisNode[];
}

/** Derived counts over the stored tree (mirrors Python `AnalysisMetrics`). */
export interface AnalysisMetrics {
  nodeCount: number;
  maxDepth: number;
  truncated: boolean;
  droppedNodeCount: number;
  kindCounts: Record<string, number>;
  warningCount: number;
}

/** What the record withheld, and under which policy (mirrors Python `RedactionInfo`). */
export interface AnalysisRedaction {
  valueVisibility: string;
  redactedNodeCount: number;
  policySource: string;
  valuePreviewLimit: number;
}

/** Which analyzer produced the record (mirrors Python `AnalyzerInfo`). */
export interface AnalysisAnalyzer {
  key: string;
  version: string;
  toolVersions: Record<string, string>;
}

/** What that analyzer models and knowingly does not (mirrors `AnalyzerCapabilities`). */
export interface AnalysisCapabilities {
  supported: string[];
  unsupported: string[];
  limits: Record<string, number>;
}

/** The analysis of one source revision (mirrors Python `PayloadAnalysisDocument`). */
export interface AnalysisDocument {
  schemaVersion: string;
  status: string;
  statusReason?: string | null;
  sourceFormat?: string | null;
  sourceHash?: string | null;
  analyzer: AnalysisAnalyzer;
  capabilities: AnalysisCapabilities;
  tree: AnalysisNode[];
  metrics: AnalysisMetrics;
  warnings: AnalysisWarning[];
  redaction: AnalysisRedaction;
}

/** A stored analysis plus the identity of its row (mirrors `PayloadAnalysisRecord`). */
export interface AnalysisRecord {
  analysisId?: string | null;
  tenantId?: string | null;
  projectId?: string | null;
  versionRecordId?: string | null;
  analysisSequence: number;
  contentFingerprint?: string | null;
  analyzedAt?: string | null;
  analysis: AnalysisDocument;
}

/**
 * The tree-free projection the catalog detail read embeds (mirrors `PayloadAnalysisSummary`).
 *
 * The tab decides from this whether a record is worth fetching, and can already explain an absence
 * without one — so a `unavailable` item never costs a second request.
 */
export interface AnalysisSummary {
  available: boolean;
  status: string;
  statusReason?: string | null;
  schemaVersion: string;
  sourceFormat?: string | null;
  analyzerKey?: string | null;
  analyzerVersion?: string | null;
  nodeCount: number;
  maxDepth: number;
  truncated: boolean;
  warningCount: number;
  kindCounts: Record<string, number>;
  capabilities: AnalysisCapabilities;
  valueVisibility: string;
  analysisId?: string | null;
  versionRecordId?: string | null;
  analyzedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Vocabulary presentation
// ---------------------------------------------------------------------------

/** How one analysis status must be presented. Text always carries the meaning. */
export interface AnalysisStatusPresentation {
  /** Short badge label. */
  label: string;
  /** One sentence stating what the status means for this item. */
  statement: string;
  /** Colour-independent tone; the label is never dropped in favour of it. */
  tone: 'positive' | 'caution' | 'neutral' | 'negative';
  /** Whether a native tree is fetchable at all under this status. */
  treeExpected: boolean;
}

/** Reviewed presentation per status. A status outside the vocabulary falls back to neutral. */
const STATUS_PRESENTATION: Record<AnalysisStatus, AnalysisStatusPresentation> = {
  available: {
    label: 'Available',
    statement: 'The analyzer described the whole captured source within its budget.',
    tone: 'positive',
    treeExpected: true,
  },
  partial: {
    label: 'Partial',
    statement:
      'The analyzer described part of the source and stated which parts it could not — what is here is real, and it is not everything.',
    tone: 'caution',
    treeExpected: true,
  },
  unavailable: {
    label: 'Unavailable',
    statement: 'Nothing was analysed for this revision, so there is no native structure to show.',
    tone: 'neutral',
    treeExpected: false,
  },
  failed: {
    label: 'Analyzer failed',
    statement: 'The analyzer ran and errored, so no native structure was recorded.',
    tone: 'negative',
    treeExpected: false,
  },
};

/** Return true when `status` is one of the four contract statuses. */
export function isKnownAnalysisStatus(status: string): status is AnalysisStatus {
  return (ANALYSIS_STATUSES as readonly string[]).includes(status);
}

/**
 * Resolve a stored status onto its reviewed presentation.
 *
 * @param status The record's `status`.
 * @returns The presentation. An unrecognised status resolves to a neutral entry that claims
 *   nothing — a status this build has never seen is not evidence about the source.
 */
export function analysisStatusPresentation(status: string): AnalysisStatusPresentation {
  if (isKnownAnalysisStatus(status)) return STATUS_PRESENTATION[status];
  return {
    label: 'Unrecognised status',
    statement:
      'This analysis reports a status this screen does not know, so nothing is claimed about it.',
    tone: 'neutral',
    treeExpected: false,
  };
}

/** Human label per value-visibility level; the level itself is shown when unrecognised. */
const VISIBILITY_STATEMENT: Record<ValueVisibilityLevel, string> = {
  none: 'No value material is carried — not even whether a value was there.',
  structural: 'Whether a value was present and how long it was; never what it said.',
  full: 'Observed values are carried, truncated to the record’s preview limit.',
};

/**
 * One sentence describing the value-visibility policy the record was stored under.
 *
 * @param visibility The record's `redaction.valueVisibility`.
 * @returns The reviewed sentence, or a neutral statement for a level this build does not know.
 */
export function valueVisibilityStatement(visibility: string): string {
  return (
    VISIBILITY_STATEMENT[visibility as ValueVisibilityLevel] ??
    `This record declares value visibility “${visibility}”, which this screen has no wording for.`
  );
}

/** Human labels for the node kinds the shipped analyzers emit. Unknown kinds render verbatim. */
const KIND_LABEL: Record<string, string> = {
  // X12 (edix12_analysis.py)
  interchange: 'Interchange',
  functional_group: 'Functional group',
  transaction_set: 'Transaction set',
  segment: 'Segment',
  element: 'Element',
  composite: 'Composite',
  component: 'Component',
  repetition: 'Repetition',
  // COBOL copybook (cobolcopybook_analysis.py)
  record: 'Record',
  group: 'Group',
  field: 'Field',
  condition: 'Condition',
  // Generic walk (payload_analyzer.py)
  object: 'Object',
  array: 'Array',
  scalar: 'Scalar',
  opaque: 'Opaque',
};

/**
 * Human label for a node kind.
 *
 * @param kind The analyzer's own term.
 * @returns The reviewed label, or `kind` itself so a format-specific analyzer that lands later is
 *   rendered rather than hidden.
 */
export function analysisKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** Severity rank for ordering warnings worst-first. Unknown severities sort last. */
const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/**
 * Sort warnings worst-first, stable within a severity.
 *
 * @param warnings The record's warnings. Not mutated.
 * @returns A new array, errors first.
 */
export function sortAnalysisWarnings(warnings: readonly AnalysisWarning[]): AnalysisWarning[] {
  return [...warnings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
  );
}

/**
 * Index warnings by the node they are about, so a tree row can carry its own warning badge.
 *
 * @param warnings The record's warnings.
 * @returns Node id → its warnings, worst-first. Warnings with no `nodeId` are not indexed (they are
 *   about the record, not a node, and the panel lists those separately).
 */
export function warningsByNode(
  warnings: readonly AnalysisWarning[],
): Map<string, AnalysisWarning[]> {
  const byNode = new Map<string, AnalysisWarning[]>();
  for (const warning of sortAnalysisWarnings(warnings)) {
    const id = warning.nodeId;
    if (!id) continue;
    const list = byNode.get(id) ?? [];
    list.push(warning);
    byNode.set(id, list);
  }
  return byNode;
}

// ---------------------------------------------------------------------------
// Source locations
// ---------------------------------------------------------------------------

/**
 * The 1-based source line a node points at, or null when it points at no line.
 *
 * Source-location quality differs by analyzer, and this is where that difference stops being
 * hidden: a copybook node knows its line, an X12 node knows only its envelope path and sibling
 * ordinal, and a generic node knows only a path. Only the first can open the line-addressed raw
 * viewer, so only the first is offered a "view source" link.
 *
 * @param location The node's location, if any.
 * @returns The line, or null when there is none (or it is not a positive integer).
 */
export function nodeSourceLine(location: AnalysisSourceLocation | null | undefined): number | null {
  const line = location?.line;
  if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) return null;
  return line;
}

/**
 * A compact human rendering of a source location, or null when it addresses nothing.
 *
 * @param location The node's location, if any.
 * @returns e.g. `claim.cpy:42`, `ISA/GS[0]/ST[2]/NM1[4]`, `#3`, or null.
 */
export function sourceLocationText(
  location: AnalysisSourceLocation | null | undefined,
): string | null {
  if (!location) return null;
  const parts: string[] = [];
  const line = nodeSourceLine(location);
  if (location.file) parts.push(line !== null ? `${location.file}:${line}` : location.file);
  else if (line !== null) parts.push(`line ${line}`);
  if (location.path) parts.push(location.path);
  if (parts.length === 0 && typeof location.ordinal === 'number') parts.push(`#${location.ordinal}`);
  if (parts.length === 0 && typeof location.offset === 'number') {
    parts.push(`byte ${location.offset}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Node facts
// ---------------------------------------------------------------------------

/** The value sentence for a node, plus whether it was withheld rather than absent. */
export interface NodeValueStatement {
  /** The sentence to render. Never guesses: withheld, empty and absent are distinct. */
  text: string;
  /** True when a value was observed and policy withheld it (drives the "redacted" badge). */
  withheld: boolean;
  /** The observed value, only when the record actually carries it. */
  value: string | null;
}

/**
 * State what a node says about its value.
 *
 * Four distinct facts, and the whole point is that they are not collapsed:
 *  - the record carries the value (`full` visibility) — it is shown;
 *  - a value was observed and withheld by policy — said so, with its length when known;
 *  - a value was observed to be *empty* — an empty X12 element is not an absent one;
 *  - nothing is recorded about a value — under `none` visibility that is the policy, not the source.
 *
 * @param node The tree node.
 * @param visibility The record's stored `redaction.valueVisibility`.
 * @returns The sentence, the withheld flag, and the value when it is present.
 */
export function nodeValueStatement(
  node: AnalysisNode,
  visibility: string,
): NodeValueStatement {
  if (typeof node.value === 'string') {
    return { text: `Value: ${node.value}`, withheld: false, value: node.value };
  }
  if (node.redacted) {
    const length = typeof node.valueLength === 'number' ? node.valueLength : null;
    return {
      text:
        length !== null
          ? `A value of ${length} character${length === 1 ? '' : 's'} was observed and withheld by the value-visibility policy.`
          : 'A value was observed and withheld by the value-visibility policy.',
      withheld: true,
      value: null,
    };
  }
  if (node.valuePresent === true) {
    const length = typeof node.valueLength === 'number' ? node.valueLength : null;
    return {
      text:
        length === 0
          ? 'A value was present in the source and it was empty.'
          : length !== null
            ? `A value of ${length} character${length === 1 ? '' : 's'} was present.`
            : 'A value was present.',
      withheld: false,
      value: null,
    };
  }
  if (node.valuePresent === false) {
    return { text: 'No value was present in the source here.', withheld: false, value: null };
  }
  if (visibility === 'none') {
    return {
      text: 'This record carries nothing about values — not even whether one was there.',
      withheld: false,
      value: null,
    };
  }
  return { text: 'No value was recorded for this node.', withheld: false, value: null };
}

/**
 * A node's format-specific attributes as sorted, renderable pairs.
 *
 * The attributes are where the format actually lives (`segmentId`, `picture`, `occursMin`, level
 * numbers), so they are rendered generically rather than per-format: one renderer walks any
 * analyzer's output, exactly as the contract intends.
 *
 * @param node The tree node.
 * @returns `[name, text]` pairs, key-sorted for determinism. Null/undefined values are dropped
 *   (an attribute the analyzer did not set is not a fact); objects/arrays are JSON-rendered.
 */
export function nodeAttributeEntries(node: AnalysisNode): Array<[string, string]> {
  const attributes = node.attributes ?? {};
  return Object.keys(attributes)
    .sort()
    .flatMap((name): Array<[string, string]> => {
      const value = attributes[name];
      if (value === null || value === undefined) return [];
      if (typeof value === 'string') return value.trim() === '' ? [] : [[name, value]];
      if (typeof value === 'number' || typeof value === 'boolean') return [[name, String(value)]];
      try {
        return [[name, JSON.stringify(value)]];
      } catch {
        // A value that cannot be serialized is dropped rather than rendered as "[object Object]".
        return [];
      }
    });
}

/**
 * The label a tree row shows for a node.
 *
 * @param node The tree node.
 * @returns `label` when the analyzer supplied one (it exists for exactly this reason — "Transaction
 *   set 837 (0001)" reads better than "837"), else `name`, else the node id.
 */
export function analysisNodeLabel(node: AnalysisNode): string {
  const label = node.label?.trim();
  if (label) return label;
  const name = node.name?.trim();
  if (name) return name;
  return node.id;
}

/**
 * Total nodes in a tree, counted rather than trusted.
 *
 * `metrics.nodeCount` describes the tree as *stored*; a read-time value-visibility restriction
 * cannot change it, but a caller holding a filtered or partially-hydrated tree needs the real count
 * of what it has.
 *
 * @param tree Root nodes.
 * @returns The node total.
 */
export function countAnalysisNodes(tree: readonly AnalysisNode[]): number {
  let total = 0;
  const stack: AnalysisNode[] = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    total += 1;
    if (node.children) stack.push(...node.children);
  }
  return total;
}

/**
 * Kind counts as sorted pairs for the metrics strip.
 *
 * @param kindCounts The record's `metrics.kindCounts`.
 * @returns `[kind, count]` pairs, highest count first, ties broken by kind name so the strip is
 *   stable across renders.
 */
export function kindCountEntries(
  kindCounts: Record<string, number> | null | undefined,
): Array<[string, number]> {
  return Object.entries(kindCounts ?? {})
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
// Tree rows
// ---------------------------------------------------------------------------

/** One visible row of the flattened native tree, with its ARIA facts precomputed. */
export interface AnalysisTreeRow {
  /** The node's stable record id — also the deep-link target and the React key. */
  id: string;
  node: AnalysisNode;
  /** 1-based tree depth → `aria-level`. */
  depth: number;
  /** Whether the node has children (drives the chevron and `aria-expanded`). */
  hasChildren: boolean;
  expanded: boolean;
  /** Sibling count → `aria-setsize`. */
  setSize: number;
  /** 1-based position among siblings → `aria-posinset`. */
  posInSet: number;
  /** Ancestor ids, root first — what a deep link must expand to reveal this row. */
  ancestorIds: string[];
}

/**
 * Whether a node matches a filter query.
 *
 * Matches the node's label, name, kind, human kind label, and its source-location text — the five
 * things a reader would type. Attribute *values* are deliberately not searched: under a `full`
 * visibility policy they can hold payload material, and a filter that silently searches payload
 * values is a disclosure surface.
 *
 * @param node The tree node.
 * @param filter The query; whitespace-only matches everything.
 * @returns True when the node matches.
 */
export function analysisNodeMatchesFilter(node: AnalysisNode, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    node.label ?? '',
    node.name ?? '',
    node.kind,
    analysisKindLabel(node.kind),
    sourceLocationText(node.location) ?? '',
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

/**
 * The ids expanded on first paint: every root plus their immediate children.
 *
 * Two levels is the honest default for every shipped analyzer — an X12 interchange shows its
 * functional groups, a copybook record shows its 01-level groups — while a 5000-node tree still
 * paints a handful of rows.
 *
 * @param tree Root nodes.
 * @returns The initially expanded ids.
 */
export function defaultExpandedAnalysisIds(tree: readonly AnalysisNode[]): Set<string> {
  const expanded = new Set<string>();
  for (const root of tree) {
    expanded.add(root.id);
    for (const child of root.children ?? []) {
      if ((child.children ?? []).length > 0) expanded.add(child.id);
    }
  }
  return expanded;
}

/**
 * Flatten the native tree into the rows to render, top to bottom.
 *
 * A node's children render only when its id is in `expandedIds` — except while `filter` is
 * non-empty, when the tree force-expands and keeps exactly the matching nodes plus their ancestors,
 * so every match is visible and no match is hidden behind a collapsed parent.
 *
 * A node whose children were dropped by the analyzer's node budget simply has none: the row is a
 * leaf, and the record's `metrics.truncated` is what states that bounding happened. Nothing here
 * invents a "more children" affordance the record cannot back.
 *
 * @param tree Root nodes, in source order.
 * @param expandedIds Ids of currently expanded nodes (see {@link defaultExpandedAnalysisIds}).
 * @param filter The filter query (`''` for none).
 * @returns The rows, with `aria-level` / `aria-setsize` / `aria-posinset` and ancestor ids ready.
 */
export function buildAnalysisTreeRows(
  tree: readonly AnalysisNode[],
  expandedIds: ReadonlySet<string>,
  filter: string,
): AnalysisTreeRow[] {
  const filtering = filter.trim() !== '';
  const rows: AnalysisTreeRow[] = [];

  /** True when `node` or any descendant matches the filter (so ancestors of a match survive). */
  const subtreeMatches = (node: AnalysisNode): boolean =>
    analysisNodeMatchesFilter(node, filter) ||
    (node.children ?? []).some((child) => subtreeMatches(child));

  const walk = (nodes: readonly AnalysisNode[], depth: number, ancestorIds: string[]) => {
    const visible = filtering ? nodes.filter((node) => subtreeMatches(node)) : [...nodes];
    visible.forEach((node, index) => {
      const children = node.children ?? [];
      const hasChildren = children.length > 0;
      // While filtering the tree force-expands, so a match is never behind a collapsed parent.
      const expanded = hasChildren && (filtering || expandedIds.has(node.id));
      rows.push({
        id: node.id,
        node,
        depth,
        hasChildren,
        expanded,
        setSize: visible.length,
        posInSet: index + 1,
        ancestorIds,
      });
      if (expanded) walk(children, depth + 1, [...ancestorIds, node.id]);
    });
  };

  walk(tree, 1, []);
  return rows;
}

/**
 * Find a node and the ancestors a deep link must expand to reveal it.
 *
 * @param tree Root nodes.
 * @param nodeId The target node id.
 * @returns `{ node, ancestorIds }`, or null when the tree has no such node — a deep link into a
 *   node that bounding dropped, or that a re-analysis renamed, resolves to nothing rather than to
 *   the wrong node.
 */
export function locateAnalysisNode(
  tree: readonly AnalysisNode[],
  nodeId: string,
): { node: AnalysisNode; ancestorIds: string[] } | null {
  const search = (
    nodes: readonly AnalysisNode[],
    ancestorIds: string[],
  ): { node: AnalysisNode; ancestorIds: string[] } | null => {
    for (const node of nodes) {
      if (node.id === nodeId) return { node, ancestorIds };
      const found = search(node.children ?? [], [...ancestorIds, node.id]);
      if (found) return found;
    }
    return null;
  };
  return nodeId ? search(tree, []) : null;
}

/**
 * The row whose label starts with `buffer`, wrapping — the tree's type-ahead.
 *
 * A single character moves to the *next* match, so repeating it walks the matches. A longer buffer
 * is a refinement of the search the reader is already in the middle of, so the current row is
 * eligible again — otherwise typing "fu" would land on the second construct beginning with "f"
 * rather than staying on the one the "f" already selected.
 *
 * @param rows The visible rows.
 * @param fromIndex Index the search starts at (skipped for a one-character buffer).
 * @param buffer The accumulated type-ahead characters.
 * @returns The matching index, or null when nothing matches.
 */
export function findAnalysisTypeaheadIndex(
  rows: readonly AnalysisTreeRow[],
  fromIndex: number,
  buffer: string,
): number | null {
  const needle = buffer.trim().toLowerCase();
  if (!needle || rows.length === 0) return null;
  const firstStep = needle.length > 1 ? 0 : 1;
  for (let step = firstStep; step <= rows.length; step++) {
    const index = (((fromIndex + step) % rows.length) + rows.length) % rows.length;
    if (analysisNodeLabel(rows[index].node).toLowerCase().startsWith(needle)) return index;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The outcome of one analysis fetch. Exactly one of `record` / `error` is set. */
export interface AnalysisFetchResult {
  /** The validated record, or null when the request did not yield one. */
  record: AnalysisRecord | null;
  /** A user-facing message when the request failed. */
  error: string | null;
  /** True when the failure was an authorization refusal, which is not an absence of analysis. */
  forbidden: boolean;
}

/**
 * Return true when `value` has the shape of an analysis record.
 *
 * Structural rather than exhaustive: the fields the panel dereferences before it can render
 * anything (`analysis.status`, an array `tree`). A payload missing them is refused rather than
 * rendered half-way, because a record whose status cannot be read cannot be explained honestly.
 */
export function isAnalysisRecord(value: unknown): value is AnalysisRecord {
  if (typeof value !== 'object' || value === null) return false;
  const analysis = (value as { analysis?: unknown }).analysis;
  if (typeof analysis !== 'object' || analysis === null) return false;
  const document = analysis as Partial<AnalysisDocument>;
  return typeof document.status === 'string' && Array.isArray(document.tree);
}

/** The proxy path serving one catalog item's native payload analysis. */
export function analysisHref(itemId: string): string {
  return `/api/catalog/${encodeURIComponent(itemId)}/analysis`;
}

/**
 * Fetch a catalog item's native payload analysis.
 *
 * The endpoint is gated on `imports:view` (the permission governing imported source material), so a
 * 403 is reported as its own outcome: "you may not read this" and "there is nothing to read" are
 * different facts, and conflating them would be exactly the dishonesty CPDO-2.4 removed from the
 * rest of the catalog.
 *
 * @param itemId The catalog item id.
 * @param signal Optional abort signal (the tab aborts in flight when it unmounts).
 * @returns The record, or an error message with the `forbidden` flag set for a 403.
 */
export async function fetchCatalogAnalysis(
  itemId: string,
  signal?: AbortSignal,
): Promise<AnalysisFetchResult> {
  const res = await fetch(analysisHref(itemId), { credentials: 'include', signal });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
        ? ((data as { error: string }).error)
        : '') || 'The native payload analysis could not be loaded.';
    return { record: null, error: message, forbidden: res.status === 403 };
  }
  const payload =
    typeof data === 'object' && data !== null && 'record' in data
      ? (data as { record: unknown }).record
      : data;
  if (!isAnalysisRecord(payload)) {
    return {
      record: null,
      error: 'The native payload analysis came back in a shape this screen cannot read.',
      forbidden: false,
    };
  }
  return { record: payload, error: null, forbidden: false };
}
