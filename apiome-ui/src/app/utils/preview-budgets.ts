/**
 * Import preview budgets — the one place every preview-surface bound is defined and
 * documented (IXH-3.6, #5108).
 *
 * The preview step renders user-supplied data of unbounded size: a 6 MB OpenAPI document,
 * a 3000-type registry snapshot, a re-import that touches every operation. Every surface
 * therefore has an explicit budget, and every budget lives HERE — components import these
 * constants rather than declaring their own, so the documented registry
 * ({@link PREVIEW_BUDGETS}) and the enforced values cannot drift apart (a unit test walks
 * the registry against the exports).
 *
 * Two distinct mechanisms keep surfaces bounded, and the registry names which applies:
 *
 *  - **Windowing** (virtualization): the full data is client-side; only the rows near the
 *    viewport are mounted (`computeWindowedRange`, `windowed-rows.ts`). Nothing is hidden —
 *    scrolling reaches everything — so no truncation statement is required, but the surface
 *    shows a "windowed" note so the behavior is discoverable.
 *  - **Truncation**: part of the data is genuinely not present (later manifest pages, graph
 *    entries beyond the draw budget). Truncation is ALWAYS stated in the UI, never silent,
 *    and the statement names the path to the complete data.
 *
 * Manual keyboard walkthrough script and the full budget table:
 * `apiome-ui/docs/IMPORT_PREVIEW_BUDGETS_AND_A11Y.md`.
 */

import { BUNDLE_PAGE_SIZE } from './import-bundle-inventory';
import { PREVIEW_PAGE_SIZE } from './import-preview-manifest';
import { GRAPH_AGGREGATION_THRESHOLD } from '../components/ade/dashboard/export/projectionGraph';
import { CONVERSION_PROJECTION_PAGE_LIMIT } from './conversion-projection';
import { PROJECTION_PAGES_PER_WINDOW } from '../components/ade/dashboard/catalog/useConversionProjection';

// Re-exported so budget consumers (and the registry test) reach every bound through this
// module, while the constants stay owned by their contract modules.
export { BUNDLE_PAGE_SIZE } from './import-bundle-inventory';
export { PREVIEW_PAGE_SIZE } from './import-preview-manifest';
export { GRAPH_AGGREGATION_THRESHOLD } from '../components/ade/dashboard/export/projectionGraph';
export { CONVERSION_PROJECTION_PAGE_LIMIT } from './conversion-projection';
export { PROJECTION_PAGES_PER_WINDOW } from '../components/ade/dashboard/catalog/useConversionProjection';

/** Entity-tree rows (IXH-3.2 explorer) beyond this count are windowed, not all mounted. */
export const TREE_VIRTUALIZE_ABOVE = 50;

/** Ranked lint findings (IXH-2.2 list) beyond this count are windowed, not all mounted. */
export const FINDINGS_VIRTUALIZE_ABOVE = 50;

/**
 * Bundle file-tree rows (IXH-3.5 explorer) beyond this count are windowed, not all mounted. Its
 * own budget rather than a share of {@link TREE_VIRTUALIZE_ABOVE}: the bundle tree opens with every
 * directory expanded (a bundle is useless with its files hidden), so its row count is the file
 * count from the first paint — a different worst case from the entity explorer's.
 */
export const BUNDLE_TREE_VIRTUALIZE_ABOVE = 50;

/**
 * Unresolved import/include references listed at once (IXH-3.5). Above it the list states
 * "showing X of Y unresolved references"; the server caps its own page at the same idea, so a
 * bundle with thousands of broken references still states the real total.
 */
export const BUNDLE_UNRESOLVED_LIST_LIMIT = 50;

/**
 * Export artifact-explorer tree rows (IXH-4.1) beyond this count are windowed, not all
 * mounted — the export twin of {@link TREE_VIRTUALIZE_ABOVE}, kept as its own budget so
 * the two surfaces can diverge without a silent coupling.
 */
export const EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE = 50;

/**
 * Catalog **Format details** native-analysis tree rows (CPDO-2.1) beyond this count are
 * windowed, not all mounted. Its own budget rather than a share of
 * {@link TREE_VIRTUALIZE_ABOVE}: this tree is the analyzer's native structure bounded
 * server-side at 5000 nodes / 32 levels (CPDO-1.1), so its worst case is a different
 * shape from the canonical entity explorer's.
 */
export const ANALYSIS_TREE_VIRTUALIZE_ABOVE = 50;

