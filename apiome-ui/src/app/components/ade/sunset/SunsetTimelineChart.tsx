'use client';

/**
 * The sunset timeline drawing (HIVE-8.2, #5328).
 *
 * Authority: `docs/mockups/ship/sunset-timeline.html` §"Timeline visualisation" — a month
 * grid across six months, an azure *today* rule, one lane per project, and diamond markers at
 * each sunset instant coloured by status.
 *
 * ### What it is, and what it is not
 *
 * It is *decorative-plus*: the table under it is the source of truth, and this drawing may
 * never be the only place a fact appears. Two things enforce that rather than merely
 * promising it — {@link sunsetTimelineLayout} returns the counts it could not plot, and the
 * card's footer prints them; and every marker is a control that takes the reader to the row.
 *
 * ### Why every marker is a button
 *
 * The mockup's markers carry a native `<title>` and nothing else, which leaves the whole
 * visualisation unreachable by keyboard — the acceptance criterion this ticket adds. An SVG
 * shape cannot hold an HTML `<button>`, so each marker is a `<g role="button" tabIndex={0}>`
 * with the instant in its accessible name. It is a real control rather than a focus stop
 * pretending to be one: activating it selects the revision, and the table highlights and
 * scrolls to that row. The `<title>` stays, so a mouse reader still gets the tooltip.
 *
 * ### Colour
 *
 * None is named here. Every mark carries `data-status`, and the `.stl-*` block in
 * `globals.css` turns that into a token — the same *tone* the row's badge resolves to through
 * `ui/statusVocabulary`, so a diamond and its row can never disagree. The one thing worth
 * knowing before changing that block: a diamond is drawn with a `--fg-muted` **contour** as
 * well as a tone fill, because the saturated role step does not clear the 3:1 non-text floor
 * on the card surface in four of the nine appearances (the measurement is in the stylesheet,
 * and `tests/sunset-timeline-css.test.ts` re-takes it).
 *
 * `fontSize` on the `<text>` runs is the one px-flavoured exemption, and it comes from
 * `ui/svgTypography` (see that module's header).
 *
 * @see `./sunsetModel.ts` — every coordinate this draws.
 */

import * as React from 'react';
import { CalendarRange } from 'lucide-react';

