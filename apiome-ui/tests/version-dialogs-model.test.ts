/**
 * The rules the Versions overlays share (HIVE-6.3, #5314).
 *
 * `versionDialogsModel.ts` is where this ticket put every decision that used to be a colour
 * literal scattered across eleven panels: which tone a change class, a branch lane, a merge
 * resolution, a compatibility verdict, an A–F band, a fidelity tier and a bench verdict take,
 * and the copy the mockup quotes verbatim. It is pure, so it is testable directly — which is
 * the point of moving it: a table that is tested once cannot drift between the surfaces that
 * read it.
 *
 * What this suite pins:
 *
 *   1. **Every tone is a vocabulary tone.** Not a hex, not a Tailwind class — a name
 *      `ui/statusVocabulary` knows, so `Badge` and the `[data-tone]` rules in `globals.css`
 *      resolve it to the same token pair.
 *   2. **The two spellings of one idea agree.** `changeStrokeVar` hands react-flow a token
 *      reference for exactly the classes `VERSION_CHANGE_TONE` colours; a legend swatch and the
 *      node it explains can no longer disagree.
 *   3. **Nothing names a colour.** Every `*StrokeVar` returns `var(--token)`, never a hue —
 *      that is what lets an inline `style` (the one place the cascade cannot reach) still
 *      follow the theme swap.
 *   4. **The quoted copy is the mockup's**, including the sentences the AC calls out by name.
 */

import {
  BENCH_REGRESSION_LABEL,
  BENCH_VERDICTS,
  BENCH_VERDICT_LABEL,
  BENCH_VERDICT_TONE,
  COMPAT_VERDICT_TONE,
  FIDELITY_BUCKETS,
  FIDELITY_BUCKET_LABEL,
  FIDELITY_BUCKET_TONE,
  LINT_BADGE_UNSCORED_TITLE,
  LINT_GRADES,
  LINT_GRADE_TONE,
  LINT_SEVERITIES,
  LINT_SEVERITY_TONE,
  MERGE_RESOLUTIONS,
  MERGE_RESOLUTION_LABEL,
  MERGE_RESOLUTION_TONE,
  PROJECTION_OUTCOMES,
  PROJECTION_OUTCOME_TONE,
  VERSION_CANVAS_LEGEND,
  VERSION_CHANGE_CLASSES,
  VERSION_CHANGE_LABEL,
  VERSION_CHANGE_SIGIL,
  VERSION_CHANGE_TONE,
  VERSION_DIALOG_COPY,
  VERSION_DIFF_LEGEND,
  VERSION_LANE_TONES,
  VERSION_LANE_TONE_NONE,
  benchPayloadRegressed,
  changeStrokeVar,
  compatVerdict,
  diffLinePrefix,
  diffPartChange,
  fidelityBucket,
  historyEdgeStrokeVar,
  laneToneForBranchIndex,
  lintBadgeLabel,
  lintGradeForScore,
  mergeConflictsResolved,
  projectionNodeStrokeVar,
} from '@/app/components/ade/version-dialogs/versionDialogsModel';
import { STATUS_TONES, STATUS_TONE_SOFT_CLASS } from '@/app/components/ui/statusVocabulary';

/** A `var(--name)` reference and nothing else — no hue, no fallback. */
const TOKEN_REFERENCE = /^var\(--[a-z-]+\)$/;

describe('every tone this module hands out is one the shared vocabulary knows', () => {
  // The whole point of naming a tone rather than a colour is that `Badge` and the
  // `[data-tone]` rules resolve the same name. A tone this table invented would render
  // untinted in one place and correctly in the other — a silent failure, not a crash.
  const TONE_TABLES: Array<[string, Record<string, string>]> = [
    ['VERSION_CHANGE_TONE', VERSION_CHANGE_TONE],
    ['MERGE_RESOLUTION_TONE', MERGE_RESOLUTION_TONE],
    ['COMPAT_VERDICT_TONE', COMPAT_VERDICT_TONE],
    ['LINT_GRADE_TONE', LINT_GRADE_TONE],
    ['LINT_SEVERITY_TONE', LINT_SEVERITY_TONE],
    ['FIDELITY_BUCKET_TONE', FIDELITY_BUCKET_TONE],
    ['PROJECTION_OUTCOME_TONE', PROJECTION_OUTCOME_TONE],
    ['BENCH_VERDICT_TONE', BENCH_VERDICT_TONE],
  ];

  it.each(TONE_TABLES)('%s names only vocabulary tones', (_name, table) => {
    for (const tone of Object.values(table)) {
      expect(STATUS_TONES).toContain(tone);
      expect(STATUS_TONE_SOFT_CLASS).toHaveProperty(tone);
    }
  });

  it('spends every lane on a vocabulary tone, and offers eight of them', () => {
    // Eight is what the DAG's lane palette used to carry as Tailwind hues; the token layer
    // offers exactly eight distinguishable ones, so a ninth branch wraps rather than
    // inventing a colour.
    expect(VERSION_LANE_TONES).toHaveLength(8);
    expect(new Set(VERSION_LANE_TONES).size).toBe(8);
    for (const tone of VERSION_LANE_TONES) {
      expect(STATUS_TONES).toContain(tone);
    }
    expect(STATUS_TONES).toContain(VERSION_LANE_TONE_NONE);
  });

  it('keeps honey last, so a lane never collides with the gitlike flag beside it', () => {
    // DESIGN.md §2 spends honey on markers; the `gitlike` chip sits in the same strip as the
    // lane chips, and a lane that took honey first would read as a second flag.
    expect(VERSION_LANE_TONES[VERSION_LANE_TONES.length - 1]).toBe('honey');
  });
});

