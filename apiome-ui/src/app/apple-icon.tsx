import { ImageResponse } from 'next/og';

import { beeGlyphDataUri } from '@/app/components/brand/beeGlyph';

/**
 * The home-screen icon iOS asks for (HIVE-1.5, #5278).
 *
 * Same glyph as `icon.tsx`, with two differences iOS forces: the canvas is opaque — iOS
 * composites a transparent icon onto black, which would swallow the navy — and the bee is
 * inset, because the system rounds the corners off with its own mask.
 */

/** The size iOS asks for. */
export const size = { width: 180, height: 180 };

/** iOS does not read SVG here. */
export const contentType = 'image/png';

/** Paper white, matching `--color-surface`: the mark is drawn for a light ground. */
const PLATE = '#FFFFFF';

/** Share of the canvas the glyph occupies, leaving room for the system's corner mask. */
const GLYPH_SCALE = 0.72;

/**
 * Render the Apple touch icon.
 *
 * @returns A 180 px PNG of the bee, centred on an opaque plate.
 */
export default function AppleIcon() {
  const edge = Math.round(size.width * GLYPH_SCALE);

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: PLATE,
        }}
      >
        {/* Satori renders a plain `img`; `next/image` has no meaning outside the DOM. */}
        <img src={beeGlyphDataUri({ size: edge })} width={edge} height={edge} alt="" />
      </div>
    ),
    size,
  );
}
