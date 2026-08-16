/**
 * The official Apiome bee, and the one place the app says where it lives.
 *
 * `docs/mockups/DESIGN.md` §2 calls the mark "a bee on a honeycomb" in navy, azure and
 * honey, and it ships as artwork: `public/bee-logo.png`. HIVE-1.5 (#5278) replaced that
 * file with a hand-drawn vector built from that description — which kept the honeycomb and
 * the striped abdomen, but redrew the wings, re-proportioned the body and left out the
 * molecule lattice the file has and the prose never mentions. The result was a bee that was
 * recognisably *not* the brand's. This module is the correction: every surface now draws
 * the shipped file, so there is no redraw left to drift from it.
 *
 * Two renderers need the artwork and they cannot share an import, because one of them runs
 * where there is no DOM:
 *
 * | Renderer | Where | How it takes the file |
 * | --- | --- | --- |
 * | {@link BeeGlyph} | the app | `next/image` on {@link BEE_LOGO_SRC}, served and resized by Next |
 * | `icon.tsx` / `apple-icon.tsx` | the metadata routes | `beeLogoDataUri()` in `./beeLogoFile`, which reads the bytes off disk for Satori |
 *
 * The constants below are the whole contract between them, which is why they are stated
 * once here rather than spelled out at each call site.
 *
 * Everything about *colour* is fixed in the artwork. That is the trade the raster mark
 * makes: the bee is exactly the brand's bee on every theme, and no palette can lighten its
 * navy line work on a dark base the way the vector could. `--brand-ink` survives in
 * `globals.css` as a brand token, but nothing paints the mark with it any more.
 */

/** The artwork's public path — what a browser requests. */
export const BEE_LOGO_SRC = '/bee-logo.png';

/** The artwork's name under `public/`, for the routes that read it off disk instead. */
export const BEE_LOGO_FILE = 'bee-logo.png';

/**
 * The artwork's own pixel size.
 *
 * Square, and the ceiling on how large the mark can be drawn before it softens — a caller
 * asking for more than this gets an upscale. `tests/bee-glyph.test.ts` reads the file's
 * header and fails if these numbers stop describing it.
 */
export const BEE_LOGO_INTRINSIC = { width: 256, height: 256 } as const;
