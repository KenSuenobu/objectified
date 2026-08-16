'use client';

/**
 * Documentation & schema coverage meters (V2-MCP-29.5 / MCAT-15.5).
 *
 * A gauge row that makes a server's otherwise-invisible documentation quality legible at a glance:
 *
 * - **Items described** / **Items titled** — what share of the snapshot's capabilities carry a
 *   `description` / `title`;
 * - **Tool params documented** — what share of tool parameters carry a schema `description`;
 * - **Tools with output schema** — what share of tools declare a structured `output_schema`.
 *
 * Each gauge is a drill-down: expanding it lists the *specific* under-documented items behind the
 * percentage, so "62% described" is one click from the eight items that are not. All counting and the
 * offender lists come from the pure, unit-tested `mcpDocCoverageUi` module over the same snapshot
 * `items` the safety panel uses, so a meter and its drill-down can never disagree. A meter with
 * nothing to measure (a tool-less server has no parameters/output schemas) renders an explicit
 * **N/A** rather than a misleading red `0%`. This component owns its loading / error / no-capability
 * states so a slow or missing surface never blanks the Insight tab.
 */

import * as React from 'react';
import { BookOpen, Check, ChevronRight } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Gauge } from '@/app/components/ui/mcp/charts';
import type { McpCapabilityItem } from '@/app/components/ade/dashboard/mcp/mcpBrowseUi';
import {
  mcpDocCoverageMeters,
  type McpDocCoverageMeter,
  type McpDocOffender,
} from '@/app/components/ade/dashboard/mcp/mcpDocCoverageUi';

interface Props {
  /** The selected snapshot's capability items (all kinds), or `null` while the surface has not loaded. */
  items: readonly McpCapabilityItem[] | null;
  loading: boolean;
  error: string | null;
}

/** Human, singular labels for a capability `item_type`, shown as the kind chip on a drill-down row. */
const KIND_LABEL: Record<string, string> = {
  tool: 'Tool',
  resource: 'Resource',
  resource_template: 'Resource template',
  prompt: 'Prompt',
};

/** The kind label for an offender's `item_type`, falling back to the raw type for unknown kinds. */
function kindLabel(itemType: string): string {
  return KIND_LABEL[itemType] ?? itemType;
}

/** One drill-down row: the offending item's name, its kind, and (for params) the undocumented tally. */
function OffenderRow({ offender }: { offender: McpDocOffender }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1">
      <span className="flex min-w-0 items-center gap-2">
        <ChevronRight className="h-3 w-3 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden />
        <span className="truncate font-mono text-xs text-gray-800 dark:text-gray-200" title={offender.displayName}>
          {offender.displayName}
        </span>
        <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-700 dark:text-gray-300">
          {kindLabel(offender.itemType)}
        </span>
      </span>
      {typeof offender.undocumentedParams === 'number' && typeof offender.totalParams === 'number' ? (
        <span className="shrink-0 text-xs tabular-nums text-amber-600 dark:text-amber-400">
          {offender.undocumentedParams} of {offender.totalParams} undocumented
        </span>
      ) : null}
    </li>
  );
}

/** One coverage gauge card: the dial, its label/counts, and a drill-down of the items it counts against. */
function CoverageGauge({ meter }: { meter: McpDocCoverageMeter }) {
  const missing = meter.offenders.length;
  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/40">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {meter.label}
      </div>

      <div className="mt-2 flex justify-center">
        {meter.applicable ? (
          <Gauge
            value={meter.pct}
            centerLabel={`${meter.pct}%`}
            title={`${meter.label}: ${meter.pct}% (${meter.have} of ${meter.of} ${meter.unit})`}
            className="h-24 w-24"
          />
        ) : (
          <div
            className="flex h-24 w-24 items-center justify-center rounded-full border border-dashed border-gray-200 text-xs font-medium text-gray-400 dark:border-gray-700 dark:text-gray-500"
            role="img"
            aria-label={`${meter.label}: not applicable — no ${meter.unit}`}
          >
            N/A
          </div>
        )}
      </div>

      <p className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">{meter.hint}</p>

      <div className="mt-2 text-center text-xs tabular-nums text-gray-600 dark:text-gray-300">
        {meter.applicable ? (
          <>
            {meter.have} / {meter.of} {meter.unit}
          </>
        ) : (
          <>No {meter.unit} to measure</>
        )}
      </div>

      {/* Drill-down: expand to the specific under-documented items behind the percentage. */}
      {missing > 0 ? (
        <details className="mt-3 border-t border-gray-100 pt-2 dark:border-gray-700/60">
          <summary className="cursor-pointer list-none text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 [&::-webkit-details-marker]:hidden">
            {missing} under-documented →
          </summary>
          <ul className="mt-1 max-h-48 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-700/60">
            {meter.offenders.map((offender) => (
              <OffenderRow key={`${offender.index}-${offender.name}`} offender={offender} />
            ))}
          </ul>
        </details>
      ) : meter.applicable ? (
        <div className="mt-3 flex items-center justify-center gap-1 border-t border-gray-100 pt-2 text-xs font-medium text-emerald-600 dark:border-gray-700/60 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5" aria-hidden />
          All documented
        </div>
      ) : null}
    </div>
  );
}

/**
 * The documentation & schema coverage panel: a four-gauge row (described / titled / params documented
 * / output-schema adoption), each drill-down-able to the specific items it counts against. Handles its
 * own loading / error / no-capability states.
 */
export function DocCoveragePanel({ items, loading, error }: Props) {
  const meters = React.useMemo(() => mcpDocCoverageMeters(items ?? []), [items]);

  if (loading && !items) {
    return <LoadingState minHeightClassName="min-h-[160px]" message="Loading documentation coverage…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<BookOpen className="h-8 w-8 text-white" aria-hidden />}
        title="Coverage unavailable"
        description={error}
      />
    );
  }
  if (!items) return null;

  if (items.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<BookOpen className="h-8 w-8 text-white" aria-hidden />}
        title="No capabilities"
        description="This snapshot declares no tools, resources, or prompts whose documentation to measure."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {meters.map((meter) => (
        <CoverageGauge key={meter.key} meter={meter} />
      ))}
    </div>
  );
}

export default DocCoveragePanel;
