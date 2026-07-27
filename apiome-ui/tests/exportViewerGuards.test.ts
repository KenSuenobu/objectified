/**
 * exportViewerGuards — large-output guards for the export viewer surfaces (MFX-43.5, #4365).
 *
 * Covers the ticket's acceptance surface at the unit level:
 *  1. A file past the per-file cap is never rendered whole — unopened it is deferred, opened it is
 *     an explicitly truncated head slice.
 *  2. A bundle's inline budget is spent in emit order, so the primary file is always admitted and
 *     the overflow loads on demand.
 *  3. Truncation is always accounted for: bytes shown vs bytes that exist, plus the reason.
 *  4. The head slice never cuts a character (and prefers a line boundary).
 */

import {
  describeInlineBudget,
  guardedEditorOptions,
  headSlice,
  planBundleInlineBudget,
  planViewerContent,
  VIEWER_HEAD_PREVIEW_BYTES,
  VIEWER_HEAVY_FEATURE_BYTES,
  VIEWER_INLINE_BUNDLE_BUDGET_BYTES,
  VIEWER_INLINE_FILE_CAP_BYTES,
} from '../src/app/components/ade/dashboard/export/exportViewerGuards';

/** A text of exactly `bytes` ASCII bytes, newline-delimited so line-boundary logic has work to do. */
function textOfBytes(bytes: number): string {
  const line = `${'x'.repeat(63)}\n`; // 64 bytes per line
  return line.repeat(Math.ceil(bytes / 64)).slice(0, bytes);
}

const utf8 = (text: string) => new TextEncoder().encode(text).length;

describe('headSlice — the explicit preview cut (MFX-43.5)', () => {
  it('returns the whole text when it already fits', () => {
    expect(headSlice('syntax = "proto3";', 1024)).toBe('syntax = "proto3";');
  });

  it('cuts to the byte budget', () => {
    const slice = headSlice(textOfBytes(4096), 1024);
    expect(utf8(slice)).toBeLessThanOrEqual(1024);
    expect(slice.length).toBeGreaterThan(0);
  });

  it('prefers a line boundary so the preview never ends mid-line', () => {
    const slice = headSlice(textOfBytes(4096), 1000);
    // 1000 bytes lands mid-line (64-byte lines); the cut backs up to the last newline.
    expect(slice.endsWith('x')).toBe(true);
    expect(utf8(slice)).toBe(960 - 1); // 15 whole lines, minus the trailing newline that was cut
  });

  it('never cuts through a multi-byte character', () => {
    // 'é' is two UTF-8 bytes; a 5-byte budget lands inside the third one.
    const slice = headSlice('ééééé', 5);
    expect(slice).toBe('éé');
    expect(slice).not.toContain('�');
  });

  it('yields nothing for a non-positive budget', () => {
    expect(headSlice('anything', 0)).toBe('');
    expect(headSlice('anything', -10)).toBe('');
  });
});

describe('planViewerContent — what may reach Monaco (MFX-43.5)', () => {
  const small = { text: 'syntax = "proto3";', sizeBytes: 18 };

  it('renders an ordinary file whole', () => {
    const plan = planViewerContent(small);
    expect(plan.mode).toBe('full');
    expect(plan.text).toBe(small.text);
    expect(plan.truncated).toBe(false);
    expect(plan.reason).toBeNull();
    expect(plan.shownBytes).toBe(plan.totalBytes);
  });

  it('defers a file past the per-file cap until the user asks', () => {
    const text = textOfBytes(VIEWER_INLINE_FILE_CAP_BYTES + 1);
    const plan = planViewerContent({ text, sizeBytes: utf8(text) });
    expect(plan.mode).toBe('deferred');
    // Nothing at all goes to the editor — that is what keeps a huge fixture responsive.
    expect(plan.text).toBe('');
    expect(plan.shownBytes).toBe(0);
    expect(plan.truncated).toBe(true);
    expect(plan.reason).toBe('file-cap');
    expect(plan.headOnly).toBe(true);
  });

  it('shows an over-cap file as an explicitly truncated head once asked', () => {
    const text = textOfBytes(VIEWER_INLINE_FILE_CAP_BYTES * 2);
    const plan = planViewerContent({ text, sizeBytes: utf8(text), requested: true });
    expect(plan.mode).toBe('head');
    expect(plan.truncated).toBe(true);
    expect(plan.shownBytes).toBeLessThanOrEqual(VIEWER_HEAD_PREVIEW_BYTES);
    expect(plan.shownBytes).toBeLessThan(plan.totalBytes);
    expect(plan.totalBytes).toBe(utf8(text));
    // Asking again can never promote it to the whole file.
    expect(plan.headOnly).toBe(true);
  });

  it('defers a budget-excluded file, then renders it whole when asked', () => {
    const excluded = { ...small, inlineAllowed: false };
    expect(planViewerContent(excluded).mode).toBe('deferred');
    expect(planViewerContent(excluded).reason).toBe('bundle-budget');
    expect(planViewerContent(excluded).headOnly).toBe(false);

    const opened = planViewerContent({ ...excluded, requested: true });
    expect(opened.mode).toBe('full');
    expect(opened.text).toBe(small.text);
    expect(opened.truncated).toBe(false);
  });

  it('honours injected caps', () => {
    const plan = planViewerContent(
      { text: 'abcdefghij', sizeBytes: 10, requested: true },
      { fileCapBytes: 4, headBytes: 4 },
    );
    expect(plan.mode).toBe('head');
    expect(plan.shownBytes).toBe(4);
    expect(plan.totalBytes).toBe(10);
  });
});

