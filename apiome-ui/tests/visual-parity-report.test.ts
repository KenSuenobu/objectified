/**
 * What the harness publishes (HIVE-10.1, #5337).
 *
 * #5337 asks for a report artefact "so reviewers can eyeball the diff", and for CI to publish
 * the diff images. Both are built as strings and files by `report.ts` and `support/artefacts.ts`,
 * which is what lets this suite assert what a reviewer will actually see without opening a
 * browser: that every measured route is listed, that a failure is marked as one, that the
 * three images are referenced by the names they were written under, and that text coming out
 * of a mockup path or a detail line cannot break out of the markup it is placed in.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parityMarkdownSummary, parityReportHtml, type RouteArtefact } from '../e2e/visual/report';
import { DIMENSION_LABELS, type ParityReport } from '../e2e/visual/score';
import {
  REPORT_ROOT,
  readRouteArtefacts,
  themeDir,
  writeRouteArtefact,
} from '../e2e/visual/support/artefacts';

/** The theme directory this suite writes into; removed again when it finishes. */
const TEST_THEME = '__jest__';

/**
 * A verdict, with only the parts a test cares about spelled out.
 *
 * @param overrides The parts this test is about.
 * @returns A complete report.
 */
function report(overrides: Partial<ParityReport> = {}): ParityReport {
  return {
    id: 'published',
    mockup: 'ship/published.html',
    subject: 'hive-published/table.html',
    score: 0.9812,
    gate: 0.95,
    passed: true,
    dimensions: [
      { id: 'tokens', label: DIMENSION_LABELS.tokens, weight: 0.15, score: 1, detail: [] },
      {
        id: 'spacing',
        label: DIMENSION_LABELS.spacing,
        weight: 0.2,
        score: 0.9,
        detail: ['padding: values the mockup never uses: 40 px (5.0 %)'],
      },
    ],
    notes: ['tables: app 1 (6 columns), mockup 1 (6 columns) — not scored'],
    ...overrides,
  };
}

/** One route's artefact, images included. */
function artefact(overrides: Partial<ParityReport> = {}): RouteArtefact {
  const value = report(overrides);
  return {
    report: value,
    images: {
      mockup: `${value.id}-mockup.png`,
      app: `${value.id}-app.png`,
      diff: `${value.id}-diff.png`,
    },
  };
}

describe('the report page', () => {
  it('lists every route it was given, with its score and verdict', () => {
    const html = parityReportHtml([
      artefact(),
      artefact({ id: 'catalog', mockup: 'sources/catalog.html', score: 0.91, passed: false }),
    ]);
    expect(html).toContain('published');
    expect(html).toContain('catalog');
    expect(html).toContain('98.1 %');
    expect(html).toContain('91.0 %');
    expect(html).toContain('>PASS<');
    expect(html).toContain('>FAIL<');
    expect(html).toContain('1 of 2 routes clear the gate');
  });

  it('shows each dimension, its weight and what it cost', () => {
    const html = parityReportHtml([artefact()]);
    expect(html).toContain(DIMENSION_LABELS.spacing);
    expect(html).toContain('values the mockup never uses: 40 px');
    expect(html).toContain('not scored');
  });

  it('references all three images by the names they were written under', () => {
    const html = parityReportHtml([artefact()]);
    expect(html).toContain('src="published-mockup.png"');
    expect(html).toContain('src="published-app.png"');
    expect(html).toContain('src="published-diff.png"');
  });

  it('renders a route with no screenshots without an empty image', () => {
    const html = parityReportHtml([{ report: report(), images: null }]);
    expect(html).not.toContain('<img');
    expect(html).toContain('published');
  });

  it('escapes anything that came out of a page, so a detail line cannot break the markup', () => {
    const html = parityReportHtml([
      artefact({ mockup: '<script>alert("x")</script>' }),
    ]);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('carries no external stylesheet, script or image, because CI reads it off a file system', () => {
    const html = parityReportHtml([artefact()]);
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    expect(html).toContain('<style>');
  });

  it('names the theme the run was pinned to', () => {
    expect(parityReportHtml([artefact()], { theme: 'dark' })).toContain('dark theme');
  });
});

describe('the CI summary', () => {
  it('is a Markdown table of every route, marking the failures', () => {
    const markdown = parityMarkdownSummary([
      report(),
      report({ id: 'catalog', score: 0.91, passed: false }),
    ]);
    expect(markdown).toContain('| `published` | 98.1 % | pass |');
    expect(markdown).toContain('| `catalog` | 91.0 % | **fail** |');
    expect(markdown).toContain('1 of 2 routes clear the gate.');
  });
});

describe('the artefacts on disk', () => {
  afterAll(() => {
    fs.rmSync(themeDir(TEST_THEME), { recursive: true, force: true });
  });

  it('writes the verdict and the three images, and reads them back in route order', () => {
    const images = writeRouteArtefact(TEST_THEME, report(), {
      mockup: Buffer.from('mockup-png'),
      app: Buffer.from('app-png'),
      diff: Buffer.from('diff-png'),
    });
    writeRouteArtefact(TEST_THEME, report({ id: 'catalog', passed: false }), null);

    expect(images).toEqual({
      mockup: 'published-mockup.png',
      app: 'published-app.png',
      diff: 'published-diff.png',
    });
    expect(fs.existsSync(path.join(themeDir(TEST_THEME), 'published-diff.png'))).toBe(true);

    const read = readRouteArtefacts(TEST_THEME, ['catalog', 'published', 'not-measured']);
    expect(read.map((entry) => entry.report.id)).toEqual(['catalog', 'published']);
    expect(read[0].images).toBeNull();
    expect(read[1].images?.diff).toBe('published-diff.png');
  });

  it('reads an empty list for a theme that measured nothing', () => {
    expect(readRouteArtefacts('__never-run__', ['published'])).toEqual([]);
  });

  it('publishes inside apiome-ui, where CI collects it from', () => {
    expect(REPORT_ROOT.endsWith(path.join('apiome-ui', 'visual-parity-report'))).toBe(true);
  });
});
