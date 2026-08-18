/**
 * The rules the Versions overlays share (HIVE-6.3, #5314).
 *
 * Authority: `docs/mockups/build/version-dialogs.html` — the gallery of the eleven panels and
 * dialogs that hang off the Versions page. Each of them used to decide its own colours: the
 * diff legend named `red-200` / `green-200`, the canvas compare returned `#10b981`, the history
 * DAG carried an eight-entry Tailwind lane palette, the merge conflict list spelled
 * `amber-50`, and the export fidelity buckets picked `emerald` or `rose` at three different
 * call sites. Every one of those froze the surface on one palette.
 *
 * This module is where those decisions live now, as **pure data**: a change class, a lane, a
 * conflict resolution, a fidelity bucket or a bench verdict maps to a *tone name* from the
 * shared status vocabulary, and the tone names a token. No React and no colour literal — the
 * paint is `globals.css` §HIVE-6.3, keyed by the `data-tone` these helpers return.
 *
 * The copy the mockup quotes verbatim (its "Keeps (1:1)" list) is here too, for the same
 * reason the earlier tickets moved theirs: a string that two panels and one test each spell
 * for themselves drifts, and the mockup is the thing they are all supposed to agree with.
 *
 * @see `components/ui/statusVocabulary.ts` — the tone → token mapping these names resolve
 *      through.
 * @see `components/ade/versions/versionsModel.ts` — the same shape for HIVE-6.2's surfaces.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';

/* ==========================================================================
   1 · Compare — the diff view and the schema-changes tab
   ========================================================================== */

/** How one line, class or canvas element differs between the two revisions. */
export type VersionChangeClass = 'added' | 'removed' | 'modified' | 'unchanged';

/** Every change class, in the order the mockup's legend and summary chips print them. */
export const VERSION_CHANGE_CLASSES: readonly VersionChangeClass[] = [
  'added',
  'removed',
  'modified',
  'unchanged',
] as const;

/**
 * The tone a change class is drawn in.
 *
 * `unchanged` is `neutral` rather than "no tone": the legend has to show a swatch for it, and
 * a swatch with no fill is invisible on the inset the diff pane sits on.
 */
export const VERSION_CHANGE_TONE: Readonly<Record<VersionChangeClass, StatusTone>> = {
  added: 'ok',
  removed: 'danger',
  modified: 'warn',
  unchanged: 'neutral',
};

/** The one-character sigil beside a class row — the mockup's `+` / `−` / `~`. */
export const VERSION_CHANGE_SIGIL: Readonly<Record<VersionChangeClass, string>> = {
  added: '+',
  removed: '−',
  modified: '~',
  unchanged: '=',
};

/** The word the summary chips and the class rows use. */
export const VERSION_CHANGE_LABEL: Readonly<Record<VersionChangeClass, string>> = {
  added: 'Added',
  removed: 'Removed',
  modified: 'Modified',
  unchanged: 'Unchanged',
};

/**
 * One entry of the diff view's legend.
 *
 * The diff pane shows three (a line is added, removed or neither); the canvas tab shows four
 * and words them by *side*, because there both revisions are on screen at once.
 */
export interface VersionDiffLegendEntry {
  /** The change class the swatch stands for. */
  change: VersionChangeClass;
  /** The words beside the swatch. */
  label: string;
}

/** The diff pane's legend — the mockup's Removed · Added · Unchanged. */
export const VERSION_DIFF_LEGEND: readonly VersionDiffLegendEntry[] = [
  { change: 'removed', label: 'Removed' },
  { change: 'added', label: 'Added' },
  { change: 'unchanged', label: 'Unchanged' },
] as const;

/** The canvas tab's legend, worded by side as the mockup words it. */
export const VERSION_CANVAS_LEGEND: readonly VersionDiffLegendEntry[] = [
  { change: 'added', label: 'Added (compare side)' },
  { change: 'removed', label: 'Removed (base side)' },
  { change: 'modified', label: 'Moved / modified' },
  { change: 'unchanged', label: 'Unchanged' },
] as const;

