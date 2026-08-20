/**
 * The visual-parity route map, checked against the file system (HIVE-10.1, #5337).
 *
 * The harness's coverage is only as honest as this map. Two mistakes would both be silent in
 * a browser run: a pairing that names a mockup or a fixture which no longer exists (the test
 * would fail with a file-system error nobody reads as "the map is stale"), and a mockup that
 * appears in neither the covered list nor the uncovered ledger (the harness would simply not
 * measure it, and nothing would say so).
 *
 * This suite closes both. It is also what makes the ledger a *decision*: a new mockup drawn
 * into `docs/mockups/` fails here until somebody says, in `routes.ts`, whether it is compared
 * and why not if it is not.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PARITY_ROUTES,
  UNCOVERED_MOCKUPS,
  UNCOVERED_REASONS,
  parityRoute,
} from '../e2e/visual/routes';

/** `docs/mockups/`, the read-only source of truth. */
const MOCKUP_ROOT = path.resolve(__dirname, '..', '..', 'docs', 'mockups');

/** `apiome-ui/e2e/fixtures/`, where the page epics dump what their components rendered. */
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'e2e', 'fixtures');

/** Directories under `docs/mockups/` that hold no page mockups. */
const NON_PAGE_DIRECTORIES = new Set(['assets']);

/**
 * Every page mockup on disk, as a path relative to `docs/mockups/`.
 *
 * `index.html` is the navigation page rather than a screen, and `assets/` holds the design
 * system itself, so neither is a candidate for comparison.
 *
 * @returns The sorted list of mockup paths.
 */
function everyMockup(): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(MOCKUP_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || NON_PAGE_DIRECTORIES.has(entry.name)) continue;
    for (const file of fs.readdirSync(path.join(MOCKUP_ROOT, entry.name))) {
      if (file.endsWith('.html')) found.push(`${entry.name}/${file}`);
    }
  }
  return found.sort();
}

describe('the visual-parity route map', () => {
  it('gives every pairing a unique id', () => {
    const ids = PARITY_ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a mockup that exists for every pairing', () => {
    const missing = PARITY_ROUTES.filter(
      (route) => !fs.existsSync(path.join(MOCKUP_ROOT, route.mockup))
    ).map((route) => `${route.id} → ${route.mockup}`);
    expect(missing).toEqual([]);
  });

  it('names a fixture that exists for every fixture-backed pairing', () => {
    const missing = PARITY_ROUTES.filter(
      (route) =>
        route.subject.kind === 'fixture' &&
        !fs.existsSync(path.join(FIXTURE_ROOT, route.subject.dir, route.subject.file))
    ).map((route) => route.id);
    expect(missing).toEqual([]);
  });

  it('pairs each mockup with a fixture that really is a page, not an overlay', () => {
    // The landmark table describes the page shell. A dialog dump has no page chrome at all,
    // so pairing one here would score a page against something that is not one.
    const notPages = PARITY_ROUTES.filter((route) => {
      if (route.subject.kind !== 'fixture') return false;
      const markup = fs.readFileSync(
        path.join(FIXTURE_ROOT, route.subject.dir, route.subject.file),
        'utf8'
      );
      return !markup.trimStart().startsWith('<div class="page"');
    }).map((route) => route.id);
    expect(notPages).toEqual([]);
  });

  it('uses each mockup at most once', () => {
    const mockups = PARITY_ROUTES.map((route) => route.mockup);
    expect(new Set(mockups).size).toBe(mockups.length);
  });

  it('cites a roadmap ticket for every pairing', () => {
    const unattributed = PARITY_ROUTES.filter(
      (route) => !/^HIVE-\d+\.\d+$/.test(route.roadmapRef)
    ).map((route) => route.id);
    expect(unattributed).toEqual([]);
  });

  it('finds every pairing by id, and refuses one it does not have', () => {
    expect(parityRoute('published').mockup).toBe('ship/published.html');
    expect(() => parityRoute('no-such-route')).toThrow(/no route map entry/);
  });
});

describe('the coverage ledger', () => {
  it('accounts for every page mockup, either compared or explained', () => {
    const covered = new Set(PARITY_ROUTES.map((route) => route.mockup));
    const explained = new Set(UNCOVERED_MOCKUPS.map((entry) => entry.mockup));
    const unaccounted = everyMockup().filter(
      (mockup) => !covered.has(mockup) && !explained.has(mockup)
    );
    expect(unaccounted).toEqual([]);
  });

  it('never both compares and excuses the same mockup', () => {
    const covered = new Set(PARITY_ROUTES.map((route) => route.mockup));
    const both = UNCOVERED_MOCKUPS.filter((entry) => covered.has(entry.mockup)).map(
      (entry) => entry.mockup
    );
    expect(both).toEqual([]);
  });

  it('excuses only mockups that exist', () => {
    const missing = UNCOVERED_MOCKUPS.filter(
      (entry) => !fs.existsSync(path.join(MOCKUP_ROOT, entry.mockup))
    ).map((entry) => entry.mockup);
    expect(missing).toEqual([]);
  });

  it('gives every exclusion a reason the harness knows how to explain', () => {
    const unknown = UNCOVERED_MOCKUPS.filter(
      (entry) => !UNCOVERED_REASONS[entry.reason]
    ).map((entry) => entry.mockup);
    expect(unknown).toEqual([]);
  });

  it('lists each excluded mockup once', () => {
    const mockups = UNCOVERED_MOCKUPS.map((entry) => entry.mockup);
    expect(new Set(mockups).size).toBe(mockups.length);
  });
});
