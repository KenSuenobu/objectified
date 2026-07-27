/**
 * Large-output guards for the export viewer surfaces (MFX-43.5, #4365).
 *
 * Enterprise APIs emit megabyte bundles, and Monaco degrades badly when it is handed unbounded
 * content: tokenization, folding ranges, and bracket colorization are all whole-model work. This
 * module is the pure decision layer in front of the viewer — what may be rendered inline, what is
 * shown as an explicitly truncated head, and what is held back until the user asks for it:
 *
 * - a **per-file cap** ({@link VIEWER_INLINE_FILE_CAP_BYTES}): a file bigger than this is never
 *   rendered whole. The user can open an explicitly-labelled first-{@link VIEWER_HEAD_PREVIEW_BYTES}
 *   slice, or download the file and read all of it in a real editor;
 * - a **per-bundle inline budget** ({@link VIEWER_INLINE_BUNDLE_BUDGET_BYTES}): across a bundle only
 *   this many bytes are admitted to the viewer automatically, in emit order, so a 200-file bundle
 *   does not build 200 Monaco models. Everything past the budget loads on demand, one file per
 *   click — the client-side counterpart of fetch-on-demand;
 * - **feature tuning by size** ({@link guardedEditorOptions}): beyond
 *   {@link VIEWER_HEAVY_FEATURE_BYTES} the expensive per-model extras are dropped so even an
 *   admitted large file stays responsive.
 *
 * Truncation is never silent: every plan carries the bytes shown, the bytes that exist, and the
 * reason, which the viewer renders verbatim.
 *
 * Everything here is pure (no React, no DOM, no fetch) so it unit-tests directly — mirroring
 * `./exportBundle.ts` and `./exportArtifactPreview.ts`.
 */

/** Largest file rendered whole in the viewer; bigger files offer a head slice + download (512 KB). */
export const VIEWER_INLINE_FILE_CAP_BYTES = 512 * 1024;

/** Total bytes a bundle may put into the viewer without the user asking file-by-file (2 MB). */
export const VIEWER_INLINE_BUNDLE_BUDGET_BYTES = 2 * 1024 * 1024;

/** How much of an over-cap file the explicit head preview shows (128 KB). */
export const VIEWER_HEAD_PREVIEW_BYTES = 128 * 1024;

/** Beyond this size the viewer drops its expensive per-model features (128 KB). */
export const VIEWER_HEAVY_FEATURE_BYTES = 128 * 1024;

/** How the viewer is showing a file. */
export type ViewerContentMode =
  /** The whole file is in the editor. */
  | 'full'
  /** Only an explicitly-labelled leading slice is in the editor. */
  | 'head'
  /** Nothing is in the editor yet — the user must ask for this file. */
  | 'deferred';

/** Why a file is not simply rendered whole. */
export type ViewerGuardReason =
  /** The file alone exceeds {@link VIEWER_INLINE_FILE_CAP_BYTES}. */
  | 'file-cap'
  /** The file fits, but the bundle's inline budget was already spent on earlier files. */
  | 'bundle-budget'
  /** Nothing is being withheld. */
  | null;

/** The viewer's decision for one file: what to render, and what to say about the rest. */
export interface ViewerContentPlan {
  /** How the file is being shown. */
  mode: ViewerContentMode;
  /** The text to hand the editor — empty while `deferred`. */
  text: string;
  /** The file's full size in UTF-8 bytes. */
  totalBytes: number;
  /** How many bytes of it are in the editor (0 while `deferred`). */
  shownBytes: number;
  /** True when the editor holds less than the whole file. */
  truncated: boolean;
  /** Why, when something is withheld. */
  reason: ViewerGuardReason;
  /** Whether asking to load this file can only ever yield the head slice (an over-cap file). */
  headOnly: boolean;
}

/** Caps overridable per call — the defaults are the exported constants; tests inject small ones. */
export interface ViewerGuardCaps {
  /** Largest file rendered whole. */
  fileCapBytes?: number;
  /** Total bytes admitted automatically across a bundle. */
  bundleBudgetBytes?: number;
  /** Size of the head slice shown for an over-cap file. */
  headBytes?: number;
}

/**
 * Take the leading `maxBytes` UTF-8 bytes of a document, cut at a character (and, where possible,
 * a line) boundary so the preview never ends mid-codepoint or mid-line.
 *
 * @param text The full document text.
 * @param maxBytes The byte budget for the slice; values below 1 yield an empty string.
 * @returns The leading slice — the whole text when it already fits.
 */
export function headSlice(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let decoded = new TextDecoder('utf-8').decode(bytes.slice(0, maxBytes));
  // A cut through a multi-byte sequence decodes to a trailing replacement char — drop it.
  if (decoded.endsWith('�')) decoded = decoded.slice(0, -1);
  // Prefer ending on a line boundary, but never throw away most of the slice to get one.
  const lastNewline = decoded.lastIndexOf('\n');
  if (lastNewline > 0 && lastNewline >= decoded.length / 2) decoded = decoded.slice(0, lastNewline);
  return decoded;
}

/** The inputs {@link planViewerContent} needs about the file it is deciding for. */
export interface ViewerContentInput {
  /** The file's full text. */
  text: string;
  /** The file's size in UTF-8 bytes (already computed by the bundle manifest). */
  sizeBytes: number;
  /**
   * Whether the bundle's inline budget admitted this file automatically. Single-document surfaces
   * pass `true` — there is no bundle to budget across.
   */
  inlineAllowed?: boolean;
  /** Whether the user explicitly asked for this file ("Load this file" / "Show the first …"). */
  requested?: boolean;
}

