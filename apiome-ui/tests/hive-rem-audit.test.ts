/**
 * The `rem` audit's standing scan (HIVE-1.6, #5279).
 *
 * `eslint-rules/hive.js` catches a frozen size as it is typed. This is the other half:
 * a sweep of the tree as it stands, so the audit is a property of the repository rather
 * than of whoever last ran `yarn lint`. It runs in the ordinary `yarn test` gate, which is
 * where a regression will actually be noticed.
 *
 * It also pins the three *exemptions*, because an exemption nobody can find is how the
 * sweep unravels: each has exactly one module that owns its numbers, and this suite fails
 * if a component starts spelling a size out beside one of them instead.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/** Repository root of `apiome-ui`. */
const APP_ROOT = join(__dirname, '..');

/** The two trees the audit covers — every user-facing surface of the app. */
const SWEPT_DIRS = ['src/app/components', 'src/app/ade'];

/**
 * A Tailwind arbitrary font size with an explicit length.
 *
 * `rem` and `em` are in scope alongside the absolute units: `text-[0.65rem]` scales but is
 * a size *off* the DESIGN.md §3.2 scale, which is the other half of what was swept.
 */
const ARBITRARY_TEXT_SIZE = /\btext-\[\d*\.?\d+(?:px|pt|pc|cm|mm|in|Q|rem|em)\]/g;

/** A `fontSize` whose value is a literal — a bare number, or a string in an absolute unit. */
const LITERAL_FONT_SIZE = /\bfontSize:\s*(?:\d|['"`]\s*\d*\.?\d+(?:px|pt|pc|cm|mm|in|Q)\s*['"`])/g;

/** Every `.ts`/`.tsx` file under `dir`, as repository-relative paths. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (['.ts', '.tsx'].includes(extname(child))) found.push(relative(APP_ROOT, child));
    }
  };
  walk(join(APP_ROOT, dir));
  return found;
}

/** Every swept source file, collected once. */
const SWEPT_FILES = SWEPT_DIRS.flatMap(sourceFiles);

/**
 * Every match of `pattern` across the swept tree, as `path:line  match` strings.
 *
 * Reported as strings rather than counted so a failure names the file and line outright.
 */
function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const path of SWEPT_FILES) {
    const lines = readFileSync(join(APP_ROOT, path), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        hits.push(`${path}:${index + 1}  ${match[0]}`);
      }
    });
  }
  return hits;
}

describe('no frozen type survives in the swept tree', () => {
  it('finds files to scan at all', () => {
    // A refactor that moves or renames a directory would otherwise make this suite pass by
    // scanning nothing.
    expect(SWEPT_FILES.length).toBeGreaterThan(200);
  });

  it('spells no font size as a Tailwind arbitrary value', () => {
    expect(offenders(ARBITRARY_TEXT_SIZE)).toEqual([]);
  });

  it('assigns no literal to `fontSize`', () => {
    expect(offenders(LITERAL_FONT_SIZE)).toEqual([]);
  });

  it('leaves no inline width shadowing the sidebar width token', () => {
    // The literal `width: 280` that used to sit on `DashboardSideNav` beside its class was
    // the widest frozen dimension in the app, and the one the ticket named. Comments are
    // stripped first: the note explaining the removal names the old value.
    const sideNav = readFileSync(
      join(APP_ROOT, 'src/app/components/ade/dashboard/DashboardSideNav.tsx'),
      'utf8',
    );
    const code = sideNav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(sideNav).toContain('w-sidenav');
    expect(code).not.toMatch(/width:\s*280/);
  });
});

describe('each exemption has exactly one module that owns its numbers', () => {
  /**
   * @param moduleSuffix Path suffix of the module allowed to hold the literals.
   * @param constantPattern The exported constants that carry them.
   * @returns Files outside the owning module that state a size the module already owns.
   */
  const strayLiterals = (moduleSuffix: string, constantPattern: RegExp): string[] =>
    SWEPT_FILES.filter((path) => !path.endsWith(moduleSuffix)).filter((path) =>
      constantPattern.test(readFileSync(join(APP_ROOT, path), 'utf8')),
    );

  it('routes Monaco through `ui/code/editorTypography`', () => {
    // Monaco measures glyphs itself and positions lines absolutely, so its options are
    // numbers of CSS pixels; the exemption is real, but it lives in one module.
    expect(strayLiterals('ui/code/editorTypography.ts', /\bCODE_EDITOR_FONT_SIZE\s*=/)).toEqual([]);
    expect(strayLiterals('ui/code/editorTypography.ts', /\bCODE_BLOCK_FONT_SIZE\s*=/)).toEqual([]);
  });

  it('routes SVG-resident text through `ui/svgTypography`', () => {
    expect(strayLiterals('ui/svgTypography.ts', /\bSVG_TEXT_SIZE\s*[:=]\s*\w*\s*\{/)).toEqual([]);
  });

  it('routes react-flow node type through `ade/canvas/canvas-theme`', () => {
    expect(strayLiterals('ade/canvas/canvas-theme.ts', /\bCANVAS_TYPE_SCALE\s*=/)).toEqual([]);
  });

  it('states the exemption in each module, so the reason travels with the numbers', () => {
    for (const path of [
      'src/app/components/ui/code/editorTypography.ts',
      'src/app/components/ui/svgTypography.ts',
      'src/app/components/ade/canvas/canvas-theme.ts',
    ]) {
      expect(readFileSync(join(APP_ROOT, path), 'utf8')).toContain('HIVE-1.6');
    }
  });
});
