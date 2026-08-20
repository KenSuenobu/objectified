import { describe, expect, it } from 'vitest';
import { FORMAT_COUNTS, FORMAT_PARADIGMS } from '../generated/formatCounts';
import {
  SUPPORTED_FORMATS_DOC_URL,
  describeFormatSurface,
  describeParadigms,
} from '../formatSurface';

/**
 * The portal's format claims (FMT-1.6, #5417).
 *
 * The point of these is not that the sentences read well — it is that no number in them was typed
 * by a person. Each test pins the copy to `FORMAT_COUNTS`, so the day the registry gains an adapter
 * the assertions move with it and a stale literal cannot pass.
 */

describe('describeFormatSurface', () => {
  it('states the measured import and export counts', () => {
    expect(describeFormatSurface()).toBe(
      `${FORMAT_COUNTS.importable} formats in, ${FORMAT_COUNTS.exportable} out — any-to-any`
    );
  });

  it('reads the counts it is given rather than a baked-in number', () => {
    const measured = { ...FORMAT_COUNTS, importable: 101, exportable: 99 };
    expect(describeFormatSurface(measured)).toBe('101 formats in, 99 out — any-to-any');
  });

  it('never claims to export more than it imports on the shipped counts', () => {
    // Not a law of the module — a sanity check on the projection, since every emitter in the
    // registry today has a reading adapter behind it.
    expect(FORMAT_COUNTS.exportable).toBeLessThanOrEqual(FORMAT_COUNTS.importable);
  });
});

describe('describeParadigms', () => {
  it('names every canonical paradigm, in canonical order', () => {
    const sentence = describeParadigms();
    for (const paradigm of FORMAT_PARADIGMS) {
      expect(sentence).toContain(paradigm.label);
    }
    expect(sentence.startsWith(FORMAT_PARADIGMS[0].label)).toBe(true);
    expect(sentence.endsWith(FORMAT_PARADIGMS[FORMAT_PARADIGMS.length - 1].label)).toBe(true);
  });

  it('joins with a comma list and a final "and"', () => {
    expect(describeParadigms([{ label: 'REST' }, { label: 'RPC' }, { label: 'Graph' }])).toBe(
      'REST, RPC and Graph'
    );
  });

  it('handles a one-item and an empty vocabulary', () => {
    expect(describeParadigms([{ label: 'REST' }])).toBe('REST');
    expect(describeParadigms([])).toBe('');
  });
});

describe('SUPPORTED_FORMATS_DOC_URL', () => {
  it('points at the generated reference page over an absolute URL', () => {
    // Relative would 404: the portal image ships the app, not the repository's docs tree.
    expect(SUPPORTED_FORMATS_DOC_URL.startsWith('https://')).toBe(true);
    expect(SUPPORTED_FORMATS_DOC_URL.endsWith('docs/guide/supported-formats.md')).toBe(true);
  });
});
