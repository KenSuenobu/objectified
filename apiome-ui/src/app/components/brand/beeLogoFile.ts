import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BEE_LOGO_FILE } from './beeGlyph';

/**
 * The bee artwork as bytes, for the renderers that cannot fetch it.
 *
 * Separate from `./beeGlyph` on purpose: that module is imported by {@link BeeGlyph}, which
 * is bundled for the browser, and a top-level `node:fs` import anywhere in that graph fails
 * the client build. Only the metadata routes reach for this file, and they run on the
 * server at build time.
 */

/**
 * Read `public/bee-logo.png` and encode it for an `<img src>`.
 *
 * Satori — the renderer behind `next/og`'s `ImageResponse` — has no network and no public
 * directory, so it cannot be pointed at `/bee-logo.png`; it needs the image inline. The
 * bytes are read fresh rather than cached in a module constant so a designer replacing the
 * file does not have to restart the dev server to see the new favicon.
 *
 * @returns A `data:image/png;base64,…` URI of the shipped artwork.
 */
export function beeLogoDataUri(): string {
  return `data:image/png;base64,${readFileSync(join(process.cwd(), 'public', BEE_LOGO_FILE)).toString('base64')}`;
}