import { Card, CardBody, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { SVG_TEXT_SIZE } from '@/app/components/ui/svgTypography';
import { cn } from '@lib/utils';

import {
  CHIP_HEIGHT,
  CHIP_PAD_X,
  MARKER_RADIUS,
  MONTH_LABEL_Y,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  SUNSET_STATUSES,
  SUNSET_STATUS_LEGEND,
  TODAY_CHIP_GAP,
  TODAY_CHIP_HEIGHT,
  sunsetTimelineAriaLabel,
  sunsetTimelineSummary,
  type SunsetMarker,
  type SunsetTimelineLayout,
} from './sunsetModel';

/** The today chip's half-width, in user units — enough for the four letters it holds. */
const TODAY_CHIP_HALF_WIDTH = 24;

/**
 * A diamond centred on a point.
 *
 * @param x The centre's x.
 * @param y The centre's y.
 * @returns The `d` of a closed four-point path.
 */
function diamond(x: number, y: number): string {
  const r = MARKER_RADIUS;
  return `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`;
}

export interface SunsetTimelineChartProps {
  /** The geometry, from {@link sunsetTimelineLayout}. */
  layout: SunsetTimelineLayout;
  /** How many rows the table is showing — the denominator in the footer's sentence. */
  total: number;
  /** The revision a marker last selected, drawn as the current one. */
  selectedRevisionId?: string | null;
  /**
   * A marker was activated.
   *
   * @param marker The marker.
   */
  onSelect?: (marker: SunsetMarker) => void;
  /** Extra classes for the card. */
  className?: string;
}

/**
 * Render the timeline card. See {@link SunsetTimelineChartProps}.
 *
 * @returns The card — its legend, the drawing, and the sentence that reconciles it with the
 *   table.
 */
export function SunsetTimelineChart({
  layout,
  total,
  selectedRevisionId,
  onSelect,
  className,
}: SunsetTimelineChartProps) {
  /** Enter and Space activate a marker, which is what `role="button"` promises. */
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<SVGGElement>, marker: SunsetMarker) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect?.(marker);
    },
    [onSelect]
  );

  return (
    <Card className={cn('stl-card', className)} data-testid="sunset-timeline-card">
      <CardHeader className="stl-card__header">
        <CardTitle className="stl-card__title">
          <CalendarRange aria-hidden />
          Timeline
          <span className="stl-card__note">
            one month back, then the next five · one lane per project
          </span>
        </CardTitle>
        <ul className="stl-legend" data-testid="sunset-timeline-legend">
          {SUNSET_STATUSES.map((status) => (
            <li key={status} className="stl-legend__item">
              <span className="stl-legend__swatch" data-status={status} aria-hidden />
              {SUNSET_STATUS_LEGEND[status]}
            </li>
          ))}
          <li className="stl-legend__item stl-legend__item--quiet">◆ = sunset instant</li>
        </ul>
      </CardHeader>

      <CardBody className="stl-card__body">
        <div className="stl-plot" data-testid="sunset-timeline-plot">
          <svg
            className="stl-svg"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="xMinYMid meet"
            role="group"
            aria-label={sunsetTimelineAriaLabel(layout)}
            data-testid="sunset-timeline-svg"
          >
            {/* The month grid. Dashed, and behind everything else. */}
            <g className="stl-grid" aria-hidden>
              {layout.months.map((month) => (
                <line
                  key={month.startsAt}
                  x1={month.x}
                  y1={PLOT_TOP}
                  x2={month.x}
                  y2={layout.gridBottom}
                />
              ))}
            </g>
            <g className="stl-months" fontSize={SVG_TEXT_SIZE.label} aria-hidden>
              {layout.months.map((month) => (
                <text key={month.startsAt} x={month.x} y={MONTH_LABEL_Y}>
                  {month.label}
                </text>
              ))}
            </g>

            {/* Today. A rule the whole height of the grid, and a chip that names it. */}
            {layout.today ? (
              <g className="stl-today" aria-hidden data-testid="sunset-timeline-today">
                <line
                  x1={layout.today.x}
                  y1={PLOT_TOP - TODAY_CHIP_GAP}
                  x2={layout.today.x}
                  y2={layout.gridBottom}
                />
                <rect
                  x={layout.today.x - TODAY_CHIP_HALF_WIDTH}
                  y={layout.gridBottom + TODAY_CHIP_GAP}
                  width={TODAY_CHIP_HALF_WIDTH * 2}
                  height={TODAY_CHIP_HEIGHT}
                  rx={TODAY_CHIP_HEIGHT / 2}
                />
                <text
                  x={layout.today.x}
                  y={layout.gridBottom + TODAY_CHIP_GAP + TODAY_CHIP_HEIGHT / 2}
                  fontSize={SVG_TEXT_SIZE.label}
                >
                  {layout.today.label}
                </text>
              </g>
            ) : null}

            {/* One lane per project. */}
            {layout.lanes.map((lane) => (
              <g key={lane.key} className="stl-lane" data-testid={`sunset-lane-${lane.key}`}>
                <text
                  className="stl-lane__name"
                  x={0}
                  y={lane.labelY}
                  fontSize={SVG_TEXT_SIZE.label}
                  aria-hidden
                >
                  {lane.name}
                </text>
                <line
                  className="stl-lane__rule"
                  x1={PLOT_LEFT}
                  y1={lane.y}
                  x2={PLOT_RIGHT}
                  y2={lane.y}
                  aria-hidden
                />

                {lane.markers.map((marker) => (
                  <g key={marker.revisionId}>
                    {marker.connectorFromX !== null ? (
                      <line
                        className="stl-connector"
                        data-status={marker.status}
                        x1={marker.connectorFromX}
                        y1={marker.y}
                        x2={marker.x}
                        y2={marker.y}
                        aria-hidden
                      />
                    ) : null}

                    <rect
                      className="stl-chip"
                      data-status={marker.status}
                      x={marker.chip.x}
                      y={marker.chip.y}
                      width={marker.chip.width}
                      height={CHIP_HEIGHT}
                      rx={6}
                      aria-hidden
                    />
                    <text
                      className="stl-chip__label"
                      data-status={marker.status}
                      x={marker.chip.x + CHIP_PAD_X}
                      y={marker.y}
                      fontSize={SVG_TEXT_SIZE.body}
                      aria-hidden
                    >
                      {marker.chip.label}
                    </text>

                    <text
                      className="stl-marker__date"
                      x={marker.date.x}
                      y={marker.date.y}
                      fontSize={SVG_TEXT_SIZE.tick}
                      aria-hidden
                    >
                      {marker.date.label}
                    </text>

                    <g
                      className="stl-marker"
                      role="button"
                      tabIndex={0}
                      aria-label={marker.label}
                      data-status={marker.status}
                      data-current={selectedRevisionId === marker.revisionId ? '' : undefined}
                      data-testid={`sunset-marker-${marker.revisionId}`}
                      onClick={() => onSelect?.(marker)}
                      onKeyDown={(event) => handleKeyDown(event, marker)}
                    >
                      <title>{marker.label}</title>
                      {/* The focus ring. Drawn always, revealed by :focus-visible — an
                          `outline` on an SVG group is not reliably painted, and a ring in
                          the drawing's own units scales with it. */}
                      <circle
                        className="stl-marker__ring"
                        cx={marker.x}
                        cy={marker.y}
                        r={MARKER_RADIUS + 5}
                      />
                      {/* The hit target. The diamond alone is 16 units across, which is
                          under the 24-unit minimum a pointer target wants. */}
                      <circle
                        className="stl-marker__hit"
                        cx={marker.x}
                        cy={marker.y}
                        r={MARKER_RADIUS + 4}
                      />
                      <path className="stl-marker__glyph" d={diamond(marker.x, marker.y)} />
                    </g>
                  </g>
                ))}
              </g>
            ))}
          </svg>
        </div>
      </CardBody>

      <CardFooter className="stl-card__footer">
        <span data-testid="sunset-timeline-summary">{sunsetTimelineSummary(layout, total)}</span>
        <span className="stl-card__hint">Select a ◆ to find its row</span>
      </CardFooter>
    </Card>
  );
}
