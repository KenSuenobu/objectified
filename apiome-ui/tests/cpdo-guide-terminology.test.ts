/**
 * CPDO user-guide <-> UI terminology contract — CPDO-4.3 (#4806).
 *
 * The guides at `docs/guide/catalog-format-details.md` and
 * `docs/guide/convert-to-openapi.md` promise that their vocabulary matches what the UI
 * actually renders. This test reads the guides and asserts every reviewed UI label —
 * analysis statuses, value-visibility levels, projection-graph statuses with their
 * symbols, and the graph's lane labels — appears in the documentation verbatim. Renaming
 * a label in the UI without updating the guide (or vice versa) goes red here; the
 * REST-side twin is `apiome-rest/tests/test_cpdo_docs_guide.py`.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  ANALYSIS_STATUSES,
  VALUE_VISIBILITIES,
  analysisStatusPresentation,
} from '../src/app/utils/catalog-payload-analysis';
import { CONVERSION_PROJECTION_STATUSES } from '../src/app/utils/conversion-projection';
import {
  CONVERSION_LANES,
  CONVERSION_SCOPE_LABEL,
  conversionStatusPresentation,
} from '../src/app/components/ade/dashboard/catalog/conversionProjectionGraph';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GUIDE_DIR = path.join(REPO_ROOT, 'docs', 'guide');

function readGuide(name: string): string {
  const file = path.join(GUIDE_DIR, name);
  expect(fs.existsSync(file)).toBe(true);
  return fs.readFileSync(file, 'utf-8');
}

describe('CPDO guide <-> UI terminology (format details)', () => {
  const guide = readGuide('catalog-format-details.md');

  it('documents every analysis status under its UI label', () => {
    for (const status of ANALYSIS_STATUSES) {
      expect(guide).toContain(`\`${status}\``);
      expect(guide).toContain(analysisStatusPresentation(status).label);
    }
  });

  it('documents every value-visibility level', () => {
    for (const visibility of VALUE_VISIBILITIES) {
      expect(guide).toContain(`\`${visibility}\``);
    }
  });
});

describe('CPDO guide <-> UI terminology (conversion projection)', () => {
  const guide = readGuide('convert-to-openapi.md');

  it('documents every projection status under its UI label and symbol', () => {
    for (const status of CONVERSION_PROJECTION_STATUSES) {
      const presentation = conversionStatusPresentation(status);
      expect(guide).toContain(`\`${status}\``);
      expect(guide).toContain(presentation.label);
      expect(guide).toContain(presentation.symbol);
    }
  });

  it('documents every graph lane under its UI label', () => {
    for (const lane of CONVERSION_LANES) {
      expect(guide).toContain(lane.label);
    }
  });

  it('documents every evidence scope', () => {
    for (const scope of Object.keys(CONVERSION_SCOPE_LABEL)) {
      expect(guide).toContain(`\`${scope}\``);
    }
  });
});

describe('CPDO guide index', () => {
  it('links both pages from the guide index', () => {
    const index = readGuide('README.md');
    expect(index).toContain('(catalog-format-details.md)');
    expect(index).toContain('(convert-to-openapi.md)');
  });
});
