import { ImageResponse } from 'next/og';

import { beeLogoDataUri } from '@/app/components/brand/beeLogoFile';

/**
 * Browser and installed-app icons, drawn from the bee artwork (HIVE-1.5, #5278).
 *
 * Next renders each entry below at build time and links it from `<head>`, so the tab and
 * the home-screen icon are the same `bee-logo.png` the app draws its brand mark with.
 *
 * The artwork is handed to the renderer as a base64 data URI rather than as a path: Satori
 * has no network and no `public/` directory, so `beeLogoDataUri` reads the bytes off disk.
 *
 * `app-large` asks for 512 px from a 256 px file, so that one entry is an upscale — it is
 * the size an installed PWA keeps for its splash screen, where it is shown well below its
 * pixel size. The other two are at or under the artwork's own resolution.
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
 * `id` is awaited because Next hands it over as a promise, the same way it does `params`.
 * Read synchronously it is an object, no entry of {@link ICON_SIZES} matches it, and every
 * size silently falls back to the first one — which is how `app` and `app-large` were both
 * being served as 32 px images while `<head>` advertised them at 192 and 512.
 *
 * @param params.id The {@link ICON_SIZES} id Next is asking for.
 * @returns A PNG of the bee at that size, on a transparent ground.
 */
export default async function Icon({ id }: { id: string | Promise<string> }) {
  const requested = await id;
  const edge = ICON_SIZES.find((icon) => icon.id === requested)?.edge ?? ICON_SIZES[0].edge;

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
        {/* Satori renders a plain `img`; `next/image` has no meaning outside the DOM,
            and it cannot fetch `/bee-logo.png` — the bytes have to be inline. */}
        <img src={beeLogoDataUri()} width={edge} height={edge} alt="" />
      </div>
    ),
    { width: edge, height: edge },
  );
}