/**
 * The token a React Flow node border or edge stroke is painted with.
 *
 * React Flow writes its node and edge colours into an inline `style`, which no stylesheet can
 * reach — so this is the one place a *colour* is named in JS. It names a **token reference**,
 * never a hue: `var(--ok)` follows all nine themes exactly as a class would, and the AC's
 * "React Flow surfaces adopt token colours" is satisfied without teaching the library about
 * classes it does not support.
 *
 * @param change How the element differs.
 * @returns A CSS `var(…)` reference, suitable for `style.borderColor` or `style.stroke`.
 */
export function changeStrokeVar(change: VersionChangeClass): string {
  switch (change) {
    case 'added':
      return 'var(--ok)';
    case 'removed':
      return 'var(--danger)';
    case 'modified':
      return 'var(--warn)';
    default:
      return 'var(--fg-faint)';
  }
}

/** A `jsdiff` part, reduced to the two flags the diff view actually reads. */
export interface VersionDiffPartFlags {
  added?: boolean;
  removed?: boolean;
}

/**
 * Classify one diff hunk.
 *
 * `jsdiff` marks a part added *or* removed *or* neither; both flags together never occur, and
 * `added` is checked first so a malformed part still resolves to a single class.
 *
 * @param part The hunk.
 * @returns Its change class — never `modified`, which is a class-level verdict.
 */
export function diffPartChange(part: VersionDiffPartFlags): VersionChangeClass {
  if (part.added) return 'added';
  if (part.removed) return 'removed';
  return 'unchanged';
}

/** The prefix an overlay (unified) diff line carries. */
export function diffLinePrefix(change: VersionChangeClass): string {
  if (change === 'added') return '+ ';
  if (change === 'removed') return '- ';
  return '';
}

/* ==========================================================================
   2 · History — lanes, and what a revision node is
   ========================================================================== */

/**
 * The tones a branch lane may take, in assignment order.
 *
 * The DAG needs a *identity* palette — one stable colour per named branch — and the mockup
 * draws its lane dots in blue and violet. Eight distinguishable hues is what the token layer
 * offers, and using them here rather than `bg-emerald-500`…`bg-indigo-500` is what lets a lane
 * keep its contrast on Nord and Solarized. Assignment is by index, so a branch keeps its
 * colour for as long as the branch list keeps its order.
 *
 * `honey` is deliberately last: DESIGN.md §2 spends it on markers, and a lane that took it
 * first would collide with the `gitlike` flag beside it in the same strip.
 */
export const VERSION_LANE_TONES: readonly StatusTone[] = [
  'ok',
  'accent',
  'violet',
  'rose',
  'warn',
  'orange',
  'danger',
  'honey',
] as const;

/** The lane a revision with no named branch sits in. */
export const VERSION_LANE_TONE_NONE: StatusTone = 'neutral';

/**
 * The tone of lane *n*.
 *
 * @param index 0-based index into the branch list; `null`/negative means "no lane".
 * @returns A tone name, wrapping round the palette for a ninth branch.
 */
export function laneToneForBranchIndex(index: number | null | undefined): StatusTone {
  if (index == null || index < 0) return VERSION_LANE_TONE_NONE;
  return VERSION_LANE_TONES[index % VERSION_LANE_TONES.length];
}

/** The token a DAG edge is stroked with — solid for a primary parent, dashed violet for a merge. */
export function historyEdgeStrokeVar(kind: 'primary' | 'merge'): string {
  return kind === 'merge' ? 'var(--violet)' : 'var(--fg-subtle)';
}

/* ==========================================================================
   3 · Merge — conflicts and their resolutions
   ========================================================================== */

/** What the merge engine decided about one conflicting path. */
export type MergeResolution = 'unresolved' | 'mine' | 'theirs' | 'manual';

/** Every resolution, in the order the bulk bar and the row buttons offer them. */
export const MERGE_RESOLUTIONS: readonly MergeResolution[] = [
  'unresolved',
  'mine',
  'theirs',
  'manual',
] as const;