/**
 * Decide how one file is shown (MFX-43.5).
 *
 * An over-cap file is never rendered whole: unopened it is `deferred`, and once the user asks it
 * becomes an explicitly truncated `head`. A file within the cap is `full` as soon as either the
 * bundle budget admitted it or the user asked for it.
 *
 * @param input The file's text/size and whether it is budget-admitted or user-requested.
 * @param caps Optional cap overrides (defaults to the module constants).
 * @returns The plan: mode, the text to render, the byte accounting, and the reason.
 */
export function planViewerContent(
  input: ViewerContentInput,
  caps: ViewerGuardCaps = {},
): ViewerContentPlan {
  const fileCap = caps.fileCapBytes ?? VIEWER_INLINE_FILE_CAP_BYTES;
  const headBytes = caps.headBytes ?? VIEWER_HEAD_PREVIEW_BYTES;
  const totalBytes = input.sizeBytes;
  const overCap = totalBytes > fileCap;
  const requested = input.requested === true;
  const admitted = input.inlineAllowed !== false;

  if (overCap) {
    if (!requested) {
      return {
        mode: 'deferred',
        text: '',
        totalBytes,
        shownBytes: 0,
        truncated: true,
        reason: 'file-cap',
        headOnly: true,
      };
    }
    const text = headSlice(input.text, headBytes);
    return {
      mode: 'head',
      text,
      totalBytes,
      shownBytes: new TextEncoder().encode(text).length,
      truncated: true,
      reason: 'file-cap',
      headOnly: true,
    };
  }

  if (!admitted && !requested) {
    return {
      mode: 'deferred',
      text: '',
      totalBytes,
      shownBytes: 0,
      truncated: true,
      reason: 'bundle-budget',
      headOnly: false,
    };
  }

  return {
    mode: 'full',
    text: input.text,
    totalBytes,
    shownBytes: totalBytes,
    truncated: false,
    reason: null,
    headOnly: false,
  };
}

/** Which of a bundle's files the inline budget admits without the user asking. */
export interface BundleInlineBudget {
  /** Paths admitted automatically, in emit order. */
  inline: Set<string>;
  /** Paths held back — loaded one at a time, on demand. */
  deferred: string[];
  /** Bytes the admitted set accounts for. */
  usedBytes: number;
  /** The budget the plan was made against (so the UI can state it). */
  budgetBytes: number;
}

/**
 * Spend the bundle's inline budget over its files in emit order (MFX-43.5).
 *
 * Emit order means the primary file — the one the explorer opens first — is admitted first, and a
 * bundle that fits entirely under the budget behaves exactly as before this guard existed. A file
 * over the per-file cap is *not* charged to the budget: it can never be rendered whole anyway, so
 * letting it consume the budget would needlessly defer its smaller siblings.
 *
 * @param files The bundle's files with their sizes, in emit order.
 * @param caps Optional cap overrides (defaults to the module constants).
 * @returns Which paths are inline, which are deferred, and the bytes spent.
 */
export function planBundleInlineBudget(
  files: { path: string; sizeBytes: number }[],
  caps: ViewerGuardCaps = {},
): BundleInlineBudget {
  const fileCap = caps.fileCapBytes ?? VIEWER_INLINE_FILE_CAP_BYTES;
  const budgetBytes = caps.bundleBudgetBytes ?? VIEWER_INLINE_BUNDLE_BUDGET_BYTES;
  const inline = new Set<string>();
  const deferred: string[] = [];
  let usedBytes = 0;

  for (const file of files) {
    if (file.sizeBytes > fileCap) {
      // The per-file cap owns this one; it is deferred on its own terms and costs no budget.
      deferred.push(file.path);
      continue;
    }
    if (usedBytes + file.sizeBytes <= budgetBytes) {
      inline.add(file.path);
      usedBytes += file.sizeBytes;
    } else {
      deferred.push(file.path);
    }
  }

  return { inline, deferred, usedBytes, budgetBytes };
}

/**
 * The editor options that keep a large document responsive (MFX-43.5).
 *
 * Below {@link VIEWER_HEAVY_FEATURE_BYTES} nothing is taken away. Beyond it the whole-model extras
 * — bracket-pair colorization, occurrence highlighting, and generous per-line tokenization — are
 * dropped, and Monaco's own large-file optimizations are left on. Folding is *not* decided here:
 * it is a user-facing toggle on the viewer, so the guard never silently overrides the user.
 *
 * @param sizeHint The size of the document actually being rendered (the shown slice, not the whole
 *   file) — UTF-8 bytes, or the string length as a cheap allocation-free proxy.
 * @returns Monaco editor options to merge over the shared read-only defaults.
 */
export function guardedEditorOptions(sizeHint: number): Record<string, unknown> {
  const heavy = sizeHint > VIEWER_HEAVY_FEATURE_BYTES;
  return {
    largeFileOptimizations: true,
    bracketPairColorization: { enabled: !heavy },
    occurrencesHighlight: heavy ? 'off' : 'singleFile',
    stopRenderingLineAfter: heavy ? 5_000 : 10_000,
    maxTokenizationLineLength: heavy ? 2_000 : 20_000,
    // Read-only viewers never suggest, but the worker still indexes words for it when left on.
    wordBasedSuggestions: 'off',
  };
}

/**
 * The sentence shown when a bundle holds files back from the viewer, or null when it holds none.
 *
 * @param budget The bundle's inline budget plan.
 * @param totalFiles How many files the bundle has.
 * @returns The explicit "N of M files load on demand" line, or null when everything is inline.
 */
export function describeInlineBudget(
  budget: BundleInlineBudget,
  totalFiles: number,
): string | null {
  const held = budget.deferred.length;
  if (held === 0) return null;
  return `${held} of ${totalFiles} files load only when you open them, so this screen stays responsive.`;
}
