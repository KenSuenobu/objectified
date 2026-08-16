import { ImageResponse } from 'next/og';

import { beeGlyphDataUri } from '@/app/components/brand/beeGlyph';

/**
 * Browser and installed-app icons, drawn from the bee glyph (HIVE-1.5, #5278).
 *
 * Next renders each entry below at build time and links it from `<head>`, so the tab and
 * the home-screen icon come from the same vector the app draws its brand mark with —
 * `Apiome-07.png` is no longer traced by hand into an `.ico`.
 *
 * The glyph is handed to the renderer as an SVG data URI rather than as inline JSX: the
 * generator has no stylesheet, so `renderBeeGlyphSvg` bakes the fixed brand hues in. These
 * images are cached by the browser as files and have no theme to follow.
 *
 * `favicon.ico` stays in this directory as the legacy fallback for clients that ask for
 * `/favicon.ico` without reading the document.
 */

/** Transparent background: a tab, a bookmark bar and a task switcher each supply their own. */
export const contentType = 'image/png';

/** The sizes a browser or an installed PWA asks for. */
const ICON_SIZES = [
  { id: 'favicon', edge: 32 },
  { id: 'app', edge: 192 },
  { id: 'app-large', edge: 512 },
] as const;

/**
 * Declare one image per size.
 *
 * @returns Next's image metadata — one entry per {@link ICON_SIZES} member.
 */
export function generateImageMetadata() {
  return ICON_SIZES.map(({ id, edge }) => ({
    id,
    contentType,
    size: { width: edge, height: edge },
  }));
}

/**
 * Render one icon.
 *
 * @param params.id The {@link ICON_SIZES} id Next is asking for.
 * @returns A PNG of the bee at that size, on a transparent ground.
 */
export default function Icon({ id }: { id: string }) {
  const edge = ICON_SIZES.find((icon) => icon.id === id)?.edge ?? ICON_SIZES[0].edge;

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
        }}
      >
        {/* Satori renders a plain `img`; `next/image` has no meaning outside the DOM. */}
        <img src={beeGlyphDataUri({ size: edge })} width={edge} height={edge} alt="" />
      </div>
    ),
    { width: edge, height: edge },
  );
}