/**
 * The badge word for a resolution.
 *
 * "Mine" and "Theirs" are git's words and the dialog explains them once at the top ("Mine =
 * target branch `main`"); the badge spells out which side that is, because the row is read far
 * from that sentence.
 */
export const MERGE_RESOLUTION_LABEL: Readonly<Record<MergeResolution, string>> = {
  unresolved: 'Unresolved',
  mine: 'Target (mine)',
  theirs: 'Source (theirs)',
  manual: 'Manual',
};

/** The tone of a resolution badge. An unresolved row is the only one that warns. */
export const MERGE_RESOLUTION_TONE: Readonly<Record<MergeResolution, StatusTone>> = {
  unresolved: 'warn',
  mine: 'accent',
  theirs: 'ok',
  manual: 'violet',
};

/**
 * Whether apply may proceed.
 *
 * @param resolutions One entry per conflicting path.
 * @returns `true` only when every path has a resolution — the rule the dialog's disabled
 *          Apply button and its "conflicts detected" toast both state.
 */
export function mergeConflictsResolved(resolutions: readonly MergeResolution[]): boolean {
  return resolutions.every((resolution) => resolution !== 'unresolved');
}

/* ==========================================================================
   4 · Compatibility — the verdict shared by merge, rollback and publish
   ========================================================================== */

/** The three verdicts the compatibility API returns. */
export type CompatVerdict = 'safe' | 'warning' | 'breaking';

/** The tone of a verdict badge. */
export const COMPAT_VERDICT_TONE: Readonly<Record<CompatVerdict, StatusTone>> = {
  safe: 'ok',
  warning: 'warn',
  breaking: 'danger',
};

/**
 * Normalise whatever the API said into a verdict.
 *
 * The compatibility, oasdiff and rollback endpoints each phrase the same three outcomes
 * slightly differently (`"BREAKING"`, `"breaking"`, `"warn"`); an unrecognised string is
 * treated as a warning rather than as safe, so a new server word can never read as a green
 * light on an old client.
 *
 * @param raw The server's word, in any case.
 * @returns The verdict.
 */
export function compatVerdict(raw: string | null | undefined): CompatVerdict {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'safe' || value === 'ok' || value === 'compatible') return 'safe';
  if (value === 'breaking' || value === 'incompatible') return 'breaking';
  return 'warning';
}

/* ==========================================================================
   5 · Lint — the A–F grade band
   ========================================================================== */

/** The five bands a quality score falls into. */
export type LintGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Every grade, best first. */
export const LINT_GRADES: readonly LintGrade[] = ['A', 'B', 'C', 'D', 'F'] as const;

/**
 * The tone of a grade chip.
 *
 * Five bands over four tones: A and B are both `ok` because both are a pass, and the letter
 * beside the score is what separates them. D takes `orange` rather than a second `warn` so the
 * chip row in the mockup stays five distinguishable steps.
 */
export const LINT_GRADE_TONE: Readonly<Record<LintGrade, StatusTone>> = {
  A: 'ok',
  B: 'ok',
  C: 'warn',
  D: 'orange',
  F: 'danger',
};

/**
 * The grade a score earns.
 *
 * @param score 0–100, as the server stores it.
 * @returns The band, using the usual 90/80/70/60 cuts.
 */
export function lintGradeForScore(score: number): LintGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/** The chip's text — `{grade} · {score}`, or the unscored dash. */
export function lintBadgeLabel(grade: string | null | undefined, score: number | null | undefined): string {
  if (!grade || score == null || !Number.isFinite(score)) return 'Lint —';
  return `${grade} · ${Math.round(score)}`;
}

/** The chip's tooltip, which says what clicking it will do. */
export const LINT_BADGE_UNSCORED_TITLE = 'Not scored yet — click to lint this version';

/** The severities a lint finding carries, worst first. */
export type LintSeverity = 'error' | 'warning' | 'info';

/** Every severity, in the order the pill row prints them. */
export const LINT_SEVERITIES: readonly LintSeverity[] = ['error', 'warning', 'info'] as const;

