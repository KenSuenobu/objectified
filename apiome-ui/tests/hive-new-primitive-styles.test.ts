/**
 * The stylesheet half of the new primitives (HIVE-2.2, #5281).
 *
 * `tests/hive-new-primitives.test.tsx` proves what the components render. jsdom compiles no
 * CSS, so it cannot see the three things that only exist in `globals.css` — and each of them
 * is an acceptance criterion of the ticket:
 *
 *   • the hexagon silhouette an `Avatar shape="hex"` is clipped to;
 *   • the slide-in the drawer animates with, and its duration coming from a token;
 *   • the rule that hides the shortcut chips when "Show keyboard hints" is off.
 *
 * It also pins the two gradient tokens the brand and honey avatars paint from, because a
 * gradient that names a colour outright would not follow the HIVE-1.2 theme swap.
 *
 * Companion to `tests/hive-design-tokens.test.ts` (the token layer),
 * `tests/hive-preference-blocks.test.ts` (the preference blocks) and
 * `tests/hive-primitive-tokens.test.ts` (the HIVE-2.1 control chrome).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import {
  parseDeclarations,
  readGlobalsCss,
  readTokenLayer,
  stripCssComments,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const layer = readTokenLayer(css);

/**
 * Every `.ts`/`.tsx` file under a directory, recursively.
 *
 * @param dir Absolute directory to walk.
 * @returns Absolute paths, in walk order.
 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    if (statSync(child).isDirectory()) found.push(...sourceFiles(child));
    else if (['.ts', '.tsx'].includes(extname(child))) found.push(child);
  }
  return found;
}

/**
 * The one top-level rule with that exact prelude.
 *
 * @param prelude Whitespace-collapsed selector text.
 * @returns The rule.
 * @throws If the stylesheet has no such rule, or more than one.
 */
function rule(prelude: string): CssRule {
  const matches = rules.filter((candidate) => candidate.prelude === prelude);
  if (matches.length !== 1) {
    throw new Error(`globals.css has ${matches.length} rules with prelude \`${prelude}\``);
  }
  return matches[0];
}

/** Declarations of the rule with that prelude. */
const declarationsOf = (prelude: string) => parseDeclarations(rule(prelude).body);

describe('avatar silhouette (hive.css §19)', () => {
  const avatar = declarationsOf('.avatar-hex');

  it('clips to the mockup hexagon, point by point', () => {
    // The same six points as `.avatar--hex`: a flat-topped hexagon, 3% inset top and
    // bottom so the silhouette has a little air inside its own box.
    expect(avatar.get('clip-path')).toBe(
      'polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%)'
    );
  });

  it('drops the radius, so a circle class cannot round a hexagon', () => {
    expect(avatar.get('border-radius')).toBe('0');
  });

  it('is asked for by the Avatar component, and by nothing else', () => {
    // One shared definition is what keeps every hexagon in the interface the same
    // hexagon; a second file naming the class is a copy waiting to drift.
    const callers = sourceFiles(join(__dirname, '..', 'src'))
      .filter((path) => readFileSync(path, 'utf8').includes('avatar-hex'))
      .map((path) => relative(join(__dirname, '..'), path));
    expect(callers).toEqual(['src/app/components/ui/Avatar.tsx']);
  });
});

