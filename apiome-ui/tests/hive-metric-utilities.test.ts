/**
 * Control, row and page metrics, and the utilities that spend them (HIVE-1.6, #5279).
 *
 * HIVE-1.3 landed the density preference as a token swap, but nothing read the tokens, so
 * choosing Compact changed a stored string and nothing on screen. This suite pins the two
 * halves that closed that gap:
 *
 *   • every metric token is `rem`, so the font-size preference reaches control and row
 *     heights and not only type — the claim `globals.css` makes in its own comment, and
 *     the thing a frozen `36px` quietly breaks;
 *   • each metric has a class that spends it — a `@utility` for the simple ones, an
 *     unlayered rule for the table rhythm that has to outrank a page's own `py-4` — and
 *     the shared dashboard class module actually uses the page, card and table ones.
 *
 * Read from source: jsdom compiles no stylesheet, and a utility that stops resolving fails
 * by rendering a slightly different size rather than by throwing.
 */

import {
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
  topLevelRules,
} from './helpers/design-tokens';
import {
  dashboardMainClass,
  dashboardPanelPaddedClass,
  dashboardTableWrapClass,
  dashboardThClass,
  dashboardThRightClass,
} from '../src/app/components/ade/dashboard/dashboardScreenClasses';

const css = readGlobalsCss();
const layer = readTokenLayer(css);
const rules = topLevelRules(css);

/** Every metric token the density preference or the font scale has to reach. */
const METRIC_TOKENS = [
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-8',
  '--space-10',
  '--space-12',
  '--control-h',
  '--control-h-sm',
  '--control-h-lg',
  '--row-h',
  '--page-pad',
  '--card-pad',
  '--nav-item-h',
];

/** Utility name → the single token its declaration is expected to spend. */
const UTILITY_TOKEN: Readonly<Record<string, string>> = {
  'h-control': '--control-h',
  'h-control-sm': '--control-h-sm',
  'h-control-lg': '--control-h-lg',
  'h-row': '--row-h',
  'h-nav-item': '--nav-item-h',
  'min-h-control': '--control-h',
  'min-h-nav-item': '--nav-item-h',
  'size-control': '--control-h',
  'p-page': '--page-pad',
  'p-card': '--card-pad',
};

/** The body of the one top-level rule with that prelude. */
function ruleBody(prelude: string): string {
  const matches = rules.filter((rule) => rule.prelude === prelude);
  if (matches.length !== 1) {
    throw new Error(`globals.css has ${matches.length} \`${prelude}\` rules`);
  }
  return matches[0].body;
}

/** The body of the `@utility <name>` rule. */
const utilityBody = (name: string): string => ruleBody(`@utility ${name}`);

describe('every metric is `rem`, so the font scale reaches chrome as well as type', () => {
  it.each(METRIC_TOKENS)('%s is a rem length', (token) => {
    expect(resolveToken(token, layer)).toMatch(/^\d+(\.\d+)?rem$/);
  });

  it('restates them in rem in the compact block too', () => {
    const compact = parseDeclarations(
      rules.filter((rule) => rule.prelude === 'html[data-density="compact"]')[0].body,
    );
    const frozen = [...compact.entries()].filter(([, value]) => !/^\d+(\.\d+)?rem$/.test(value));

    expect(frozen).toEqual([]);
  });

  it('keeps the page and content caps in px: they are measured against the viewport', () => {
    // A cap that grew with the font scale would widen a wide layout past the window and
    // produce the horizontal scrollbar DESIGN.md §5 forbids.
    expect(resolveToken('--page-max', layer)).toBe('1440px');
    expect(resolveToken('--content-max', layer)).toBe('1200px');
  });

  it('derives table cell padding from the row metric rather than stating it twice', () => {
    expect(layer.root.get('--table-cell-pad-y')).toContain('var(--row-h)');
    expect(layer.root.get('--table-head-pad-y')).toContain('var(--table-cell-pad-y)');
  });
});

describe('a utility per metric, reading the token', () => {
  it.each(Object.entries(UTILITY_TOKEN))('%s spends %s', (name, token) => {
    const body = utilityBody(name);

    expect(body).toContain(`var(${token})`);
    // A literal length here is the frozen size coming back in a new spelling.
    expect(body).not.toMatch(/:\s*\d+(\.\d+)?(px|rem)/);
  });

  it('sizes the square icon-button on both axes, so it stays square at every density', () => {
    const body = utilityBody('size-control');

    expect(body).toContain('width: var(--control-h)');
    expect(body).toContain('height: var(--control-h)');
  });

  it('gives table cells their vertical rhythm from the density tokens', () => {
    expect(ruleBody('.table-density :where(thead) :where(th)')).toContain(
      'padding-block: var(--table-head-pad-y)',
    );
    expect(ruleBody('.table-density :where(tbody) :where(td)')).toContain(
      'padding-block: var(--table-cell-pad-y)',
    );
  });

  it('declares the table rhythm unlayered, so it outranks a page-authored py-4', () => {
    // Inside `@layer utilities` this would tie `.py-4` on specificity and lose on source
    // order — Tailwind sorts its own padding utilities last — and no table would tighten.
    const preludes = rules.map((rule) => rule.prelude);

    expect(preludes).toContain('.table-density :where(thead) :where(th)');
    expect(preludes).toContain('.table-density :where(tbody) :where(td)');
    expect(css).not.toContain('@utility table-density');
  });

  it('leaves horizontal padding alone: that is column rhythm, not density', () => {
    expect(ruleBody('.table-density :where(tbody) :where(td)')).not.toContain('padding-inline');
  });
});

describe('the shared dashboard classes spend the metrics', () => {
  it('takes page padding from the density preference', () => {
    expect(dashboardMainClass).toContain('p-page');
    expect(dashboardMainClass).not.toMatch(/\bp-\d/);
  });

  it('takes card padding from the density preference', () => {
    expect(dashboardPanelPaddedClass).toContain('p-card');
    expect(dashboardPanelPaddedClass).not.toMatch(/\bp-\d/);
  });

  it('opts every dashboard table into the density rhythm from its one wrapper', () => {
    expect(dashboardTableWrapClass).toContain('table-density');
  });

  it('stops freezing the header strip with py-3, which the wrapper now owns', () => {
    for (const cls of [dashboardThClass, dashboardThRightClass]) {
      expect(cls).not.toMatch(/\bpy-\d/);
      // Horizontal padding is column rhythm and stays with the class.
      expect(cls).toContain('px-6');
    }
  });
});
