/**
 * The bee artwork and the routes that embed it (HIVE-1.5, #5278).
 *
 * The mark used to be drawn from data — an array of shapes two renderers walked — and this
 * suite checked the drawing: that nothing fell outside the viewBox, that the raster
 * renderer painted every shape. That geometry is gone. The app now draws
 * `public/bee-logo.png`, the artwork the brand actually ships, because the drawing had
 * drifted into a different-looking bee.
 *
 * What is left to get wrong is the wiring, so that is what this covers:
 *
 *   1. **the constants describe the file that is really there.** `BEE_LOGO_INTRINSIC` is
 *      what `next/image` sizes from and what tells a caller when it is asking for an
 *      upscale; if someone drops in a new export of the logo at a different size, the
 *      numbers have to move with it.
 *   2. **the artwork can sit on any theme.** The mark is placed on nine palettes, light and
 *      dark, with no plate behind it — an opaque or paletted PNG would show a white box on
 *      six of them.
 *   3. **the icon routes embed the same bytes.** Satori cannot fetch `/bee-logo.png`, so
 *      the favicon comes from a disk read that has to point at the same file the DOM does.
 *
 * `tests/brand-mark.test.tsx` covers the components and the stylesheet behind them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BEE_LOGO_FILE,
  BEE_LOGO_INTRINSIC,
  BEE_LOGO_SRC,
} from '../src/app/components/brand/beeGlyph';
import { beeLogoDataUri } from '../src/app/components/brand/beeLogoFile';

/** The app root, which is also `process.cwd()` when jest runs. */
const APP_ROOT = join(__dirname, '..');

/** The artwork on disk. */
const LOGO_PATH = join(APP_ROOT, 'public', BEE_LOGO_FILE);

const bytes = readFileSync(LOGO_PATH);

/** The PNG signature every file of the format opens with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The prefix `beeLogoDataUri` is expected to produce. */
const DATA_URI_PREFIX = 'data:image/png;base64,';

/**
 * A PNG's IHDR chunk — the header every PNG opens with.
 *
 * Read rather than decoded: the bytes at offset 16 carry the size, the bit depth and the
 * colour type, which is everything this suite needs and costs no decompression.
 *
 * @param file The file's bytes.
 * @returns Width, height, bit depth and colour type.
 */
function readIhdr(file: Buffer): {
  width: number;
  height: number;
  depth: number;
  colourType: number;
} {
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
    depth: file[24],
    colourType: file[25],
  };
}

const ihdr = readIhdr(bytes);

describe('the bee artwork', () => {
  it('is a PNG, at the path the components fetch', () => {
    // The two spellings exist because one is fetched by a browser and the other is read off
    // disk; a leading slash is the only thing that may differ between them.
    expect(BEE_LOGO_SRC).toBe(`/${BEE_LOGO_FILE}`);
    expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it('is the size the components size from', () => {
    expect({ width: ihdr.width, height: ihdr.height }).toEqual({
      width: BEE_LOGO_INTRINSIC.width,
      height: BEE_LOGO_INTRINSIC.height,
    });
  });

  it('is square, so a caller can ask for one edge', () => {
    // `BeeGlyph` takes a single `size` and passes it as both width and height. A logo
    // exported at 4:3 would arrive letterboxed by `object-fit: contain`.
    expect(ihdr.width).toBe(ihdr.height);
  });

  it('carries an alpha channel, because it sits on nine different backgrounds', () => {
    // Colour type 6 is truecolour-with-alpha. The mark is placed on light and dark bases
    // with no plate behind it, so a flattened export would show a white square on the six
    // dark palettes — and, via `apple-icon.tsx`, a black one on iOS.
    expect(ihdr.colourType).toBe(6);
    expect(ihdr.depth).toBe(8);
  });
});

describe('the disk read the icon routes use', () => {
  const uri = beeLogoDataUri();

  it('declares itself as a PNG', () => {
    expect(uri.startsWith(DATA_URI_PREFIX)).toBe(true);
  });

  it('embeds the shipped artwork byte for byte', () => {
    // Not merely "a PNG": the favicon and the mark in the rail have to be the same bee, and
    // this is the only place that could quietly diverge — the routes read from `public/`
    // through `process.cwd()` rather than importing the file.
    const decoded = Buffer.from(uri.slice(DATA_URI_PREFIX.length), 'base64');
    expect(decoded.equals(bytes)).toBe(true);
  });
});
