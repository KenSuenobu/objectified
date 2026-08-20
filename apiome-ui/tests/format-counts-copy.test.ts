/**
 * The app's format-count copy (FMT-1.6, #5417).
 *
 * The guide-search catalog used to advertise "40+ formats". The number was right when it was typed
 * and had no way of noticing when it stopped being. These tests pin the copy to `FORMAT_COUNTS` —
 * the module `apiome-rest/src/app/format_counts.py` generates from the adapter registries — so a
 * literal typed back into a summary fails here, and a registry that grows moves the assertion with
 * it.
 *
 * The generated module itself is drift-checked in `apiome-rest/tests/test_format_counts.py`; what
 * is checked here is that the app *uses* it.
 */

import { GUIDE_ENTRIES } from '@/app/components/ade/help/helpCatalog';
import { FORMAT_COUNTS, FORMAT_PARADIGMS } from '@/app/generated/formatCounts';

/** The shape of a hand-typed claim: a whole number, optionally a `+`, then "format"/"formats". */
const HAND_TYPED_COUNT = /(?<![\d.])\d+\s*\+?[\s -]*(?:api[\s-]+)?(?:description[\s-]+)?formats?\b/i;

describe('FORMAT_COUNTS', () => {
  it('carries the canonical paradigm vocabulary, in canonical order', () => {
    expect(FORMAT_PARADIGMS.map((paradigm) => paradigm.id)).toEqual([
      'rest',
      'rpc',
      'event',
      'graph',
      'data_schema',
      'agent',
    ]);
  });

  it('describes a surface far wider than the four formats the guides once claimed', () => {
    expect(FORMAT_COUNTS.importable).toBeGreaterThan(4);
    expect(FORMAT_COUNTS.exportable).toBeGreaterThan(0);
  });

  it('splits every importable format between the two importers', () => {
    expect(FORMAT_COUNTS.publishable + FORMAT_COUNTS.catalog).toBe(FORMAT_COUNTS.importable);
  });

  it('breaks the total down across the paradigms without losing a format', () => {
    const summed = FORMAT_PARADIGMS.reduce((running, paradigm) => running + paradigm.total, 0);
    expect(summed).toBe(FORMAT_COUNTS.total);
  });
});

describe('guide catalog copy', () => {
  it('states the measured import count on the import guide', () => {
    const entry = GUIDE_ENTRIES.find((guide) => guide.id === 'import-a-spec');
    expect(entry).toBeDefined();
    expect(entry?.summary).toContain(`${FORMAT_COUNTS.importable} formats`);
  });

  it('never states a format count that was typed rather than measured', () => {
    // The TypeScript half of the guard in `app.format_counts`: a summary is copy a reader sees,
    // so a literal here is exactly the drift this ticket removed.
    const offenders = GUIDE_ENTRIES.filter((guide) => {
      const measured = `${FORMAT_COUNTS.importable} formats`;
      return HAND_TYPED_COUNT.test(guide.summary) && !guide.summary.includes(measured);
    }).map((guide) => `${guide.id}: ${guide.summary}`);
    expect(offenders).toEqual([]);
  });
});