describe('the two brand gradients', () => {
  it('paints the brand gradient from the two fixed brand hues', () => {
    // Both stops are `var()`s: a gradient that spelled the azure out would freeze at the
    // light palette, which is the `--shadow-focus` trap the token layer documents.
    expect(layer.root.get('--gradient-brand')).toBe(
      'linear-gradient(135deg, var(--brand-azure), var(--brand-navy))'
    );
  });

  it('mixes the honey lift from the theme honey rather than stating it', () => {
    const honey = layer.root.get('--gradient-honey') ?? '';
    expect(honey).toContain('var(--honey)');
    expect(honey).toContain('color-mix(in srgb, var(--honey)');
    // hive.css states the lift as `#FFD54F`; production mixes it, so the three themes that
    // re-tint honey (solarized, nord, darcula) re-tint the gradient with it.
    expect(honey).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('declares them where a `color-mix()` still follows the theme', () => {
    // In `@theme` Tailwind resolves `var(--color-*)` at build time; in the unlayered
    // `:root` alias block it does not. Both gradients must therefore live in `:root`.
    expect(layer.theme.has('--gradient-honey')).toBe(false);
    expect(layer.theme.has('--gradient-brand')).toBe(false);
  });
});

describe('drawer motion (DESIGN.md §3.4)', () => {
  const source = stripCssComments(css);

  it.each(['hive-drawer-in', 'hive-drawer-out'])('declares the %s keyframes', (name) => {
    expect(source).toContain(`@keyframes ${name}`);
  });

  it('slides in from the right rather than rising like a dialog', () => {
    const frames = rule('@keyframes hive-drawer-in').body;
    expect(frames).toContain('translateX(1.5rem)');
    expect(frames).toContain('opacity: 0');
  });

  it('runs on Radix’s own open/closed state, at the token durations', () => {
    expect(declarationsOf('.hive-drawer[data-state="open"]').get('animation')).toBe(
      'hive-drawer-in var(--dur-slow) var(--ease-out)'
    );
    expect(declarationsOf('.hive-drawer[data-state="closed"]').get('animation')).toBe(
      'hive-drawer-out var(--dur-base) var(--ease-out)'
    );
  });

  it('needs no reduced-motion rule of its own', () => {
    // The `data-motion="reduce"` and `prefers-reduced-motion` blocks zero every animation
    // duration in the document; a per-component override would be a second place to keep
    // in step. This asserts the general rule is still there to lean on.
    expect(source).toContain('html[data-motion="reduce"] *');
    expect(source).toContain('animation-duration: 0ms !important');
  });
});

describe('shortcut chips and the keyboard-hints preference', () => {
  it('lays the chord out as a row of chips', () => {
    const group = declarationsOf('.kbd-group');
    expect(group.get('display')).toBe('inline-flex');
    expect(group.get('gap')).toBe('0.125rem');
  });

  it('draws a chip as a key, in `rem`/`em` so it follows the font scale', () => {
    const chip = declarationsOf('.kbd');
    expect(chip.get('font-size')).toBe('var(--fs-2xs)');
    expect(chip.get('background')).toBe('var(--bg-surface)');
    // The keycap illusion: an inset hairline plus a 1 px bottom edge (hive.css §12).
    expect(chip.get('box-shadow')).toBe(
      '0 0 0 1px var(--border-strong) inset, 0 1px 0 var(--border-strong)'
    );
    expect(chip.get('padding')).toMatch(/em/);
  });

  it('hides the chip *and* its group when the preference is off', () => {
    // The group has to be hidden too, or a chord that has been turned off still occupies
    // its gap inside a button.
    const hidden = rules.find((candidate) =>
      candidate.prelude.includes('html[data-kbd-hints="off"] .kbd-group')
    );
    expect(hidden).toBeDefined();
    expect(hidden?.prelude).toContain('html[data-kbd-hints="off"] .kbd,');
    expect(parseDeclarations(hidden?.body ?? '').get('display')).toBe('none');
  });

  it('hides nothing else with them', () => {
    // The preference is presentation-only: an `sr-only` spelling beside the chips is
    // outside the group, so it survives. A rule that hid a wider subtree would take the
    // shortcut away from a screen-reader user, which the design forbids.
    for (const candidate of rules) {
      if (!candidate.prelude.includes('data-kbd-hints')) continue;
      expect(candidate.prelude).toMatch(/^html\[data-kbd-hints="off"\] \.(kbd|kbd-group)(,|$)/);
    }
  });
});
