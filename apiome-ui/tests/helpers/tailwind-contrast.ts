/**
 * WCAG contrast arithmetic over the *real* Tailwind palette, for jsdom tests.
 *
 * jsdom compiles no stylesheet, so axe's `color-contrast` rule cannot run in a Jest
 * suite — it needs a layout engine to resolve the composited colours. A test that has to
 * pin a contrast decision therefore reads the colour token a component chose and
 * evaluates it here.
 *
 * The palette is read out of the installed `tailwindcss/theme.css` rather than restated
 * as a table of hexes, so the numbers a test asserts on are the numbers the build ships.
 * Tailwind v4 states them in OKLCH, which this module converts to sRGB and then to the
 * relative luminance WCAG 2.x defines (SC 1.4.3).
 *
 * The Playwright/axe conformance suite stays the authority on *rendered* contrast — it
 * sees real compositing, opacity and inherited backgrounds. This module is the
 * deterministic guard that stops a token silently regressing below the threshold
 * (DH-3.4, apiome/private-suite#2621).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Minimum contrast for normal-size text at WCAG 2.2 AA (SC 1.4.3). */
export const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** Minimum contrast for large text — ≥24 px, or ≥18.66 px bold — at WCAG 2.2 AA. */
export const WCAG_AA_LARGE_TEXT_MIN = 3;

/** One colour as 8-bit sRGB channels, the form a browser reports and axe measures. */
export type Rgb = { r: number; g: number; b: number };

const OKLCH_DECLARATION = /--color-([a-z]+-\d{2,3}):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g;

let paletteCache: Map<string, Rgb> | undefined;

/**
 * Every `--color-<token>` Tailwind defines, as sRGB.
 *
 * @returns Token (e.g. `slate-500`) to sRGB channels. Cached after the first read.
 */
function palette(): Map<string, Rgb> {
  if (paletteCache) return paletteCache;

  const require = createRequire(__filename);
  const themeCss = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');

  paletteCache = new Map<string, Rgb>();
  for (const [, token, l, c, h] of themeCss.matchAll(OKLCH_DECLARATION)) {
    paletteCache.set(token, oklchToRgb(Number(l) / 100, Number(c), Number(h)));
  }
  return paletteCache;
}

/**
 * Convert an OKLCH colour to 8-bit sRGB.
 *
 * Follows Björn Ottosson's reference conversion: polar OKLCH → OKLab → LMS → linear
 * sRGB → gamma-encoded sRGB, rounded to the 8-bit values a browser composites with.
 *
 * @param lightness - OKLab lightness in 0..1.
 * @param chroma - OKLab chroma.
 * @param hue - Hue angle in degrees.
 * @returns The colour as 8-bit sRGB channels, clamped to the gamut.
 */
export function oklchToRgb(lightness: number, chroma: number, hue: number): Rgb {
  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    const encoded =
      clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  });

  return { r: linear[0], g: linear[1], b: linear[2] };
}

/**
 * Resolve a Tailwind colour token to sRGB.
 *
 * @param token - Palette token (`slate-500`) or the literal `white` / `black`.
 * @returns The colour's sRGB channels.
 * @throws When the token is not in Tailwind's palette — a typo must fail loudly rather
 *   than silently assert against a default.
 */
export function tailwindColor(token: string): Rgb {
  if (token === 'white') return { r: 255, g: 255, b: 255 };
  if (token === 'black') return { r: 0, g: 0, b: 0 };

  const color = palette().get(token);
  if (!color) throw new Error(`Unknown Tailwind colour token: ${token}`);
  return color;
}

/**
 * WCAG 2.x relative luminance of an sRGB colour.
 *
 * @param color - 8-bit sRGB channels.
 * @returns Relative luminance in 0..1.
 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Contrast ratio between two Tailwind colour tokens.
 *
 * @param foregroundToken - Text colour token, e.g. `slate-500`.
 * @param backgroundToken - Background colour token, e.g. `white`.
 * @returns The ratio, from 1 (identical) to 21 (black on white).
 */
export function tokenContrastRatio(foregroundToken: string, backgroundToken: string): number {
  const lighter = relativeLuminance(tailwindColor(foregroundToken));
  const darker = relativeLuminance(tailwindColor(backgroundToken));
  const [high, low] = lighter >= darker ? [lighter, darker] : [darker, lighter];
  return (high + 0.05) / (low + 0.05);
}

/**
 * Pull the colour token a Tailwind class list applies in one colour scheme.
 *
 * Only unprefixed `text-<token>` (light) and `dark:text-<token>` (dark) count: state
 * variants such as `hover:text-indigo-600` do not decide the resting contrast, and
 * non-colour `text-*` utilities (`text-sm`, `text-[13px]`, `text-left`) are not colours.
 *
 * @param className - The element's full class list.
 * @param scheme - Which colour scheme's token to resolve.
 * @returns The token (e.g. `slate-500`), or `undefined` when the class list sets none.
 */
export function textColorToken(
  className: string,
  scheme: 'light' | 'dark'
): string | undefined {
  const pattern =
    scheme === 'dark'
      ? /(?:^|\s)dark:text-([a-z]+-\d{2,3})(?=\s|$)/
      : /(?:^|\s)text-([a-z]+-\d{2,3})(?=\s|$)/;
  return className.match(pattern)?.[1];
}