describe('planBundleInlineBudget — the per-bundle inline budget (MFX-43.5)', () => {
  it('admits an ordinary bundle whole', () => {
    const budget = planBundleInlineBudget([
      { path: 'a.proto', sizeBytes: 1_000 },
      { path: 'b.proto', sizeBytes: 2_000 },
    ]);
    expect(budget.deferred).toEqual([]);
    expect(budget.inline.has('a.proto')).toBe(true);
    expect(budget.usedBytes).toBe(3_000);
    expect(budget.budgetBytes).toBe(VIEWER_INLINE_BUNDLE_BUDGET_BYTES);
  });

  it('spends the budget in emit order, so the primary file is always inline', () => {
    const budget = planBundleInlineBudget(
      [
        { path: 'primary.proto', sizeBytes: 60 },
        { path: 'second.proto', sizeBytes: 60 },
        { path: 'third.proto', sizeBytes: 60 },
      ],
      { bundleBudgetBytes: 100 },
    );
    expect(budget.inline.has('primary.proto')).toBe(true);
    expect(budget.deferred).toEqual(['second.proto', 'third.proto']);
    expect(budget.usedBytes).toBe(60);
  });

  it('does not charge an over-cap file to the budget — it defers on its own terms', () => {
    const budget = planBundleInlineBudget(
      [
        { path: 'huge.json', sizeBytes: 5_000 },
        { path: 'small.proto', sizeBytes: 50 },
      ],
      { fileCapBytes: 1_000, bundleBudgetBytes: 1_000 },
    );
    expect(budget.deferred).toContain('huge.json');
    // The small sibling still renders: the giant did not eat the budget on its way to being deferred.
    expect(budget.inline.has('small.proto')).toBe(true);
    expect(budget.usedBytes).toBe(50);
  });

  it('handles an empty bundle without inventing entries', () => {
    const budget = planBundleInlineBudget([]);
    expect(budget.inline.size).toBe(0);
    expect(budget.deferred).toEqual([]);
    expect(budget.usedBytes).toBe(0);
  });
});

describe('describeInlineBudget — saying what is held back (MFX-43.5)', () => {
  it('is silent when every file is inline', () => {
    const budget = planBundleInlineBudget([{ path: 'a.proto', sizeBytes: 10 }]);
    expect(describeInlineBudget(budget, 1)).toBeNull();
  });

  it('states how many of how many load on demand', () => {
    const budget = planBundleInlineBudget(
      [
        { path: 'a.proto', sizeBytes: 60 },
        { path: 'b.proto', sizeBytes: 60 },
        { path: 'c.proto', sizeBytes: 60 },
      ],
      { bundleBudgetBytes: 100 },
    );
    expect(describeInlineBudget(budget, 3)).toContain('2 of 3 files');
  });
});

describe('guardedEditorOptions — feature tuning by size (MFX-43.5)', () => {
  it('keeps the rich features for an ordinary document', () => {
    const options = guardedEditorOptions(1_000);
    expect(options.bracketPairColorization).toEqual({ enabled: true });
    expect(options.occurrencesHighlight).toBe('singleFile');
    expect(options.largeFileOptimizations).toBe(true);
  });

  it('drops the whole-model extras past the heavy threshold', () => {
    const options = guardedEditorOptions(VIEWER_HEAVY_FEATURE_BYTES + 1);
    expect(options.bracketPairColorization).toEqual({ enabled: false });
    expect(options.occurrencesHighlight).toBe('off');
    expect(options.stopRenderingLineAfter).toBe(5_000);
    expect(options.maxTokenizationLineLength).toBe(2_000);
  });

  it('never decides folding — that stays the user’s toggle', () => {
    expect(guardedEditorOptions(10)).not.toHaveProperty('folding');
    expect(guardedEditorOptions(VIEWER_HEAVY_FEATURE_BYTES * 10)).not.toHaveProperty('folding');
  });
});
