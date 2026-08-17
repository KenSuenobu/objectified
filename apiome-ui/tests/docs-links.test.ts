/**
 * The one spelling of a documentation link (HIVE-4.9, #5303).
 *
 * `buildDocsHref` was extracted when the Help & docs page became the third caller that needed
 * a `docs/…` URL — after the lint rule catalog and the governance axis panels, each of which
 * carried its own copy of the base string. Those two keep their own exported builders (their
 * defaults differ) and their own suites; this pins the shared piece, including the two shapes
 * the REST API actually returns a docs path in: with and without a leading slash.
 */

import { GITHUB_DOCS_BASE, buildDocsHref } from '@/app/utils/docsLinks';
import { buildLintRuleDocsHref } from '@/app/utils/lint-rule-catalog';
import { buildGovernanceDocsHref } from '@/app/utils/lint-axis-ui';

describe('buildDocsHref', () => {
  it('hangs a repository-relative path off the default branch', () => {
    expect(buildDocsHref('docs/guide/cli-quickstart.md')).toBe(
      `${GITHUB_DOCS_BASE}docs/guide/cli-quickstart.md`
    );
  });

  it('tolerates the leading slash the API sometimes sends', () => {
    expect(buildDocsHref('/docs/guide/cli-quickstart.md')).toBe(
      buildDocsHref('docs/guide/cli-quickstart.md')
    );
  });

  it('appends an anchor when there is one', () => {
    expect(buildDocsHref('docs/guide/lint-rules.md', 'naming-schema-pascal-case')).toBe(
      `${GITHUB_DOCS_BASE}docs/guide/lint-rules.md#naming-schema-pascal-case`
    );
  });

  it('treats an absent, blank or whitespace-only anchor as no anchor', () => {
    for (const anchor of [undefined, null, '', '   ']) {
      expect(buildDocsHref('docs/guide/lint-rules.md', anchor)).toBe(
        `${GITHUB_DOCS_BASE}docs/guide/lint-rules.md`
      );
    }
  });

  it('is the base both older builders now resolve through', () => {
    // The point of the extraction: one URL to change if the repository ever moves.
    expect(buildLintRuleDocsHref('', '')).toContain(GITHUB_DOCS_BASE);
    expect(buildGovernanceDocsHref(null)).toContain(GITHUB_DOCS_BASE);
  });
});
