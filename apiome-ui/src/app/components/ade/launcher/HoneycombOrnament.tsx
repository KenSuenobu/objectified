import BrandMark from '@/app/components/brand/BrandMark';

/**
 * The launcher hero's honeycomb (HIVE-4.5, #5299).
 *
 * `docs/mockups/home/launcher.html` draws seven hexagons around the brand's own hex and puts
 * a navy one in the middle; here the middle cell is the bee itself, which is what makes the
 * mark "feature in the hero ornament" rather than merely being alluded to. The cells are the
 * regular hexagon of `DESIGN.md` §2 at three depths — filled honey, honey and accent washes,
 * and two drawn as outline only — so the comb reads as a structure being built rather than
 * as a decorative blob.
 *
 * Everything is a token reference, so the ornament follows all nine themes. It is
 * `aria-hidden` in its entirety: it says nothing the headline beside it does not, and the
 * bee's own accessible name would otherwise be the third "Apiome" on the page.
 */

/** One cell of the comb, as an SVG polygon path. Half-height 58, half-width 50. */
const HEX_POINTS = '0,-58 50,-29 50,29 0,58 -50,29 -50,-29';

/** Where each cell sits, relative to the comb's centre, and how it is painted. */
const CELLS: readonly { x: number; y: number; fill: string; stroke?: string }[] = [
  { x: 104, y: 0, fill: 'var(--honey-soft)', stroke: 'var(--honey)' },
  { x: -104, y: 0, fill: 'var(--honey-soft)', stroke: 'var(--honey)' },
  { x: 52, y: -90, fill: 'var(--accent-soft)', stroke: 'var(--accent)' },
  { x: -52, y: -90, fill: 'none', stroke: 'var(--border-strong)' },
  { x: 52, y: 90, fill: 'none', stroke: 'var(--border-strong)' },
  { x: -52, y: 90, fill: 'var(--accent-soft)', stroke: 'var(--accent)' },
];

/** Edge of the bee at the centre of the comb, in pixels. */
const BEE_SIZE = 56;

/**
 * The hero ornament.
 *
 * @returns A decorative honeycomb with the brand mark at its centre.
 */
export default function HoneycombOrnament() {
  return (
    <div className="launch-comb" aria-hidden="true">
      <svg viewBox="0 0 300 260" width="100%" height="100%" focusable="false">
        <g transform="translate(150 130)">
          {/* The centre cell, solid honey, is the plate the bee sits on. */}
          <polygon points={HEX_POINTS} fill="var(--honey)" opacity="0.9" />
          {CELLS.map((cell) => (
            <polygon
              key={`${cell.x}:${cell.y}`}
              points={HEX_POINTS}
              transform={`translate(${cell.x} ${cell.y})`}
              fill={cell.fill}
              stroke={cell.stroke}
              strokeOpacity={cell.fill === 'none' ? undefined : 0.5}
            />
          ))}
        </g>
      </svg>
      <BrandMark variant="glyph" size={BEE_SIZE} decorative className="launch-comb__bee" />
    </div>
  );
}