/**
 * Export preview-manifest pages one "Load more entities" click walks before pausing —
 * the export twin of {@link LOAD_ALL_PAGE_CAP} (the same 1000-entity server pages).
 */
export const EXPORT_MANIFEST_PAGES_PER_WINDOW = 5;

/**
 * Projection-map SVG draw budget (IXH-3.3, shared with the export mapping graph IXH-4.2):
 * at most this many view entries are drawn as graph nodes. Entries are selected
 * worst-first (severity, then how lossy the status is), so dropped and critical evidence
 * is never what the cap removes. Above the budget the graph states "drawing X of Y
 * constructs" and points at the table below, which always lists every construct
 * (windowed).
 */
export const GRAPH_DRAW_BUDGET = 120;

/**
 * Projection evidence-table display rows (entries plus expanded aggregate members) beyond
 * this count are windowed with `aria-rowcount`/`aria-rowindex` kept correct. Shared by the
 * import projection map (IXH-3.3) and the export mapping graph (IXH-4.2).
 */
export const PROJECTION_TABLE_VIRTUALIZE_ABOVE = 60;

/** Re-import delta entries in one family disclosure beyond this count are windowed. */
export const DELTA_LIST_VIRTUALIZE_ABOVE = 50;

/**
 * Manifest pages one "Load all entities" click walks before pausing — with
 * {@link PREVIEW_PAGE_SIZE} that is 20k entities per click. The truncation banner stays up
 * (with the loaded-of-total counts) whenever a cursor remains, so pausing is never silent.
 */
export const LOAD_ALL_PAGE_CAP = 20;

/**
 * Raw-source lines mounted around a linked location (the payload-size bound of the raw
 * viewer). The clipped head/tail are stated as "… N earlier/later lines"; any line is
 * reachable because the window re-centers on every linked location
 * (`computeCenteredLineRange`).
 */
export const RAW_VIEWER_CONTEXT = 400;

/**
 * Schema Test Bench payload ceiling in UTF-8 bytes (IXH-5.3). Above it the bench refuses to
 * validate in the browser and says so — the payload editor plus per-value pointer anchoring
 * do not scale to megabyte payloads, and the REST endpoint (reachable via copy-as-curl)
 * handles any size the import resource guards allow.
 */
export const TEST_BENCH_PAYLOAD_MAX_BYTES = 1_000_000;

/** Test Bench validation findings beyond this count are windowed, not all mounted. */
export const TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE = 50;

/**
 * Findings requested per Test Bench validation (the IXH-5.1 `max_findings` request bound).
 * The response's `total_findings`/`truncated` state the real total whenever the cap trips.
 */
export const TEST_BENCH_MAX_FINDINGS = 200;

/** One documented preview-surface budget. */
export interface PreviewBudget {
  /** Stable id, also the key the registry test uses to match the exported constant. */
  id: string;
  /** The surface the budget bounds. */
  surface: string;
  /** The numeric bound. */
  budget: number;
  /** What the number counts. */
  unit: string;
  /** `windowed` — everything stays reachable by scrolling; `truncated` — the UI must state
   *  what is missing and where the complete data lives. */
  mechanism: 'windowed' | 'truncated';
  /** The user-visible behavior above the budget. */
  aboveBudget: string;
  /** The documented path to the complete data. */
  fullDataPath: string;
}

/**
 * The registry: every preview surface, its budget, and its path to the complete data.
 * Rendering components import the constants; this table is the human/CI-facing contract
 * ("documented budgets exist for every preview surface", IXH-3.6 AC 1).
 */
