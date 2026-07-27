/**
 * Multi-file export bundle model (MFX-43.2, #4362).
 *
 * A multi-file target (MFX-4.2: per-package `.proto` + imports, WSDL+XSDs, per-subject `.avsc`,
 * Bruno folders) emits not one document but a *bundle* of files. The Review step can't show that as
 * one blob — it needs a file tree to navigate and per-file badges for where the verify findings land.
 * This module is the pure backbone of that UI:
 *
 * - the {@link BundleFile} / {@link BundleManifest} shapes the Studio captures from the emit (a lone
 *   document is just a one-file manifest, which the tree then skips — see {@link isMultiFileBundle});
 * - {@link buildBundleTree}, which folds the manifest's flat paths into a folder/file tree (folders
 *   first, alphabetical) so the left rail renders like an IDE explorer;
 * - {@link countFindingsByFile}, which buckets the Verify lenses' located findings (validation +
 *   lint, MFX-42.2/42.3) by the file they name, so every tree node and tab can badge its own count;
 * - {@link aggregateFolderCounts}, which rolls those per-file counts up to each folder.
 *
 * Everything here is pure (no React, no fetch, no zip parsing) so it can be unit-tested directly —
 * mirroring `./exportArtifactPreview.ts` and `./exportVerify.ts`. The client-side zip *reader* that
 * turns an emitted bundle archive into these files lives in `./zipBundle.ts`.
 */

import { utf8ByteLength } from './exportArtifactPreview';

/** One file within an emitted bundle. */
export interface BundleFile {
  /** The file's path within the bundle, e.g. `com/example/User.avsc` (POSIX separators). */
  path: string;
  /** The file's text content. Emitted bundle files are textual (proto/SDL/XSD/JSON/YAML). */
  text: string;
  /** The file's media type, when the archive or emitter records one; '' when unknown. */
  mediaType: string;
  /** The file's size in UTF-8 bytes (what the saved file weighs). */
  sizeBytes: number;
}

/** An emitted export as a bundle of one or more files, in emit order. */
export interface BundleManifest {
  /** The bundle's files, in the order they were emitted. Always at least one. */
  files: BundleFile[];
  /** The primary file's path — the first emitted file, opened by default and used for naming. */
  primaryPath: string;
}

/** The per-file inputs to {@link buildBundleManifest} (size is computed, not supplied). */
export interface BundleFileInput {
  path: string;
  text: string;
  mediaType?: string | null;
}

/**
 * Build a {@link BundleManifest} from the emitted files, computing each file's UTF-8 byte size and
 * taking the first file as the primary. Paths are normalized to POSIX separators and de-duplicated
 * (a later duplicate wins, mirroring an archive extract) so the tree never shows two nodes for one
 * path.
 *
 * @param files The emitted files, in emit order. Must be non-empty.
 * @returns The manifest with sizes filled in and the primary path resolved.
 * @throws Error When `files` is empty — an emit always produces at least one file.
 */
export function buildBundleManifest(files: BundleFileInput[]): BundleManifest {
  if (files.length === 0) {
    throw new Error('A bundle manifest needs at least one file.');
  }
  const byPath = new Map<string, BundleFile>();
  const order: string[] = [];
  for (const file of files) {
    const path = normalizeBundlePath(file.path);
    if (!byPath.has(path)) order.push(path);
    byPath.set(path, {
      path,
      text: file.text,
      mediaType: file.mediaType || '',
      sizeBytes: utf8ByteLength(file.text),
    });
  }
  const ordered = order.map((path) => byPath.get(path) as BundleFile);
  return { files: ordered, primaryPath: ordered[0].path };
}

