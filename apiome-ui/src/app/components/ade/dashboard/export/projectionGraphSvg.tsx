'use client';

/**
 * Shared projection-graph SVG primitives (IXH-4.2, #5110).
 *
 * Every projection map in the product — the export projection map (EFP-2.2,
 * `ProjectionGraphPanel`), the import projection map (IXH-3.3,
 * `CatalogImportProjectionGraph`), and the export source→target mapping graph (IXH-4.2,
 * `ExportMappingGraphPanel`) — draws the *same* picture from the deterministic layout
 * `projectionGraphLayout` produces: a column heading strip, one connector pair per entry,
 * a plain node box per source/canonical column, and a status-encoded outcome box. Those
 * marks live here, once, so the third surface is a third *view* of the shared primitives
 * rather than a third graph implementation (the IXH-4.2 acceptance criterion).
 *
 * What is deliberately NOT here is each surface's `<svg>` wrapper: the surfaces genuinely
 * differ in accessible naming (`aria-label` vs the table caption via `aria-labelledby`),
 * zoom, lane-heading column, and test ids. Those few lines stay with their panel; every
 * mark inside them comes from this module.
 *
 * All labels render as React text nodes inside `<svg:text>` — never `dangerouslySetInnerHTML`,
 * never interpolated markup — so an untrusted source label cannot inject anything.
 */

import type { PlacedBox, PlacedEntry, StatusPresentation } from './projectionGraph';
import { statusPresentation } from './projectionGraph';
import { SVG_TEXT_SIZE } from '../../../ui/svgTypography';

/**
 * Truncate a label to what fits one node box. The full text always remains available in
 * the node's `aria-label` and in the surface's text-alternative table, so this is a
 * drawing concession only.
 *
 * @param label The sanitized label.
 * @param max Maximum characters to draw (default 26, one box width).
 * @returns The label, ellipsized when it would overflow the box.
 */
export function fitProjectionLabel(label: string, max = 26): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** One column heading above the graph body (decorative — the table carries the semantics). */
export function ProjectionColumnHeading({ x, label }: { x: number; label: string }) {
  return (
    <text
      x={x}
      y={10}
      aria-hidden
      fontSize={SVG_TEXT_SIZE.label}
      className="xstd-axis-label"
    >
      {label}
    </text>
  );
}

/**
 * One entry's connector pair: the muted provenance line (source → canonical, drawn only
 * when the row captured a source side) and the status-patterned outcome line
 * (canonical → outcome). The dash pattern is the colour-independent status channel.
 */
export function ProjectionEntryConnectors<LaneKey extends string>({
  placed,
}: {
  placed: PlacedEntry<LaneKey>;
}) {
  const p = statusPresentation(placed.entry.status);
  const midY = placed.canonicalBox.y + placed.canonicalBox.height / 2;
  return (
    <g aria-hidden>
      {placed.sourceBox && (
        <line
          x1={placed.sourceBox.x + placed.sourceBox.width}
          y1={midY}
          x2={placed.canonicalBox.x}
          y2={midY}
          strokeWidth={1.5}
          className="xstd-edge"
        />
      )}
      <line
        x1={placed.canonicalBox.x + placed.canonicalBox.width}
        y1={midY}
        x2={placed.outcomeBox.x}
        y2={midY}
        strokeWidth={2}
        strokeDasharray={p.dashArray ?? undefined}
        className="xstd-edge"
        data-tone={p.tone}
      />
    </g>
  );
}

/** One plain node box (source or canonical column). */
export function ProjectionNodeBox({
  box,
  label,
  mono = false,
  muted = false,
  selected = false,
}: {
  box: PlacedBox;
  label: string;
  /** Draw the label in the monospace face (construct keys and native names). */
  mono?: boolean;
  /** Draw the label muted (the provenance column). */
  muted?: boolean;
  /** Draw the selection border. */
  selected?: boolean;
}) {
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
        strokeWidth={selected ? 2 : 1}
        className="xstd-node motion-safe:transition-colors"
        data-selected={selected}
      />
      <text
        x={box.x + 8}
        y={box.y + box.height / 2 + 3.5}
        fontSize={SVG_TEXT_SIZE.body}
        className={`${mono ? 'font-mono' : ''} ${
          muted ? 'xstd-node__label--muted' : 'xstd-node__label'
        }`}
      >
        {fitProjectionLabel(label)}
      </text>
    </g>
  );
}

/**
 * The outcome-column box: status symbol + text label, dash-patterned like its connector,
 * with the landing location printed beneath when the surface has one (the export maps).
 */
export function ProjectionOutcomeBox({
  box,
  presentation,
  selected,
  location = null,
}: {
  box: PlacedBox;
  presentation: StatusPresentation;
  selected: boolean;
  /** Where the construct landed, printed as a second line; null draws the label centred. */
  location?: string | null;
}) {
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={presentation.dashArray ?? undefined}
        className="xstd-node motion-safe:transition-colors"
        data-selected={selected}
        data-tone={presentation.tone}
      />
      <text
        x={box.x + 8}
        y={box.y + (location ? 12.5 : box.height / 2 + 3.5)}
        fontSize={SVG_TEXT_SIZE.label}
        className="xstd-node__label"
      >
        {fitProjectionLabel(`${presentation.symbol} ${presentation.label}`)}
      </text>
      {location && (
        <text
          x={box.x + 8}
          y={box.y + 24}
          fontSize={SVG_TEXT_SIZE.tick}
          className="xstd-node__meta"
        >
          {fitProjectionLabel(location, 32)}
        </text>
      )}
    </g>
  );
}

/**
 * The drawn keyboard-focus outline for one entry band (WCAG 2.4.7). Graph nodes set
 * `outline-none` to suppress the user-agent ring inside the SVG, so the surface draws
 * this rect instead whenever a node holds DOM focus.
 */
export function ProjectionFocusRing<LaneKey extends string>({
  placed,
  testId,
}: {
  placed: PlacedEntry<LaneKey>;
  /** `data-testid` for the ring, so each surface keeps its own test vocabulary. */
  testId?: string;
}) {
  const left = placed.sourceBox ?? placed.canonicalBox;
  return (
    <rect
      data-testid={testId}
      x={left.x - 3}
      y={placed.canonicalBox.y - 3}
      width={placed.outcomeBox.x + placed.outcomeBox.width - left.x + 6}
      height={placed.canonicalBox.height + 6}
      rx={8}
      fill="none"
      strokeWidth={2}
      className="xstd-edge" data-selected="true"
    />
  );
}