describe('lanes', () => {
  it('gives lane n a stable tone and wraps past the palette', () => {
    expect(laneToneForBranchIndex(0)).toBe(VERSION_LANE_TONES[0]);
    expect(laneToneForBranchIndex(7)).toBe(VERSION_LANE_TONES[7]);
    expect(laneToneForBranchIndex(8)).toBe(VERSION_LANE_TONES[0]);
    expect(laneToneForBranchIndex(17)).toBe(VERSION_LANE_TONES[1]);
  });

  it('treats "no lane" and a nonsense index the same, and neutrally', () => {
    expect(laneToneForBranchIndex(null)).toBe(VERSION_LANE_TONE_NONE);
    expect(laneToneForBranchIndex(undefined)).toBe(VERSION_LANE_TONE_NONE);
    expect(laneToneForBranchIndex(-1)).toBe(VERSION_LANE_TONE_NONE);
  });

  it('strokes a merge edge violet and a primary edge in the quiet ink, both as tokens', () => {
    expect(historyEdgeStrokeVar('merge')).toBe('var(--violet)');
    expect(historyEdgeStrokeVar('primary')).toBe('var(--fg-subtle)');
    expect(historyEdgeStrokeVar('merge')).toMatch(TOKEN_REFERENCE);
    expect(historyEdgeStrokeVar('primary')).toMatch(TOKEN_REFERENCE);
  });
});

describe('change classes', () => {
  it('colours, signs and words all four classes', () => {
    for (const change of VERSION_CHANGE_CLASSES) {
      expect(VERSION_CHANGE_TONE).toHaveProperty(change);
      expect(VERSION_CHANGE_SIGIL[change]).toHaveLength(1);
      expect(VERSION_CHANGE_LABEL[change]).toBeTruthy();
    }
  });

  it('hands react-flow a token reference, never a hue', () => {
    // This is the AC "React Flow surfaces adopt token colours": the library writes the value
    // into an inline `style` no stylesheet can reach, so the *value* has to be the token.
    for (const change of VERSION_CHANGE_CLASSES) {
      expect(changeStrokeVar(change)).toMatch(TOKEN_REFERENCE);
    }
    expect(changeStrokeVar('added')).toBe('var(--ok)');
    expect(changeStrokeVar('removed')).toBe('var(--danger)');
    expect(changeStrokeVar('modified')).toBe('var(--warn)');
    expect(changeStrokeVar('unchanged')).toBe('var(--fg-faint)');
  });

  it('draws a legend for exactly the classes the panes colour', () => {
    // The swatch and the node have to be the same idea, or the legend lies.
    for (const entry of [...VERSION_DIFF_LEGEND, ...VERSION_CANVAS_LEGEND]) {
      expect(VERSION_CHANGE_CLASSES).toContain(entry.change);
      expect(entry.label).toBeTruthy();
    }
    expect(VERSION_DIFF_LEGEND.map((e) => e.change)).toEqual(['removed', 'added', 'unchanged']);
    expect(VERSION_CANVAS_LEGEND).toHaveLength(4);
  });

  it('words the canvas legend by side, as the mockup words it', () => {
    const byChange = new Map(VERSION_CANVAS_LEGEND.map((e) => [e.change, e.label]));
    expect(byChange.get('added')).toBe('Added (compare side)');
    expect(byChange.get('removed')).toBe('Removed (base side)');
  });

  it('classifies a jsdiff hunk into exactly one class', () => {
    expect(diffPartChange({ added: true })).toBe('added');
    expect(diffPartChange({ removed: true })).toBe('removed');
    expect(diffPartChange({})).toBe('unchanged');
    // Never both; a malformed part still resolves to one class rather than to neither.
    expect(diffPartChange({ added: true, removed: true })).toBe('added');
  });

  it('prefixes only the overlay lines that changed', () => {
    expect(diffLinePrefix('added')).toBe('+ ');
    expect(diffLinePrefix('removed')).toBe('- ');
    expect(diffLinePrefix('unchanged')).toBe('');
    expect(diffLinePrefix('modified')).toBe('');
  });
});

