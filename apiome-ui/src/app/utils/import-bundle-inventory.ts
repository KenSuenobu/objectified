/**
 * Import bundle inventory client contract and file-tree projection (IXH-3.5, #5107).
 *
 * When the candidate is a **bundle** — an uploaded `.zip`/`.tar.gz`, or a git selection packed as
 * one (MFI-29.1/29.2/29.3) — a single grade and a single entity tree cannot say which of the thirty
 * files failed, which were never read, which import could not be resolved, or that the entry point
 * detection picked is the wrong one. `POST /api/import/bundle-inventory` (the same-origin proxy for
 * the REST endpoint of the same name) answers that, file by file.
 *
 * Everything the bundle panel needs that is not DOM — the response shape, the fetch, the directory
 * tree the windowed ARIA tree renders, page merging, and the role/verdict presentation maps — lives
 * here so each rule is unit-testable on its own.
 *
 * Invariants the callers depend on:
 *
 *  1. **A payload that is not a bundle is not an error.** `kind: 'single-document'` resolves
 *     normally with `inventory: null`; the panel simply does not render. `ok: false` happens only
 *     when an archive could not be unpacked, and then `error` carries the intake-taxonomy code.
 *  2. **An ambiguous entry point and a failed parse still carry the complete file list.** That is
 *     exactly the bundle the panel exists for, so neither collapses the response.
 *  3. **Attribution is evidence, not provenance.** `inventory.attribution` names the method the
 *     server used (`declaration-scan`); the panel states it rather than implying the parser recorded
 *     which file produced each entity.
 *  4. **The file list is cursor-paginated.** Totals (`total_files`, `total_unresolved`,
 *     `role_counts`) always describe the *whole* bundle; `files` carries one page, and `unresolved`
 *     rides the first page only. {@link mergeBundlePages} accumulates pages client-side.
 */

import type { PreflightRequest } from './import-preflight';

/** What a file *is* within the bundle (REST `BundleFileRole`). */
export type BundleFileRole =
  | 'entry-point'
  | 'dependency'
  | 'unreferenced'
  | 'ignored'
  | 'unreadable';

/** What happened to a file when the bundle was analysed (REST `BundleFileVerdict`). */
export type BundleFileVerdict = 'analysed' | 'failed' | 'not-analysed';

/** How one import/include reference resolved (REST `ImportResolution`). */
export type BundleImportResolution = 'member' | 'provided' | 'unresolved';

/** One import/include reference a bundle file declares (REST `BundleImportEdge`). */
export interface BundleImportEdge {
  from_path: string;
  /** The directive as the format names it (`import`, `include`, `$ref`, `schemaLocation`, …). */
  directive: string;
  /** The reference exactly as the source document wrote it. */
  target: string;
  /** The member it resolved to, or null. */
  to_path?: string | null;
  resolution: BundleImportResolution;
  /** What supplies a `provided` reference (e.g. the protobuf well-known types). */
  provider?: string | null;
  /** Every bundle-relative path tried, in order — the answer to "where did you look?". */
  search_paths: string[];
  /** 1-based line of the directive within its file. */
  line: number;
}

/** One file the bundle contained (REST `BundleFileEntry`). */
export interface BundleFileEntry {
  path: string;
  role: BundleFileRole;
  verdict: BundleFileVerdict;
  bytes: number;
  lines: number;
  /** Why an ignored file was excluded; always set when `role` is `ignored`. */
  ignored_reason?: string | null;
  /** The parse diagnostic naming this file, or why an unreadable file could not be read. */
  error?: string | null;
  imports: BundleImportEdge[];
  imported_by: string[];
  /** Canonical entity keys attributed to this file (capped server-side). */
  entity_keys: string[];
  /** Exact number of canonical entities attributed to this file. */
  entity_count: number;
}

/** One member that could serve as the bundle's entry point (REST `BundleRootCandidate`). */
export interface BundleRootCandidate {
  path: string;
  format?: string | null;
  confidence: number;
  selected: boolean;
}