/** The tone of a severity pill. */
export const LINT_SEVERITY_TONE: Readonly<Record<LintSeverity, StatusTone>> = {
  error: 'rose',
  warning: 'warn',
  info: 'accent',
};

/* ==========================================================================
   6 · Export — fidelity buckets and their words
   ========================================================================== */

/** How faithfully a source survives conversion to one target. */
export type FidelityBucket = 'lossless' | 'lossy' | 'types-only';

/** Every bucket, best first. */
export const FIDELITY_BUCKETS: readonly FidelityBucket[] = ['lossless', 'lossy', 'types-only'] as const;

/** The tone of a fidelity badge. */
export const FIDELITY_BUCKET_TONE: Readonly<Record<FidelityBucket, StatusTone>> = {
  lossless: 'ok',
  lossy: 'warn',
  'types-only': 'danger',
};

/** The word on the badge. */
export const FIDELITY_BUCKET_LABEL: Readonly<Record<FidelityBucket, string>> = {
  lossless: 'lossless',
  lossy: 'lossy',
  'types-only': 'types-only',
};

/**
 * The bucket a preserved-percentage falls into.
 *
 * The cuts are the ones the export registry already uses for its "best-fidelity" and "lossy"
 * groupings on the version panel: ≥ 85 % is a target you can pick without reading the report,
 * ≥ 50 % is one you should, and below that the artifact is types only.
 *
 * @param percent 0–100 preserved.
 * @returns The bucket.
 */
export function fidelityBucket(percent: number): FidelityBucket {
  if (percent >= 85) return 'lossless';
  if (percent >= 50) return 'lossy';
  return 'types-only';
}

/** The four per-construct outcomes the fidelity report counts. */
export type ProjectionOutcome = 'dropped' | 'approximated' | 'synthesized' | 'clean';

/** Every outcome, in the order the chip row prints them. */
export const PROJECTION_OUTCOMES: readonly ProjectionOutcome[] = [
  'dropped',
  'approximated',
  'synthesized',
  'clean',
] as const;

/** The tone of an outcome chip. */
export const PROJECTION_OUTCOME_TONE: Readonly<Record<ProjectionOutcome, StatusTone>> = {
  dropped: 'danger',
  approximated: 'warn',
  synthesized: 'accent',
  clean: 'ok',
};

/** The node tone on the projection graph, which draws the same four outcomes as boxes. */
export function projectionNodeStrokeVar(outcome: ProjectionOutcome): string {
  switch (outcome) {
    case 'dropped':
      return 'var(--danger)';
    case 'approximated':
      return 'var(--warn)';
    case 'synthesized':
      return 'var(--accent)';
    default:
      return 'var(--ok)';
  }
}

/* ==========================================================================
   7 · Test bench — payload verdicts and suite runs
   ========================================================================== */

/** What validating one payload concluded. */
export type BenchVerdict = 'valid' | 'invalid' | 'error';

/** Every verdict. */
export const BENCH_VERDICTS: readonly BenchVerdict[] = ['valid', 'invalid', 'error'] as const;

/** The tone of a verdict badge. */
export const BENCH_VERDICT_TONE: Readonly<Record<BenchVerdict, StatusTone>> = {
  valid: 'ok',
  invalid: 'rose',
  error: 'danger',
};

/** The word on the badge — the run history prints `passed` / `failed`, not `valid` / `invalid`. */
export const BENCH_VERDICT_LABEL: Readonly<Record<BenchVerdict, string>> = {
  valid: 'passed',
  invalid: 'failed',
  error: 'error',
};

/**
 * Whether a suite run is a regression: a payload that passed before now fails.
 *
 * `error` is not a regression — the validator was unavailable, which says nothing about the
 * schema. That is the same rule `SuiteRegressionBadge`'s tooltip states ("a previously-passing
 * payload now failing"), stated once here so the badge and the run history cannot disagree.
 *
 * @param previous The verdict of the same payload in the previous run, if there was one.
 * @param current This run's verdict.
 * @returns `true` when this payload regressed.
 */