describe('merge resolutions', () => {
  it('names and colours all four, warning only on the unresolved one', () => {
    for (const resolution of MERGE_RESOLUTIONS) {
      expect(MERGE_RESOLUTION_LABEL[resolution]).toBeTruthy();
      expect(MERGE_RESOLUTION_TONE).toHaveProperty(resolution);
    }
    expect(MERGE_RESOLUTION_TONE.unresolved).toBe('warn');
    expect(MERGE_RESOLUTION_TONE.mine).not.toBe('warn');
    expect(MERGE_RESOLUTION_TONE.theirs).not.toBe('warn');
  });

  it('spells out which side "mine" and "theirs" are', () => {
    // The dialog explains the pair once at the top; a row is read far from that sentence.
    expect(MERGE_RESOLUTION_LABEL.mine).toBe('Target (mine)');
    expect(MERGE_RESOLUTION_LABEL.theirs).toBe('Source (theirs)');
  });

  it('unblocks apply only when every path has a resolution', () => {
    expect(mergeConflictsResolved([])).toBe(true);
    expect(mergeConflictsResolved(['mine', 'theirs', 'manual'])).toBe(true);
    expect(mergeConflictsResolved(['mine', 'unresolved'])).toBe(false);
    expect(mergeConflictsResolved(['unresolved'])).toBe(false);
  });
});

describe('compatibility verdicts', () => {
  it('reads the three the API returns, in any case', () => {
    expect(compatVerdict('safe')).toBe('safe');
    expect(compatVerdict('SAFE')).toBe('safe');
    expect(compatVerdict(' Breaking ')).toBe('breaking');
    expect(compatVerdict('warning')).toBe('warning');
  });

  it('treats an unknown or missing word as a warning, never as a green light', () => {
    // A server word this client has not learned must not read as "safe to merge".
    expect(compatVerdict('unknown')).toBe('warning');
    expect(compatVerdict(null)).toBe('warning');
    expect(compatVerdict(undefined)).toBe('warning');
    expect(compatVerdict('')).toBe('warning');
    expect(compatVerdict('something-new-from-the-server')).toBe('warning');
  });

  it('colours breaking as danger and safe as ok', () => {
    expect(COMPAT_VERDICT_TONE.breaking).toBe('danger');
    expect(COMPAT_VERDICT_TONE.safe).toBe('ok');
    expect(COMPAT_VERDICT_TONE.warning).toBe('warn');
  });
});

describe('lint grades and severities', () => {
  it('bands a score the usual way', () => {
    expect(lintGradeForScore(100)).toBe('A');
    expect(lintGradeForScore(90)).toBe('A');
    expect(lintGradeForScore(89)).toBe('B');
    expect(lintGradeForScore(80)).toBe('B');
    expect(lintGradeForScore(79)).toBe('C');
    expect(lintGradeForScore(70)).toBe('C');
    expect(lintGradeForScore(69)).toBe('D');
    expect(lintGradeForScore(60)).toBe('D');
    expect(lintGradeForScore(59)).toBe('F');
    expect(lintGradeForScore(0)).toBe('F');
  });

  it('gives A and B the same pass tone and keeps the five bands distinguishable', () => {
    for (const grade of LINT_GRADES) {
      expect(LINT_GRADE_TONE).toHaveProperty(grade);
    }
    expect(LINT_GRADE_TONE.A).toBe(LINT_GRADE_TONE.B);
    // Four distinct tones over five bands — the letter separates A from B.
    expect(new Set(Object.values(LINT_GRADE_TONE)).size).toBe(4);
  });

  it('writes the chip label as `{grade} · {score}`, or the unscored dash', () => {
    expect(lintBadgeLabel('B', 88)).toBe('B · 88');
    expect(lintBadgeLabel('A', 94.4)).toBe('A · 94');
    expect(lintBadgeLabel(null, null)).toBe('Lint —');
    expect(lintBadgeLabel('B', null)).toBe('Lint —');
    expect(lintBadgeLabel(null, 88)).toBe('Lint —');
    expect(lintBadgeLabel('B', Number.NaN)).toBe('Lint —');
  });

  it('keeps the unscored tooltip the mockup quotes', () => {
    expect(LINT_BADGE_UNSCORED_TITLE).toBe('Not scored yet — click to lint this version');
  });

  it('colours the three severities distinctly', () => {
    expect(LINT_SEVERITIES).toEqual(['error', 'warning', 'info']);
    expect(new Set(LINT_SEVERITIES.map((s) => LINT_SEVERITY_TONE[s])).size).toBe(3);
  });
});

