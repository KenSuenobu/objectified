/**
 * The Hive type scale, and Tailwind's `text-*` namespace pointed at it (HIVE-1.6, #5279).
 *
 * HIVE-1.1 defined `--fs-2xs` … `--fs-5xl` but deliberately left Tailwind's own scale
 * alone, because re-pointing `text-sm` reaches the whole app at once and belonged with the
 * `rem` audit. This suite pins the result: every step of the DESIGN.md §3.2 scale exists,
 * carries the size the document states, and is what `text-*` renders.
 *
 * All of it is read from the source. jsdom compiles no stylesheet, and the failure this
 * guards is silent in any case — a mapping that quietly reverts leaves the app rendering
 * at Tailwind's sizes, one step too large everywhere, which reads as "slightly off"
 * rather than as a bug.
 */

import {
  designDocTypeScale,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const layer = readTokenLayer(css);
const designScale = designDocTypeScale();

/** Root font size, in CSS pixels, the `rem` values are stated against. */
const ROOT_FONT_SIZE_PX = 16;

/** The §3.2 steps, in scale order, as the Tailwind utility name each one owns. */
const TAILWIND_NAME: Readonly<Record<string, string>> = {
  '2xs': '--text-2xs',
  xs: '--text-xs',
  sm: '--text-sm',
  md: '--text-base',
  lg: '--text-lg',
  xl: '--text-xl',
  '2xl': '--text-2xl',
  '3xl': '--text-3xl',
  '4xl': '--text-4xl',
  '5xl': '--text-5xl',
};

/** A `rem` length as the number of CSS pixels it renders at the default root size. */
function remPixels(value: string): number {
  const match = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  if (!match) throw new Error(`Not a rem length: ${value}`);
  return Number(match[1]) * ROOT_FONT_SIZE_PX;
}

describe('the §3.2 scale, as the document states it', () => {
  it('declares one --fs-* token per step', () => {
    const declared = [...layer.root.keys()].filter((name) => name.startsWith('--fs-'));

    expect(declared.sort()).toEqual(
      [...designScale.keys()].map((step) => `--fs-${step}`).sort(),
    );
  });

  it.each([...designScale])('--fs-%s renders at the %s px DESIGN.md §3.2 states', (step, px) => {
    expect(remPixels(resolveToken(`--fs-${step}`, layer))).toBe(px);
  });

  it('states every step in `rem`, which is what makes the font-size preference work', () => {
    const frozen = [...designScale.keys()].filter(
      (step) => !/^\d+(\.\d+)?rem$/.test(resolveToken(`--fs-${step}`, layer)),
    );

    expect(frozen).toEqual([]);
  });

  it('rises monotonically, so a step is never a size backwards', () => {
    const sizes = [...designScale.keys()].map((step) => remPixels(resolveToken(`--fs-${step}`, layer)));

    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('bottoms out at 11 px: nothing in the interface is smaller', () => {
    expect(Math.min(...designScale.values())).toBe(11);
    expect(designScale.get('2xs')).toBe(11);
  });
});

describe("Tailwind's text-* utilities are the Hive scale", () => {
  it.each(Object.entries(TAILWIND_NAME))('%s is mapped to %s', (step, tailwindName) => {
    expect(layer.theme.get(tailwindName)).toBe(`var(--fs-${step})`);
  });

  it('points at the token rather than restating its value', () => {
    // A literal here is a second definition of the scale, and the two drift apart the
    // first time one of them is edited.
    const restated = Object.values(TAILWIND_NAME).filter(
      (name) => !(layer.theme.get(name) ?? '').startsWith('var(--fs-'),
    );

    expect(restated).toEqual([]);
  });

  it('adds --text-2xs, which Tailwind has no counterpart for', () => {
    expect(layer.theme.has('--text-2xs')).toBe(true);
    expect(remPixels(resolveToken('--text-2xs', layer))).toBe(11);
  });

  it('gives every step a line height from the §3.2 leadings', () => {
    const leadings = new Set(['var(--lh-tight)', 'var(--lh-snug)', 'var(--lh-normal)']);
    const wrong = Object.values(TAILWIND_NAME).filter(
      (name) => !leadings.has(layer.theme.get(`${name}--line-height`) ?? ''),
    );

    // Tailwind emits `line-height: var(--tw-leading, var(--text-*--line-height))`, so a
    // step without one pairs a Hive size with Tailwind's own leading for that step.
    expect(wrong).toEqual([]);
  });

  it('loosens as the size drops: display copy is tight, body copy is not', () => {
    expect(layer.theme.get('--text-5xl--line-height')).toBe('var(--lh-tight)');
    expect(layer.theme.get('--text-3xl--line-height')).toBe('var(--lh-tight)');
    expect(layer.theme.get('--text-base--line-height')).toBe('var(--lh-normal)');
  });

  it('declares the mapping in @theme, never in the unlayered :root block', () => {
    // `:root` outranks `@layer theme`, so a `--text-*` there would pin the utility and
    // silently defeat any later swap — the same trap the HIVE-1.1 layering contract names.
    const shadowed = Object.values(TAILWIND_NAME).filter((name) => layer.root.has(name));

    expect(shadowed).toEqual([]);
  });

  it('keeps the block `@theme static`, so unused steps still reach the browser', () => {
    expect(css).toContain('@theme static {');
  });
});