/** Normalize a bundle path: backslashes → `/`, collapse leading `./` and slashes. */
export function normalizeBundlePath(path: string): string {
  return (path || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * Whether a manifest is a genuine multi-file bundle (more than one file). Single-file exports skip
 * the tree entirely (MFX-43.2 acceptance) — the caller shows the plain preview instead.
 *
 * @param manifest The emitted manifest.
 * @returns True when the bundle holds two or more files.
 */
export function isMultiFileBundle(manifest: BundleManifest): boolean {
  return manifest.files.length > 1;
}

/** The basename (last path segment) of a bundle path, e.g. `User.avsc` from `com/example/User.avsc`. */
export function bundleFileName(path: string): string {
  const norm = normalizeBundlePath(path);
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** A file node in the bundle tree — a leaf carrying its {@link BundleFile}. */
export interface BundleTreeFileNode {
  kind: 'file';
  /** The node's own name (the path's last segment). */
  name: string;
  /** The file's full bundle path (the node's stable key). */
  path: string;
  /** The file itself. */
  file: BundleFile;
}

/** A folder node in the bundle tree — an interior node grouping its children. */
export interface BundleTreeFolderNode {
  kind: 'folder';
  /** The folder's own name (the segment). */
  name: string;
  /** The folder's full path from the bundle root (the node's stable key). */
  path: string;
  /** The folder's children, folders first then files, each alphabetical. */
  children: BundleTreeNode[];
}

/** A node in the bundle tree — a folder or a file. */
export type BundleTreeNode = BundleTreeFolderNode | BundleTreeFileNode;

/**
 * Fold a bundle's flat file list into a folder/file tree. Each path segment before the basename
 * becomes a folder; files hang off their deepest folder. Siblings are ordered folders-first, then
 * files, each group alphabetical (case-insensitive) — the familiar IDE explorer order.
 *
 * @param files The bundle's files (any order).
 * @returns The tree's root-level nodes.
 */
export function buildBundleTree(files: BundleFile[]): BundleTreeNode[] {
  const root: BundleTreeFolderNode = { kind: 'folder', name: '', path: '', children: [] };

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1];
    const folders = segments.slice(0, -1);

    let cursor = root;
    let prefix = '';
    for (const folder of folders) {
      prefix = prefix ? `${prefix}/${folder}` : folder;
      let next = cursor.children.find(
        (child): child is BundleTreeFolderNode => child.kind === 'folder' && child.name === folder,
      );
      if (!next) {
        next = { kind: 'folder', name: folder, path: prefix, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    // A path that collides with an existing file (rare) simply overwrites nothing — the last write
    // to the manifest already won, and duplicate leaves are avoided by the manifest's de-dup.
    if (!cursor.children.some((child) => child.kind === 'file' && child.name === fileName)) {
      cursor.children.push({ kind: 'file', name: fileName, path: file.path, file });
    }
  }

  sortTree(root.children);
  return root.children;
}

/** Sort a node list (and recurse into folders): folders first, then files, each alphabetical. */
function sortTree(nodes: BundleTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const node of nodes) {
    if (node.kind === 'folder') sortTree(node.children);
  }
}

/** Per-file (or per-folder) finding tally: errors block-flavoured, warnings advisory. */
export interface FileFindingCounts {
  /** Error-severity findings located in this file (validation failures + `error` lint). */
  errors: number;
  /** Advisory findings located in this file (`warning`/`info` lint). */
  warnings: number;
}

/** The minimal located-finding shape {@link countFindingsByFile} reads from a validation finding. */
export interface LocatedValidationFinding {
  file?: string | null;
}

/** The minimal located-finding shape {@link countFindingsByFile} reads from a lint finding. */
export interface LocatedLintFinding {
  file?: string | null;
  severity?: 'error' | 'warning' | 'info';
}

/**
 * Bucket the Verify lenses' located findings by the bundle file they name, so each tree node and
 * tab can badge its own counts. Validation failures (MFX-42.2) are always error-flavoured; lint
 * findings (MFX-42.3) split by severity — `error` into errors, `warning`/`info` into warnings.
 * Findings with no `file` are location-less at the bundle level and are skipped here (they still
 * show in the lens list; MFX-43.3 handles in-file line markers).
 *
 * @param validationFindings The validation lens's findings.
 * @param lintFindings The lint lens's findings.
 * @returns A map from normalized bundle path to its error/warning tally (only files with findings).
 */
export function countFindingsByFile(
  validationFindings: LocatedValidationFinding[],
  lintFindings: LocatedLintFinding[],
): Map<string, FileFindingCounts> {
  const counts = new Map<string, FileFindingCounts>();
  const bump = (rawFile: string | null | undefined, key: 'errors' | 'warnings') => {
    if (!rawFile) return;
    const path = normalizeBundlePath(rawFile);
    if (!path) return;
    const current = counts.get(path) ?? { errors: 0, warnings: 0 };
    current[key] += 1;
    counts.set(path, current);
  };

  for (const finding of validationFindings) bump(finding.file, 'errors');
  for (const finding of lintFindings) {
    bump(finding.file, finding.severity === 'error' ? 'errors' : 'warnings');
  }
  return counts;
}

/**
 * Roll per-file finding counts up to a tree node: a file node's own counts, a folder node's the
 * sum across every descendant file. Used to badge folders with the total findings inside them.
 *
 * @param node The tree node to total.
 * @param countsByPath The per-file counts from {@link countFindingsByFile}.
 * @returns The node's aggregate errors/warnings (both zero when nothing inside it was flagged).
 */
export function aggregateFolderCounts(
  node: BundleTreeNode,
  countsByPath: Map<string, FileFindingCounts>,
): FileFindingCounts {
  if (node.kind === 'file') {
    return countsByPath.get(node.path) ?? { errors: 0, warnings: 0 };
  }
  return node.children.reduce<FileFindingCounts>(
    (acc, child) => {
      const child_counts = aggregateFolderCounts(child, countsByPath);
      return { errors: acc.errors + child_counts.errors, warnings: acc.warnings + child_counts.warnings };
    },
    { errors: 0, warnings: 0 },
  );
}

/** One rendered row of the bundle tree: a node plus everything ARIA needs to place it. */
export interface BundleTreeRow {
  /** The node this row draws. */
  node: BundleTreeNode;
  /** Nesting depth, 1-based — the row's `aria-level`. */
  depth: number;
  /** Whether the node has children (folders only). */
  hasChildren: boolean;
  /** Whether a folder row is expanded; `false` for files (which never expand). */
  expanded: boolean;
  /** How many siblings share this row's parent — the row's `aria-setsize`. */
  setSize: number;
  /** This row's 1-based position among its siblings — the row's `aria-posinset`. */
  posInSet: number;
  /** The parent folder's path, or null at the root — how ArrowLeft finds the parent row. */
  parentPath: string | null;
}

/**
 * Flatten the bundle tree into the visible rows a `role="tree"` renders (MFX-41.5).
 *
 * A tree widget needs one flat, ordered row list to run a roving tabindex over: keyboard movement
 * is "the previous/next *visible* row", which a recursive component cannot express. Collapsed
 * folders contribute their own row but none of their descendants'. Pure — no React, no DOM — so
 * the traversal (and the ARIA level/setsize/posinset each row reports) is unit-testable on its own.
 *
 * @param nodes The tree's root-level nodes (from {@link buildBundleTree}).
 * @param collapsed The paths of folders the user has collapsed; everything else reads expanded.
 * @returns The visible rows, in render order.
 */
export function flattenBundleTree(
  nodes: BundleTreeNode[],
  collapsed: ReadonlySet<string>,
): BundleTreeRow[] {
  const rows: BundleTreeRow[] = [];

  const walk = (siblings: BundleTreeNode[], depth: number, parentPath: string | null) => {
    siblings.forEach((node, index) => {
      const hasChildren = node.kind === 'folder' && node.children.length > 0;
      const expanded = hasChildren && !collapsed.has(node.path);
      rows.push({
        node,
        depth,
        hasChildren,
        expanded,
        setSize: siblings.length,
        posInSet: index + 1,
        parentPath,
      });
      if (node.kind === 'folder' && expanded) {
        walk(node.children, depth + 1, node.path);
      }
    });
  };

  walk(nodes, 1, null);
  return rows;
}