/** One page of the bundle inventory (REST `ImportBundleInventory`). */
export interface ImportBundleInventory {
  entry_point?: string | null;
  /** True when the request named the entry point; false when it was auto-detected. */
  entry_point_pinned: boolean;
  /** Why root resolution failed — the file list is still complete. */
  entry_point_error?: string | null;
  entry_point_candidates: BundleRootCandidate[];
  /** How per-file entity contribution was derived (`declaration-scan`). */
  attribution: string;
  /** This page of the file list, in path order. */
  files: BundleFileEntry[];
  total_files: number;
  role_counts: Record<string, number>;
  verdict_counts: Record<string, number>;
  /** Unresolved references, first page only, capped server-side. */
  unresolved: BundleImportEdge[];
  total_unresolved: number;
  total_edges: number;
  total_entities: number;
  unattributed_entities: number;
  page_size: number;
  next_cursor?: string | null;
  truncated: boolean;
}

/** The candidate to inventory: the pre-flight request plus pagination. */
export interface ImportBundleInventoryRequest extends PreflightRequest {
  cursor?: string | null;
  page_size?: number;
}

/** Stable intake-taxonomy error (REST `SpecImportJobError`). */
export interface BundleInventoryError {
  code: string;
  category: string;
  message: string;
  remediation: string;
  retriable: boolean;
}

/** The inventory verdict for one candidate (REST `ImportBundleInventoryResponse`). */
export interface ImportBundleInventoryResponse {
  /** False only when the archive could not be unpacked. */
  ok: boolean;
  /** `archive` for a bundle payload, `single-document` otherwise. */
  kind: string;
  inventory?: ImportBundleInventory | null;
  error?: BundleInventoryError | null;
}

/** Page size the panel requests — the server maximum, so big bundles need few round trips. */
export const BUNDLE_PAGE_SIZE = 1000;

/**
 * Fetch one page of the bundle inventory for a candidate.
 *
 * @param request The candidate payload plus optional `cursor` / `page_size`.
 * @param signal Optional abort signal so leaving the step cancels an in-flight request.
 * @returns The parsed response. `ok: false` and `kind: 'single-document'` both resolve normally —
 *   they are *verdicts*, not failures.
 * @throws Error when the proxy/transport failed (non-2xx, `success: false`, or unparseable body).
 */
export async function fetchImportBundleInventory(
  request: ImportBundleInventoryRequest,
  signal?: AbortSignal,
): Promise<ImportBundleInventoryResponse> {
  const res = await fetch('/api/import/bundle-inventory', {
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
        : 'Could not inventory the files in this bundle.',
    );
  }
  if (typeof data?.ok !== 'boolean' || typeof data?.kind !== 'string') {
    throw new Error('The bundle inventory response was incomplete.');
  }
  return data as unknown as ImportBundleInventoryResponse;
}

/**
 * Merge the next inventory page into the pages accumulated so far.
 *
 * `files` appends; the whole-bundle totals and the entry-point facts stay from the base (they
 * describe the full inventory, so they are equal by construction); `unresolved` is first-page-only
 * server-side, so a later page never overwrites what the first page carried.
 *
 * @returns The merged inventory.
 */
export function mergeBundlePages(
  base: ImportBundleInventory,
  next: ImportBundleInventory,
): ImportBundleInventory {
  return {
    ...base,
    files: [...base.files, ...next.files],
    total_files: next.total_files,
    page_size: next.page_size,
    next_cursor: next.next_cursor ?? null,
    truncated: next.truncated,
  };
}

/** The roles in inventory order, for the legend and stable iteration. */
export const BUNDLE_ROLES: readonly BundleFileRole[] = [
  'entry-point',
  'dependency',
  'unreferenced',
  'ignored',
  'unreadable',
] as const;

/** Badge label per role. Each role keeps its own wording; none is a synonym of another. */
export const BUNDLE_ROLE_LABEL: Record<BundleFileRole, string> = {
  'entry-point': 'Entry point',
  dependency: 'Imported dependency',
  unreferenced: 'Unreferenced',
  ignored: 'Ignored',
  unreadable: 'Unreadable',
};