export const PREVIEW_BUDGETS: readonly PreviewBudget[] = [
  {
    id: 'TREE_VIRTUALIZE_ABOVE',
    surface: 'Entity explorer tree (IXH-3.2)',
    budget: TREE_VIRTUALIZE_ABOVE,
    unit: 'visible tree rows',
    mechanism: 'windowed',
    aboveBudget: 'Rows are windowed around the viewport; the focused row is pinned so it never unmounts.',
    fullDataPath: 'Scroll the tree — every loaded row is reachable; the list itself is complete.',
  },
  {
    id: 'PREVIEW_PAGE_SIZE',
    surface: 'Preview-manifest payload (IXH-3.1 pages)',
    budget: PREVIEW_PAGE_SIZE,
    unit: 'entities per request',
    mechanism: 'truncated',
    aboveBudget: 'The truncation banner states "showing X of Y entities — this preview is truncated."',
    fullDataPath: 'The banner’s "Load all entities" button walks the cursor pages.',
  },
  {
    id: 'LOAD_ALL_PAGE_CAP',
    surface: '"Load all entities" page walk (IXH-3.2)',
    budget: LOAD_ALL_PAGE_CAP,
    unit: 'pages per click',
    mechanism: 'truncated',
    aboveBudget: 'The walk pauses; the banner stays up with the loaded-of-total counts.',
    fullDataPath: 'Click "Load more entities" again to walk the next pages.',
  },
  {
    id: 'BUNDLE_TREE_VIRTUALIZE_ABOVE',
    surface: 'Bundle file tree (IXH-3.5 archive explorer)',
    budget: BUNDLE_TREE_VIRTUALIZE_ABOVE,
    unit: 'visible tree rows',
    mechanism: 'windowed',
    aboveBudget:
      'Rows are windowed around the viewport ("windowed" note shown); the focused row is pinned so it never unmounts.',
    fullDataPath: 'Scroll the tree — every loaded file is reachable; the header states the bundle’s full file count.',
  },
  {
    id: 'BUNDLE_PAGE_SIZE',
    surface: 'Bundle inventory payload (IXH-3.5 pages)',
    budget: BUNDLE_PAGE_SIZE,
    unit: 'files per request',
    mechanism: 'truncated',
    aboveBudget: 'The truncation banner states "showing X of Y files — this inventory is truncated."',
    fullDataPath: 'The banner’s "Load all files" button walks the cursor pages.',
  },
  {
    id: 'BUNDLE_UNRESOLVED_LIST_LIMIT',
    surface: 'Unresolved imports list (IXH-3.5)',
    budget: BUNDLE_UNRESOLVED_LIST_LIMIT,
    unit: 'unresolved references shown',
    mechanism: 'truncated',
    aboveBudget: 'The list states "showing X of Y unresolved references".',
    fullDataPath: 'Filter the file tree by the importing file, or read the full list from the REST endpoint.',
  },
  {
    id: 'EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE',
    surface: 'Export artifact-explorer tree (IXH-4.1)',
    budget: EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE,
    unit: 'visible tree rows',
    mechanism: 'windowed',
    aboveBudget: 'Rows are windowed around the viewport; the focused row is pinned so it never unmounts.',
    fullDataPath: 'Scroll the tree — every loaded row is reachable; the list itself is complete.',
  },
  {
    id: 'ANALYSIS_TREE_VIRTUALIZE_ABOVE',
    surface: 'Catalog Format details native-analysis tree (CPDO-2.1)',
    budget: ANALYSIS_TREE_VIRTUALIZE_ABOVE,
    unit: 'visible tree rows',
    mechanism: 'windowed',
    aboveBudget:
      'Rows are windowed around the viewport ("windowed" note shown); the focused row is pinned so it never unmounts.',
    fullDataPath:
      'Scroll the tree — every node of the stored analysis is reachable. Nodes the analyzer’s own 5000-node budget dropped are stated separately by the record’s bounding note.',
  },
  {
    id: 'EXPORT_MANIFEST_PAGES_PER_WINDOW',
    surface: 'Export preview-manifest page walk (IXH-4.1)',
    budget: EXPORT_MANIFEST_PAGES_PER_WINDOW,
    unit: 'pages per load',
    mechanism: 'truncated',
    aboveBudget: 'The walk pauses; the truncation banner states the loaded-of-total entity counts.',
    fullDataPath: 'Click "Load more entities" again to walk the next pages.',
  },
  {
    id: 'FINDINGS_VIRTUALIZE_ABOVE',
    surface: 'Ranked lint findings list (IXH-2.2)',
    budget: FINDINGS_VIRTUALIZE_ABOVE,
    unit: 'finding rows',
    mechanism: 'windowed',
    aboveBudget: 'Rows are windowed ("windowed" note shown); the selected row is pinned for focus.',
    fullDataPath: 'Scroll the list — every finding of the report is reachable.',
  },
  {
    id: 'GRAPH_AGGREGATION_THRESHOLD',
    surface: 'Projection-map clean rows (IXH-3.3 / IXH-4.2, shared with EFP-2.2)',
    budget: GRAPH_AGGREGATION_THRESHOLD,
    unit: 'evidence rows',
    mechanism: 'truncated',
    aboveBudget: 'Clean info rows collapse into per-family aggregates; a note states the rule. Dropped and non-info evidence never aggregates.',
    fullDataPath: 'Expand the aggregate row in the evidence table to list every member in place.',
  },
  {
    id: 'GRAPH_DRAW_BUDGET',
    surface: 'Projection-map SVG (IXH-3.3 import + IXH-4.2 export mapping graph nodes)',
    budget: GRAPH_DRAW_BUDGET,
    unit: 'drawn graph entries',
    mechanism: 'truncated',
    aboveBudget: 'The graph draws the worst entries first and states "drawing X of Y constructs".',
    fullDataPath: 'The evidence table below the graph always lists every construct.',
  },
  {
    id: 'PROJECTION_TABLE_VIRTUALIZE_ABOVE',
    surface: 'Projection evidence table (IXH-3.3 / IXH-4.2 text alternative)',
    budget: PROJECTION_TABLE_VIRTUALIZE_ABOVE,
    unit: 'display rows (entries + expanded members)',
    mechanism: 'windowed',
    aboveBudget: 'Rows are windowed; aria-rowcount/aria-rowindex keep the table semantics correct and the focused row is pinned.',
    fullDataPath: 'Scroll the table — every evidence row is reachable.',
  },
  {
    id: 'DELTA_LIST_VIRTUALIZE_ABOVE',
    surface: 'Re-import delta family lists (IXH-3.4)',
    budget: DELTA_LIST_VIRTUALIZE_ABOVE,
    unit: 'delta entries per family',
    mechanism: 'windowed',
    aboveBudget: 'The family’s list is windowed ("windowed" note shown); the focused row is pinned.',
    fullDataPath: 'Scroll the family list — every change is reachable; the header chips state the full counts.',
  },
  {
    id: 'RAW_VIEWER_CONTEXT',
    surface: 'Raw source viewer (IXH-2.2/3.2 locator)',
    budget: RAW_VIEWER_CONTEXT,
    unit: 'source lines mounted',
    mechanism: 'truncated',
    aboveBudget: 'The viewer states "… N earlier lines" / "… N later lines" around the mounted window.',
    fullDataPath: 'Follow any source link — the window re-centers on the linked line, so every line is reachable.',
  },
  {
    id: 'CONVERSION_PROJECTION_PAGE_LIMIT',
    surface: 'Catalog conversion projection graph pages (CPDO-1.3 / CPDO-4.2)',
    budget: CONVERSION_PROJECTION_PAGE_LIMIT,
    unit: 'evidence edges per request',
    mechanism: 'truncated',
    aboveBudget:
      'The walk fetches further cursor pages; when a window pauses, the panel states the loaded-of-total edge counts.',
    fullDataPath: 'Click "Load more evidence" to walk the next pages of the same snapshot.',
  },
  {
    id: 'PROJECTION_PAGES_PER_WINDOW',
    surface: 'Catalog conversion projection page walk (CPDO-1.3 / CPDO-4.2)',
    budget: PROJECTION_PAGES_PER_WINDOW,
    unit: 'pages per load',
    mechanism: 'truncated',
    aboveBudget:
      'The walk pauses after one window; the panel states the loaded-of-total edge counts, so pausing is never silent.',
    fullDataPath: 'Click "Load more evidence" again to walk the next window.',
  },
  {
    id: 'TEST_BENCH_PAYLOAD_MAX_BYTES',
    surface: 'Schema Test Bench payload editor (IXH-5.3)',
    budget: TEST_BENCH_PAYLOAD_MAX_BYTES,
    unit: 'UTF-8 bytes',
    mechanism: 'truncated',
    aboveBudget: 'The bench refuses to validate and states the payload size against the bound.',
    fullDataPath: 'Copy as curl — the REST validate endpoint handles any size the import guards allow.',
  },
  {
    id: 'TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE',
    surface: 'Schema Test Bench findings list (IXH-5.3)',
    budget: TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE,
    unit: 'finding rows',
    mechanism: 'windowed',
    aboveBudget: 'Rows are windowed ("windowed" note shown); every finding stays reachable by scrolling.',
    fullDataPath: 'Scroll the list — every returned finding is reachable.',
  },
  {
    id: 'TEST_BENCH_MAX_FINDINGS',
    surface: 'Schema Test Bench validation request (IXH-5.3 → IXH-5.1 max_findings)',
    budget: TEST_BENCH_MAX_FINDINGS,
    unit: 'findings per validation',
    mechanism: 'truncated',
    aboveBudget: 'The findings list states "showing X of Y findings — the report was truncated."',
    fullDataPath: 'Copy as curl and raise max_findings on the REST call.',
  },
] as const;