describe('export fidelity', () => {
  it('buckets a preserved-percentage at the registry cuts', () => {
    expect(fidelityBucket(100)).toBe('lossless');
    expect(fidelityBucket(85)).toBe('lossless');
    expect(fidelityBucket(84)).toBe('lossy');
    expect(fidelityBucket(50)).toBe('lossy');
    expect(fidelityBucket(49)).toBe('types-only');
    expect(fidelityBucket(0)).toBe('types-only');
  });

  it('words and colours all three buckets distinctly', () => {
    for (const bucket of FIDELITY_BUCKETS) {
      expect(FIDELITY_BUCKET_LABEL[bucket]).toBeTruthy();
      expect(FIDELITY_BUCKET_TONE).toHaveProperty(bucket);
    }
    expect(new Set(Object.values(FIDELITY_BUCKET_TONE)).size).toBe(3);
  });

  it('hands the projection graph a token reference per outcome', () => {
    for (const outcome of PROJECTION_OUTCOMES) {
      expect(projectionNodeStrokeVar(outcome)).toMatch(TOKEN_REFERENCE);
      expect(PROJECTION_OUTCOME_TONE).toHaveProperty(outcome);
    }
    expect(projectionNodeStrokeVar('dropped')).toBe('var(--danger)');
    expect(projectionNodeStrokeVar('clean')).toBe('var(--ok)');
  });
});

describe('test bench verdicts', () => {
  it('words a verdict the way a run history does, not the way a validator does', () => {
    expect(BENCH_VERDICT_LABEL.valid).toBe('passed');
    expect(BENCH_VERDICT_LABEL.invalid).toBe('failed');
    expect(BENCH_VERDICT_LABEL.error).toBe('error');
    for (const verdict of BENCH_VERDICTS) {
      expect(BENCH_VERDICT_TONE).toHaveProperty(verdict);
    }
  });

  it('calls only a pass-then-fail a regression', () => {
    expect(benchPayloadRegressed('valid', 'invalid')).toBe(true);
    expect(benchPayloadRegressed('invalid', 'invalid')).toBe(false);
    expect(benchPayloadRegressed('valid', 'valid')).toBe(false);
    expect(benchPayloadRegressed(null, 'invalid')).toBe(false);
    expect(benchPayloadRegressed(undefined, 'invalid')).toBe(false);
  });

  it('does not call an unavailable validator a regression', () => {
    // `error` says the check could not run — it says nothing about the schema, and flagging
    // it would turn a flaky validator into a red badge on a healthy version.
    expect(benchPayloadRegressed('valid', 'error')).toBe(false);
    expect(benchPayloadRegressed('error', 'invalid')).toBe(false);
  });

  it('labels the verdict diff the way the mockup does', () => {
    expect(BENCH_REGRESSION_LABEL).toBe('passed → failed');
  });
});

describe('the copy the mockup quotes verbatim', () => {
  it('carries every state string as a non-empty sentence', () => {
    for (const [key, value] of Object.entries(VERSION_DIALOG_COPY)) {
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
      expect(key).toMatch(/^[a-zA-Z]+$/);
    }
  });

  it('keeps the empty and loading copy the AC names', () => {
    expect(VERSION_DIALOG_COPY.canvasLoading).toBe('Loading canvas layouts…');
    expect(VERSION_DIALOG_COPY.canvasEmpty).toContain('No saved canvas layout for this revision');
    expect(VERSION_DIALOG_COPY.historyEmpty).toBe('No revisions to graph.');
    expect(VERSION_DIALOG_COPY.lintUnavailable).toBe('Lint report unavailable.');
    expect(VERSION_DIALOG_COPY.compatNoFindings).toBe('No structural findings in this report.');
    expect(VERSION_DIALOG_COPY.benchNoSuites).toContain('No test suites for this artifact yet');
    expect(VERSION_DIALOG_COPY.exportMeasuring).toBe(
      'Measuring export fidelity for this version…'
    );
    expect(VERSION_DIALOG_COPY.exportNoRecent).toBe('No exports of this version yet.');
  });

  it('uses the typographic ellipsis and em dash the design language uses', () => {
    // Three dots and a hyphen are a different typeface's punctuation; DESIGN.md §3.2 spends
    // the real characters, and a mixed page reads as two products.
    for (const value of Object.values(VERSION_DIALOG_COPY)) {
      expect(value).not.toContain('...');
      expect(value).not.toMatch(/\s-\s/);
    }
  });
});