/**
 * What each role *means*, shown as the row's title and in the legend. `unreferenced` says the
 * honest thing: nothing points at it, which is a fact worth knowing but not, by itself, a fault.
 */
export const BUNDLE_ROLE_HINT: Record<BundleFileRole, string> = {
  'entry-point': 'The root document the import parses from.',
  dependency: 'Reached from the entry point through a resolved import or include.',
  unreferenced:
    'Nothing in the bundle points at this file. Some importers still read every file of their format, so it may still contribute.',
  ignored: 'Excluded before it became a member of the bundle.',
  unreadable: 'Not readable as text, so it was not analysed.',
};

/**
 * Badge tone per role. Full Tailwind literals (never concatenated) so the classes survive purging;
 * distinct hues so roles are told apart at a glance.
 */
export const BUNDLE_ROLE_TONE: Record<BundleFileRole, string> = {
  'entry-point': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  dependency: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  unreferenced: 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300',
  ignored: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  unreadable: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};

/** Verdict label per verdict. */
export const BUNDLE_VERDICT_LABEL: Record<BundleFileVerdict, string> = {
  analysed: 'Parsed',
  failed: 'Failed',
  'not-analysed': 'Not analysed',
};

/** Human wording for the server's stable ignore reasons. An unknown reason is shown verbatim. */
export const BUNDLE_IGNORED_REASON_LABEL: Record<string, string> = {
  'resource-fork': 'macOS resource fork (__MACOSX)',
  'vcs-metadata': 'Version-control metadata (.git)',
  'os-metadata': 'Operating-system metadata (.DS_Store / Thumbs.db)',
  'hidden-file': 'Hidden dotfile',
  'not-a-regular-file': 'Not a regular file (link, device, or directory entry)',
};

/** Resolve an ignore reason to its human wording, falling back to the raw reason. */
export function bundleIgnoredReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Excluded from the bundle';
  return BUNDLE_IGNORED_REASON_LABEL[reason] ?? reason;
}

/** Label per import resolution. */
export const BUNDLE_RESOLUTION_LABEL: Record<BundleImportResolution, string> = {
  member: 'Resolved',
  provided: 'Provided by the toolchain',
  unresolved: 'Unresolved',
};

/**
 * Whether a file matches a filter query — case-insensitive substring on the path, the role, the
 * verdict, and the ignore reason, so "unresolved"-style questions can be asked of the list directly.
 */
export function bundleFileMatchesFilter(entry: BundleFileEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.path.toLowerCase().includes(q) ||
    entry.role.toLowerCase().includes(q) ||
    entry.verdict.toLowerCase().includes(q) ||
    (entry.ignored_reason ?? '').toLowerCase().includes(q)
  );
}

/** Format a byte count for a file row (the panel never shows raw byte counts above 1 kB). */
export function formatBundleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One row of the flattened, expansion-aware directory tree the windowed `role="tree"` renders. */
export interface BundleTreeRow {
  /** `dir:<path>` on a directory row, the file's path on a file row. */
  key: string;
  kind: 'directory' | 'file';
  /** The file entry, null on directory rows. */
  file: BundleFileEntry | null;
  /** Display label — the directory or file *name*, not the whole path. */
  label: string;
  /** File count under a directory row; null on file rows. */
  count: number | null;
  /** 1-based tree depth → `aria-level`. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Sibling-count → `aria-setsize`. */
  setSize: number;
  /** 1-based position among siblings → `aria-posinset`. */
  posInSet: number;
}

/** Synthetic key for a directory row, so expansion state survives filtering and page loads. */
export function bundleDirectoryKey(path: string): string {
  return `dir:${path}`;
}

/**
 * The directory keys that must be expanded for `path` to be visible — its ancestors, root-first.
 * Used both for the default expansion and to reveal one file named elsewhere in the panel.
 */
