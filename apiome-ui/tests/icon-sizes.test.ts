/**
 * The DESIGN.md §3.5 icon vocabulary (HIVE-1.6, #5279).
 *
 * Three sizes exist — 16 dense, 18 rail, 15 button — and they are spelled in three places
 * that must agree: the document, the `--icon-*` tokens in `globals.css`, and
 * `components/ui/iconSizes.ts`, which is what a `lucide-react` `size` prop can actually
 * take. A drift between them is invisible until someone looks at two screens side by side,
 * so this suite re-derives all three from source and compares.
 *
 * It also pins the property that made `rem` the right spelling: at the default 16 px root
 * each constant is exactly the pixel size §3.5 states, and it moves with the reader's
 * font-size preference from there.
 */

import {
  ICON_SIZE,
  ICON_SIZE_PX,
  ICON_STROKE_WIDTH,
  ROOT_FONT_SIZE_PX,
  type IconSizeName,
} from '../src/app/components/ui/iconSizes';
import { designDocIconSizes, readTokenLayer, resolveToken } from './helpers/design-tokens';

const layer = readTokenLayer();
const designSizes = designDocIconSizes();

/** The three contexts, paired with the token that carries each one in `globals.css`. */
const TOKEN_NAME: Readonly<Record<IconSizeName, string>> = {
  dense: '--icon-dense',
  rail: '--icon-rail',
  button: '--icon-button',
};

/** A `rem` length as the number of CSS pixels it renders at the default root size. */
function remPixels(value: string): number {
  const match = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  if (!match) throw new Error(`Not a rem length: ${value}`);
  return Number(match[1]) * ROOT_FONT_SIZE_PX;
}

describe('the vocabulary matches DESIGN.md §3.5', () => {
  it('has exactly the three contexts the document names', () => {
    expect(Object.keys(ICON_SIZE).sort()).toEqual(['button', 'dense', 'rail']);
    expect(Object.keys(ICON_SIZE_PX).sort()).toEqual(['button', 'dense', 'rail']);
  });

  it.each(['dense', 'rail', 'button'] as const)('%s is the size §3.5 states', (name) => {
    expect(ICON_SIZE_PX[name]).toBe(designSizes[name]);
  });

  it('draws every icon at the §3.5 stroke width', () => {
    expect(ICON_STROKE_WIDTH).toBe(designSizes.strokeWidth);
  });
});

describe('the constants are `rem`, so an icon scales with the label beside it', () => {
  it.each(['dense', 'rail', 'button'] as const)('%s is stated in rem', (name) => {
    expect(ICON_SIZE[name]).toMatch(/^\d+(\.\d+)?rem$/);
  });

  it.each(['dense', 'rail', 'button'] as const)(
    '%s renders at its documented pixel size on a default root',
    (name) => {
      expect(remPixels(ICON_SIZE[name])).toBe(ICON_SIZE_PX[name]);
    },
  );

  it('orders the three the way the design does: rail > dense > button', () => {
    expect(remPixels(ICON_SIZE.rail)).toBeGreaterThan(remPixels(ICON_SIZE.dense));
    expect(remPixels(ICON_SIZE.dense)).toBeGreaterThan(remPixels(ICON_SIZE.button));
  });
});

describe('globals.css carries the same three values', () => {
  it.each(Object.entries(TOKEN_NAME))('%s is declared as %s', (name, token) => {
    expect(resolveToken(token, layer)).toBe(ICON_SIZE[name as IconSizeName]);
  });

  it('declares them in @theme, so they reach :root even with no utility referencing them', () => {
    for (const token of Object.values(TOKEN_NAME)) {
      expect(layer.theme.has(token)).toBe(true);
      expect(layer.root.has(token)).toBe(false);
    }
  });
});
