/**
 * The stylesheet half of the application shell (HIVE-3.1, #5287).
 *
 * The rail's collapse is CSS, not React state: `globals.css` swaps a handful of custom
 * properties from `html[data-rail="collapsed"]` **and** from a 900 px media query, and the
 * rail's rows read them. That is what makes the icon rail appear before first paint and
 * makes the responsive rule work with no JavaScript at all — and it is also the one part
 * of the shell a jsdom render cannot see, because Jest applies no stylesheet.
 *
 * So this suite reads `globals.css` itself and pins the contract:
 *
 *   1. Every icon-mode property has an expanded default, so nothing inherits by accident.
 *   2. The attribute block and the media block declare *the same* properties, with the
 *      same values — the duplication the comment in `globals.css` warns about.
 *   3. The breakpoint in CSS is the breakpoint `useIconRail` asks `matchMedia` about.
 *   4. The rows that consume the properties are unlayered, so a Tailwind utility on the
 *      same element cannot re-show a label the collapsed rail has hidden.
 */

import {
  parseDeclarations,
  readGlobalsCss,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';
import { RAIL_ICON_BREAKPOINT_PX } from '../src/app/components/shell/useIconRail';

/** The properties that, between them, describe "the rail is icon-only". */
const ICON_MODE_PROPERTIES = [
  '--rail-w-current',
  '--rail-label-display',
  '--rail-item-justify',
  '--rail-group-border',
  '--rail-group-gap',
  '--rail-handle-opacity',
] as const;

const css = readGlobalsCss();
const rules = topLevelRules(css);

/**
 * The one top-level rule with this prelude.
 *
 * @param prelude Exact prelude, whitespace-collapsed.
 * @returns The rule.
 * @throws When the stylesheet has none, or more than one.
 */
function ruleFor(prelude: string): CssRule {
  const matches = rules.filter((rule) => rule.prelude === prelude);
  if (matches.length !== 1) {
    throw new Error(`globals.css has ${matches.length} \`${prelude}\` rules; expected exactly 1`);
  }
  return matches[0];
}

/** The bare `html` rule that declares the shell's defaults (there are several `html` rules). */
const expandedRule = rules.find(
  (rule) => rule.prelude === 'html' && rule.body.includes('--rail-w-current')
)!;

/** The preference-driven collapse. */
const collapsedRule = ruleFor('html[data-rail="collapsed"]');

/** The viewport-driven collapse: the `html` rule nested in the responsive media query. */
const responsiveMedia = ruleFor(`@media (max-width: ${RAIL_ICON_BREAKPOINT_PX}px)`);
const responsiveRule = topLevelRules(responsiveMedia.body).find((rule) => rule.prelude === 'html')!;

describe('the icon-mode vocabulary', () => {
  it('declares an expanded default for every property', () => {
    expect(expandedRule).toBeDefined();
    const declared = parseDeclarations(expandedRule.body);

    for (const property of ICON_MODE_PROPERTIES) {
      expect(declared.has(property)).toBe(true);
    }
  });

  it('collapses the rail to the collapsed width token, never to a literal', () => {
    const collapsed = parseDeclarations(collapsedRule.body);

    expect(parseDeclarations(expandedRule.body).get('--rail-w-current')).toBe('var(--rail-w)');
    expect(collapsed.get('--rail-w-current')).toBe('var(--rail-w-collapsed)');
    expect(collapsed.get('--rail-label-display')).toBe('none');
  });

  it('says exactly the same thing in the attribute block and the media block', () => {
    expect(responsiveRule).toBeDefined();
    const collapsed = parseDeclarations(collapsedRule.body);
    const responsive = parseDeclarations(responsiveRule.body);

    expect([...responsive.keys()].sort()).toEqual([...collapsed.keys()].sort());
    for (const [property, value] of collapsed) {
      expect(responsive.get(property)).toBe(value);
    }
  });

  it('forces icon mode at the breakpoint the hook watches', () => {
    // `ruleFor` above already proves the media query exists at exactly this width; this
    // states the reason it matters, so a changed breakpoint fails with the right message.
    expect(responsiveMedia.prelude).toContain(`${RAIL_ICON_BREAKPOINT_PX}px`);
  });
});

describe('the shell grid', () => {
  it('lays out the rail from the live width, and lets the page column shrink', () => {
    const shell = parseDeclarations(ruleFor('.hive-shell').body);

    expect(shell.get('display')).toBe('grid');
    expect(shell.get('grid-template-columns')).toBe('var(--rail-w-current) minmax(0, 1fr)');
  });

  it('animates the collapse over the design language\'s slow duration', () => {
    const shell = parseDeclarations(ruleFor('.hive-shell').body);

    expect(shell.get('transition')).toContain('grid-template-columns');
    expect(shell.get('transition')).toContain('var(--dur-slow)');
  });
});

describe('the rows that read the vocabulary', () => {
  it.each([
    ['.rail-label', 'display', '--rail-label-display'],
    ['.rail-item', 'justify-content', '--rail-item-justify'],
    ['.rail .brand-lockup__text', 'display', '--rail-label-display'],
    ['.rail-handle', 'opacity', '--rail-handle-opacity'],
  ])('%s takes its %s from %s', (prelude, property, token) => {
    expect(parseDeclarations(ruleFor(prelude).body).get(property)).toBe(`var(${token})`);
  });

  it('separates the runs with a hairline only when the headings are gone', () => {
    const group = parseDeclarations(ruleFor('.rail-group + .rail-group').body);

    expect(group.get('border-top')).toBe('var(--rail-group-border)');
    expect(group.get('padding-top')).toBe('var(--rail-group-gap)');
    expect(parseDeclarations(expandedRule.body).get('--rail-group-border')).toBe('0 none');
    expect(parseDeclarations(collapsedRule.body).get('--rail-group-border')).toContain(
      'var(--border)'
    );
  });

  it('keeps every one of them unlayered, where no utility can outrank them', () => {
    // `topLevelRules` does not descend into `@layer`, so finding these at the top level is
    // the proof: an unlayered rule beats every `@layer utilities` class outright.
    for (const prelude of [
      '.rail-label',
      '.rail-item',
      '.rail-group + .rail-group',
      '.rail-handle',
      '.hive-shell',
    ]) {
      expect(rules.some((rule) => rule.prelude === prelude)).toBe(true);
    }
  });

  it('reveals the collapse handle on hover and on keyboard focus', () => {
    const revealed = rules.find((rule) => rule.prelude.includes('.rail-handle:focus-visible'))!;

    expect(revealed).toBeDefined();
    expect(revealed.prelude).toContain('.rail:hover .rail-handle');
    expect(parseDeclarations(revealed.body).get('opacity')).toBe('1');
  });
});