export function bundleAncestorKeys(path: string): string[] {
  const segments = path.split('/');
  const keys: string[] = [];
  for (let depth = 1; depth < segments.length; depth++) {
    keys.push(bundleDirectoryKey(segments.slice(0, depth).join('/')));
  }
  return keys;
}

/**
 * Every directory key in the file list — the default expansion, so a bundle opens *showing its
 * files*. Nothing is hidden behind a click the user would have to discover; the tree is windowed
 * instead, which is the bound that actually keeps it fast.
 */
export function defaultBundleExpandedKeys(files: BundleFileEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    for (const key of bundleAncestorKeys(file.path)) keys.add(key);
  }
  return keys;
}

interface TreeNode {
  /** Directory path (`''` at the root). */
  path: string;
  name: string;
  directories: Map<string, TreeNode>;
  files: BundleFileEntry[];
  /** Files at or below this directory, for the count badge. */
  total: number;
}

function emptyNode(path: string, name: string): TreeNode {
  return { path, name, directories: new Map(), files: [], total: 0 };
}

/**
 * Flatten the bundle's file list into the visible directory-tree rows.
 *
 * Directories are synthetic rows derived from the paths (the server sends a flat, path-sorted list),
 * so the tree mirrors the archive's own layout. Directory rows carry the number of files at or below
 * them, which is what makes a truncated `vendor/` subtree legible at a glance.
 *
 * Expansion: a directory's children render only when its key is in `expandedKeys` — except while
 * `filter` is non-empty, when the tree force-expands and keeps exactly the matching files plus their
 * ancestor directories, so every match is visible.
 *
 * @param files The loaded (accumulated) inventory files, in path order.
 * @param expandedKeys Keys of currently expanded directory rows.
 * @param filter The filter query ('' for none).
 * @returns The rows to render, top to bottom, with ARIA level/setsize/posinset precomputed.
 */
export function buildBundleTreeRows(
  files: BundleFileEntry[],
  expandedKeys: ReadonlySet<string>,
  filter: string,
): BundleTreeRow[] {
  const filtering = filter.trim() !== '';
  const visible = filtering ? files.filter((file) => bundleFileMatchesFilter(file, filter)) : files;

  const root = emptyNode('', '');
  for (const file of visible) {
    const segments = file.path.split('/');
    let node = root;
    node.total += 1;
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const name = segments[depth];
      const path = segments.slice(0, depth + 1).join('/');
      let child = node.directories.get(name);
      if (!child) {
        child = emptyNode(path, name);
        node.directories.set(name, child);
      }
      child.total += 1;
      node = child;
    }
    node.files.push(file);
  }

  const rows: BundleTreeRow[] = [];
  const isExpanded = (key: string) => filtering || expandedKeys.has(key);

  const walk = (node: TreeNode, depth: number) => {
    const directories = [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name));
    const setSize = directories.length + node.files.length;
    directories.forEach((directory, index) => {
      const key = bundleDirectoryKey(directory.path);
      const expanded = isExpanded(key);
      rows.push({
        key,
        kind: 'directory',
        file: null,
        label: directory.name,
        count: directory.total,
        depth,
        hasChildren: true,
        expanded,
        setSize,
        posInSet: index + 1,
      });
      if (expanded) walk(directory, depth + 1);
    });
    node.files.forEach((file, index) => {
      rows.push({
        key: file.path,
        kind: 'file',
        file,
        label: file.path.split('/').pop() ?? file.path,
        count: null,
        depth,
        hasChildren: false,
        expanded: false,
        setSize,
        posInSet: directories.length + index + 1,
      });
    });
  };

  walk(root, 1);
  return rows;
}

/**
 * Index the inventory's files by path, for the detail strip and the unresolved list's back-links.
 * First entry wins per path (the server sends each path once; this only guards a malformed page).
 */
export function bundleFilesByPath(files: BundleFileEntry[]): Map<string, BundleFileEntry> {
  const byPath = new Map<string, BundleFileEntry>();
  for (const file of files) if (!byPath.has(file.path)) byPath.set(file.path, file);
  return byPath;
}
