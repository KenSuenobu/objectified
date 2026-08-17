/**
 * The pre-Hive chrome stays retired (HIVE-3.8, #5294).
 *
 * Epic 3 replaced two navigation systems with one: `AppShell` draws a rail beside the page
 * and nothing above it, and #5294 deleted what it replaced — `TopHeader`, the
 * `ConditionalHeader` that arbitrated between the two, `SuiteNavMenu` (the header's
 * cross-product dropdown) and `DashboardSideNav`. The issue's stated risk is that the old
 * chrome "must not linger behind a flag: two navigation systems would double-render and
 * drift", so the deletion needs a guard rather than a changelog entry: a re-added import is
 * the cheap mistake, and it would not fail any other suite.
 *
 * This is a source-text scan on purpose. Nothing renders these components any more, so no
 * behavioural suite can notice them coming back.
 *
 * Where the header actually went: the commercial Studio still needs a global bar and is
 * deliberately outside the Hive redesign, so `TopHeader`/`SuiteNavMenu` were relocated into
 * `private-suite/designer/src/shell/` and are that repository's to maintain. What must not
 * come back is a *platform* copy.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_ROOT = join(__dirname, '..');

/** Modules #5294 deleted, relative to the package root. */
const RETIRED_MODULES: readonly string[] = [
  'src/app/components/ade/TopHeader.tsx',
  'src/app/components/ade/ConditionalHeader.tsx',
  'src/app/components/ade/SuiteNavMenu.tsx',
  'src/app/components/ade/dashboard/DashboardSideNav.tsx',
  // Existed only to clear the retired 48px bar; it measures from a header this package no
  // longer has, and moved to the Studio with it.
  'src/app/ade/constants/subheader-layout.ts',
];

/**
 * Import specifiers that would pull a retired module back in.
 *
 * Matched against the specifier only, so prose naming the old chrome — the history in
 * `AppShell`'s docblock, this file's own list — is not an offence. Only an actual
 * `from '…/TopHeader'` is.
 */
const RETIRED_SPECIFIER =
  /\bfrom\s+['"][^'"]*\/(TopHeader|ConditionalHeader|SuiteNavMenu|DashboardSideNav|subheader-layout)['"]/;

/** Directories that must not reference the retired chrome. */
const SCANNED_DIRS: readonly string[] = ['src', 'lib', 'tests', 'e2e'];

const SCANNED_EXTENSIONS = /\.(ts|tsx)$/;

/**
 * Every TypeScript source file under a directory, recursively.
 *
 * @param dir Absolute directory to walk.
 * @returns Absolute paths of every `.ts`/`.tsx` file beneath it.
 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (SCANNED_EXTENSIONS.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every file the scan answers for — this one excepted.
 *
 * Self-exclusion, not an escape hatch: the cases below have to quote the specifier shape they
 * forbid in order to explain themselves, and a guard that fails on its own documentation is a
 * guard nobody keeps.
 */
const SCANNED_FILES = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir))).filter(
  (file) => file !== join(APP_ROOT, 'tests', 'ade-chrome-retired.test.ts')
);

describe('the pre-Hive chrome is gone (HIVE-3.8, #5294)', () => {
  it('finds the files to check', () => {
    // Guards the guard: a walker that returned nothing would make every case below vacuous.
    expect(SCANNED_FILES.length).toBeGreaterThan(500);
  });

  it.each(RETIRED_MODULES)('%s no longer exists', (module) => {
    expect(() => readFileSync(join(APP_ROOT, module), 'utf8')).toThrow();
  });

  it('imports none of them from anywhere in the package', () => {
    const offenders = SCANNED_FILES.filter((file) =>
      RETIRED_SPECIFIER.test(readFileSync(file, 'utf8'))
    ).map((file) => file.slice(APP_ROOT.length + 1));

    expect(offenders).toEqual([]);
  });

  it('drops the side nav width token and its utility from globals.css', () => {
    // `--sidenav-w` froze the old 280px column. `tests/hive-metric-utilities.test.ts` asserts
    // every *listed* metric token has a `@utility` spending it, which cannot notice a token
    // that has been removed from both — so the removal is pinned here instead.
    const css = readFileSync(join(APP_ROOT, 'src/app/globals.css'), 'utf8');

    expect(css).not.toContain('--sidenav-w');
    expect(css).not.toContain('w-sidenav');
  });

  it('leaves no route reserving space for the 48px bar', () => {
    // Tools drew its toolbar `position: fixed; top: 48` and sized its column
    // `calc(100vh - 48px)` to clear a header that no longer renders. Both are now in normal
    // flow inside `AppShell`'s `<main>`; a re-appearance would push the page down by a bar
    // that is not there. Comments are stripped — the layouts explain the change by name.
    const offenders = SCANNED_FILES.filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      return /calc\(100vh\s*-\s*48px\)/.test(code) || /top:\s*48\b/.test(code);
    }).map((file) => file.slice(APP_ROOT.length + 1));

    expect(offenders).toEqual([]);
  });
});
