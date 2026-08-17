/**
 * The guide set and the search over it (HIVE-4.9, #5303).
 *
 * Two questions, and the first is the one that keeps the page honest:
 *
 *   1. **Does the catalog still describe `docs/guide`?** The listing is compiled into the
 *      bundle rather than read from disk (see `helpCatalog.ts`), which buys an instant,
 *      offline search at the cost of a listing that can fall behind the directory. So this
 *      suite reads the real directory and fails when a guide is missing from the catalog, or
 *      when the catalog names a page that no longer exists. That is the ticket's *"guide
 *      search returns results and links out correctly"* reduced to something a test can hold.
 *   2. **Does a search behave like a search?** Terms narrow rather than widen, the ranking is
 *      stable, a task word finds the page that answers it, and a query that matches nothing
 *      says so rather than falling back to everything.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  GUIDE_ENTRIES,
  GUIDE_QUERY_MIN_LENGTH,
  GUIDE_RESULT_LIMIT,
  GUIDE_SECTION_LABELS,
  guideHref,
  searchGuides,
  type GuideEntry,
} from '@/app/components/ade/help/helpCatalog';

/** The repository root, two levels above this package's `tests` directory. */
const REPO_ROOT = join(__dirname, '..', '..');

/** The guide directory the catalog claims to describe. */
const GUIDE_DIR = join(REPO_ROOT, 'docs', 'guide');

/** Every markdown file in `docs/guide`, by basename. */
const GUIDE_FILES = readdirSync(GUIDE_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort();

/**
 * Find one entry by id.
 *
 * @param id The entry's id, which is also its file's basename.
 * @returns The entry.
 */
function entry(id: string): GuideEntry {
  const found = GUIDE_ENTRIES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`The guide catalog has no entry \`${id}\``);
  return found;
}

/**
 * The ids a query returns, in order.
 *
 * @param query What a reader typed.
 * @returns The matching ids, best match first.
 */
function ids(query: string): string[] {
  return searchGuides(query).map((result) => result.id);
}

/* -------------------------------------------------------------------------
   1. The catalog still describes the directory
   ------------------------------------------------------------------------- */

describe('the guide catalog', () => {
  it('has an entry for every markdown file in docs/guide', () => {
    const catalogued = GUIDE_ENTRIES.map((guide) => `${guide.id}.md`).sort();
    expect(catalogued).toEqual(GUIDE_FILES);
  });

  it('names only pages that exist on disk', () => {
    const missing = GUIDE_ENTRIES.filter((guide) => !existsSync(join(REPO_ROOT, guide.page)));
    expect(missing.map((guide) => guide.page)).toEqual([]);
  });

  it('derives every page path from the entry id, so the two cannot drift', () => {
    for (const guide of GUIDE_ENTRIES) {
      expect(guide.page).toBe(`docs/guide/${guide.id}.md`);
    }
  });

  it('gives every entry a unique id', () => {
    expect(new Set(GUIDE_ENTRIES.map((guide) => guide.id)).size).toBe(GUIDE_ENTRIES.length);
  });

  it('gives every entry a title, a summary and at least one keyword', () => {
    for (const guide of GUIDE_ENTRIES) {
      expect(guide.title.trim().length).toBeGreaterThan(0);
      expect(guide.summary.trim().length).toBeGreaterThan(0);
      expect(guide.keywords.length).toBeGreaterThan(0);
    }
  });

  it('sorts every entry into one of the two sections the guide index has', () => {
    for (const guide of GUIDE_ENTRIES) {
      expect(GUIDE_SECTION_LABELS[guide.section]).toBeTruthy();
    }
    // Both sections are populated: a label nothing uses is a label that goes stale unnoticed.
    expect(new Set(GUIDE_ENTRIES.map((guide) => guide.section))).toEqual(
      new Set(['spine', 'reference'])
    );
  });

  it('spends no keyword on a word the title already carries', () => {
    // A duplicate would score twice for the same reason and quietly out-rank a better match.
    const offenders = GUIDE_ENTRIES.map((guide) => ({
      id: guide.id,
      redundant: guide.keywords.filter((keyword) =>
        guide.title.toLowerCase().includes(keyword.toLowerCase())
      ),
    })).filter((guide) => guide.redundant.length > 0);
    expect(offenders).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. Where a result goes
   ------------------------------------------------------------------------- */

describe('guideHref', () => {
  it('links out to the page on the default branch', () => {
    expect(guideHref(entry('import-a-spec'))).toBe(
      'https://github.com/apiome/apiome/blob/main/docs/guide/import-a-spec.md'
    );
  });

  it('builds an absolute URL for every entry', () => {
    for (const guide of GUIDE_ENTRIES) {
      expect(guideHref(guide)).toMatch(/^https:\/\/github\.com\/apiome\/apiome\/blob\/main\/docs\//);
    }
  });
});

/* -------------------------------------------------------------------------
   3. The search behaves like a search
   ------------------------------------------------------------------------- */

describe('searchGuides', () => {
  it('returns nothing until the query is long enough to mean something', () => {
    expect(searchGuides('')).toEqual([]);
    expect(searchGuides('p')).toEqual([]);
    expect(searchGuides('   ')).toEqual([]);
    expect('p'.length).toBeLessThan(GUIDE_QUERY_MIN_LENGTH);
  });

  it('finds the page that answers a task word, first', () => {
    expect(ids('publish')[0]).toBe('publish-a-version');
    expect(ids('import')[0]).toBe('import-a-spec');
  });

  it('matches a keyword the title never mentions', () => {
    // The X12 and copybook vocabulary is in the guide, not in its title.
    expect(ids('x12')).toContain('catalog-format-details');
    expect(ids('owasp')).toContain('mcp-trust-posture-rules');
    expect(ids('gitlab')).toContain('ci-gitlab-bitbucket');
  });

  it('narrows on a second term instead of widening', () => {
    const single = ids('mock');
    const pair = ids('mock fixture');
    expect(single.length).toBeGreaterThan(pair.length);
    expect(pair).toEqual(['mock-fixture-packs']);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(ids('  PUBLISH  ')).toEqual(ids('publish'));
  });

  it('returns nothing at all when no guide matches', () => {
    expect(searchGuides('kubernetes helm chart')).toEqual([]);
  });

  it('never returns more than the result limit', () => {
    // `a` appears in nearly every summary, so this is the widest query the set can take.
    expect(searchGuides('ap').length).toBeLessThanOrEqual(GUIDE_RESULT_LIMIT);
  });

  it('is stable: the same query returns the same list', () => {
    expect(ids('version')).toEqual(ids('version'));
  });

  it('searches whatever set it is given, so the ranking can be tested in isolation', () => {
    const custom: GuideEntry[] = [
      {
        id: 'summary-hit',
        title: 'Something else',
        summary: 'Mentions widgets in passing.',
        page: 'docs/guide/summary-hit.md',
        section: 'reference',
        keywords: [],
      },
      {
        id: 'title-hit',
        title: 'Widgets',
        summary: 'The page about them.',
        page: 'docs/guide/title-hit.md',
        section: 'spine',
        keywords: [],
      },
    ];
    // A title hit outranks a summary hit even when the summary entry is listed first.
    expect(searchGuides('widgets', custom).map((result) => result.id)).toEqual([
      'title-hit',
      'summary-hit',
    ]);
  });
});