export function benchPayloadRegressed(
  previous: BenchVerdict | null | undefined,
  current: BenchVerdict
): boolean {
  return previous === 'valid' && current === 'invalid';
}

/** The badge a regressed payload carries in the verdict diff. */
export const BENCH_REGRESSION_LABEL = 'passed → failed';

/* ==========================================================================
   8 · The copy the mockup quotes verbatim
   ========================================================================== */

/**
 * Empty, loading and error copy, exactly as `version-dialogs.html` prints it.
 *
 * The AC is "every panel keeps its data contract and empty/loading copy", and the way to keep
 * a sentence is to have one copy of it. Each key names the panel and the state.
 */
export const VERSION_DIALOG_COPY = {
  /** Compare · canvas tab, while the two layouts are being fetched. */
  canvasLoading: 'Loading canvas layouts…',
  /** Compare · canvas tab, when a revision has no saved layout. */
  canvasEmpty:
    'No saved canvas layout for this revision. Save a default or named layout in Studio to compare visually.',
  /** Compare · canvas tab, under the legend. */
  canvasNote:
    'Renders the resolved Studio layout (default snapshot, or the effective named layout when no default exists). Logical schema diff stays on the other tabs.',
  /** Compare · schema changes, when every class is filtered out by the chips. */
  classDiffAllFiltered: 'All change types are filtered out',
  /** Compare · schema changes, when the search matches nothing. */
  classDiffNoMatch: 'No changes match the current filter',
  /** Change report, when the publication has none stored. */
  changeReportEmpty:
    'No change report is stored for this publication yet. It is created when the revision is published (if generation succeeded).',
  /** Change report, with no project chosen. */
  changeReportNoProject: 'Choose a project to work with publication change reports.',
  /** Change report, with a project but nothing published. */
  changeReportNoPublished:
    'Publish a schema revision first. Change reports are generated when a version is published (CR-04).',
  /** History graph, when every lane chip is off. */
  historyNoLanes: 'Select at least one branch to show the graph, or use “Select all”.',
  /** History graph, with nothing to draw. */
  historyEmpty: 'No revisions to graph.',
  /** Rollback, with no named branch to roll back. */
  rollbackNoBranches: 'No named branches exist in this project. Create one first before rolling back.',
  /** Rollback confirm, before a preview has run. */
  rollbackNoPreview: 'Run preview impact first to load entity counts.',
  /** Compatibility report, when the pair produced no findings. */
  compatNoFindings: 'No structural findings in this report.',
  /** Lint report, when the version is clean. */
  lintNoFindings: 'No findings — clean bill of health.',
  /** Lint report, while rule metadata is in flight. */
  lintRulesLoading: 'Loading rule metadata…',
  /** Lint report / scoring panel, on failure. */
  lintUnavailable: 'Lint report unavailable.',
  /** Mock scenarios, with none defined. */
  scenariosEmpty:
    'No scenarios defined yet. Add one to get started — for example quota-exceeded returning HTTP 429 from a list operation.',
  /** Mock scenarios, while loading. */
  scenariosLoading: 'Loading scenarios…',
  /** Test bench, with no suites for this artifact. */
  benchNoSuites:
    'No test suites for this artifact yet — save the payloads that prove this schema works, and every future revision can be checked against them.',
  /** Test bench, for a suite that has never run. */
  benchNoRuns: 'No runs recorded yet — run the suite against a revision to start its history.',
  /** Test bench, when the revision's schema list could not be fetched. */
  benchTargetsError: 'Could not list this revision’s schemas.',
  /** Export panel, while the registry measures this source. */
  exportMeasuring: 'Measuring export fidelity for this version…',
  /** Export panel, with nothing in a bucket. */
  exportBucketEmpty: 'None',
  /** Export panel, recent exports. */
  exportNoRecent: 'No exports of this version yet.',
} as const;

/** The name of a quoted string. */
export type VersionDialogCopyKey = keyof typeof VERSION_DIALOG_COPY;
