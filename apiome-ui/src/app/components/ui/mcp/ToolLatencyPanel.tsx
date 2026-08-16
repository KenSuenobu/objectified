'use client';

/**
 * Tool latency & error-rate panel (V2-MCP-31.2 / MCAT-17.2).
 *
 * "How fast and how reliable is each tool on this server?" The test-console records a `latency_ms`
 * and an `is_error` per call; this panel turns the `tools` block of `insight/reliability` into three
 * views over a recent window:
 *
 * - an **error-rate headline** and call/tool totals over the window;
 * - a **latency distribution** of every tool call via {@link BarSeries}; and
 * - a **slowest** (by p95) and **flakiest** (by error rate) tool ranking, each row showing that
 *   tool's p50/p95/p99 and error rate.
 *
 * All ranking and formatting come from the pure, unit-tested helpers in {@link mcpReliabilityUi}, so
 * the numbers the rows show can never disagree with the totals. The component owns its loading /
 * error / empty (never tool-tested) states. A single-call tool renders its one sample as all three
 * percentiles without dividing by zero — the aggregation guarantees it.
 */

import * as React from 'react';
import { AlertTriangle, Gauge, Timer } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { BarSeries, type BarDatum } from '@/app/components/ui/mcp/charts';
import {
  mcpErrorRateKind,
  mcpFlakiestTools,
  mcpFormatErrorRate,
  mcpFormatMs,
  mcpSlowestTools,
  type McpToolLatency,
  type McpToolReliability,
} from '@/app/components/ade/dashboard/mcp/mcpReliabilityUi';

interface Props {
  /** The parsed per-tool reliability, or `null` while it has not loaded. */
  reliability: McpToolReliability | null;
  loading: boolean;
  error: string | null;
}

/** The endpoint-wide error-rate figure's colour by band — token classes only, no literals in JSX. */
const ERROR_RATE_TONE: Record<ReturnType<typeof mcpErrorRateKind>, string> = {
  healthy: 'text-emerald-600 dark:text-emerald-400',
  watch: 'text-amber-600 dark:text-amber-400',
  poor: 'text-red-600 dark:text-red-400',
};

/** A single latency percentile cell (label + value) in a ranking row. */
function PercentileCell({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="text-right">
      <div className="text-2xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
        {label}
      </div>
      <div className="tabular-nums text-gray-700 dark:text-gray-200">{mcpFormatMs(value)}</div>
    </div>
  );
}

/** One row of the "slowest tools" ranking: the tool name, its call count, and p50/p95/p99. */
function SlowestRow({ tool }: { tool: McpToolLatency }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-gray-100 bg-white px-3 py-2 text-xs dark:border-gray-800 dark:bg-gray-900/40">
      <div className="min-w-0">
        <div className="truncate font-medium text-gray-900 dark:text-gray-100" title={tool.tool_name}>
          {tool.tool_name}
        </div>
        <div className="text-2xs text-gray-500 dark:text-gray-400">
          <span className="tabular-nums">{tool.call_count}</span>{' '}
          {tool.call_count === 1 ? 'call' : 'calls'}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <PercentileCell label="p50" value={tool.latency.p50_ms} />
        <PercentileCell label="p95" value={tool.latency.p95_ms} />
        <PercentileCell label="p99" value={tool.latency.p99_ms} />
      </div>
    </li>
  );
}

/** One row of the "flakiest tools" ranking: the tool name and its error rate + error/call tally. */
function FlakiestRow({ tool }: { tool: McpToolLatency }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-gray-100 bg-white px-3 py-2 text-xs dark:border-gray-800 dark:bg-gray-900/40">
      <div className="min-w-0">
        <div className="truncate font-medium text-gray-900 dark:text-gray-100" title={tool.tool_name}>
          {tool.tool_name}
        </div>
        <div className="text-2xs text-gray-500 dark:text-gray-400">
          <span className="tabular-nums">{tool.error_count}</span> of{' '}
          <span className="tabular-nums">{tool.call_count}</span> errored
        </div>
      </div>
      <div className={`text-sm font-semibold tabular-nums ${ERROR_RATE_TONE[mcpErrorRateKind(tool.error_rate)]}`}>
        {mcpFormatErrorRate(tool.error_rate)}
      </div>
    </li>
  );
}

/**
 * The tool latency & error-rate panel. See the module doc for the acceptance criteria it satisfies
 * (percentiles/error rates match the fixture, a never-tested endpoint shows "no data", and a
 * single-call tool renders without dividing by zero).
 */
export function ToolLatencyPanel({ reliability, loading, error }: Props) {
  if (loading && !reliability) {
    return <LoadingState minHeightClassName="min-h-[200px]" message="Loading tool latency…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<Timer className="h-8 w-8 text-white" aria-hidden />}
        title="Tool latency unavailable"
        description={error}
      />
    );
  }
  if (!reliability) return null;

  // Never tool-tested: no calls recorded → an empty state, not an empty chart.
  if (reliability.call_count === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<Timer className="h-8 w-8 text-white" aria-hidden />}
        title="No tool calls yet"
        description="No tools on this server have been exercised in the test console recently, so there is no latency or error-rate data to show. Run a tool from the Test tab to start recording it."
      />
    );
  }

  const slowest = mcpSlowestTools(reliability.tools);
  const flakiest = mcpFlakiestTools(reliability.tools);
  const errorRateKind = mcpErrorRateKind(reliability.error_rate);
  const distribution: BarDatum[] = reliability.latency_distribution.map((bucket) => ({
    label: bucket.label,
    value: bucket.count,
  }));
  const hasDistribution = distribution.some((bar) => bar.value > 0);

  return (
    <div className="space-y-5" aria-busy={loading}>
      {/* Error-rate headline + call/tool totals over the window. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Error rate
          </div>
          <div className={`text-3xl font-semibold tabular-nums ${ERROR_RATE_TONE[errorRateKind]}`}>
            {mcpFormatErrorRate(reliability.error_rate)}
          </div>
          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            over{' '}
            <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-200">
              {reliability.call_count}
            </span>{' '}
            tool {reliability.call_count === 1 ? 'call' : 'calls'} across{' '}
            <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-200">
              {reliability.tool_count}
            </span>{' '}
            {reliability.tool_count === 1 ? 'tool' : 'tools'}
            {reliability.window_days > 0 ? ` · last ${reliability.window_days} days` : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-emerald-600 dark:text-emerald-400">
            <span className="font-semibold tabular-nums">{reliability.success_count}</span> ok
          </span>
          <span className="text-red-600 dark:text-red-400">
            <span className="font-semibold tabular-nums">{reliability.error_count}</span> errored
          </span>
        </div>
      </div>

      {/* Latency distribution — how the server's tool calls spread across latency ranges. */}
      {hasDistribution ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            <Gauge className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" aria-hidden />
            Latency distribution
          </div>
          <BarSeries
            data={distribution}
            tone="indigo"
            title="Tool-call latency distribution — number of calls per latency range"
            className="h-28"
          />
          <div className="flex flex-wrap justify-between gap-x-2 text-2xs text-gray-400 dark:text-gray-500">
            {distribution.map((bar) => (
              <span key={bar.label} className="tabular-nums">
                {bar.label}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Slowest / flakiest rankings, side by side on wide viewports. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            <Timer className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" aria-hidden />
            Slowest tools
            <span className="font-normal text-gray-400 dark:text-gray-500">by p95</span>
          </div>
          {slowest.length > 0 ? (
            <ul className="space-y-1.5">
              {slowest.map((tool) => (
                <SlowestRow key={tool.tool_name} tool={tool} />
              ))}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-gray-200 bg-gray-50/60 px-3 py-3 text-center text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-400">
              No completed tool calls recorded a latency yet.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" aria-hidden />
            Flakiest tools
            <span className="font-normal text-gray-400 dark:text-gray-500">by error rate</span>
          </div>
          {flakiest.length > 0 ? (
            <ul className="space-y-1.5">
              {flakiest.map((tool) => (
                <FlakiestRow key={tool.tool_name} tool={tool} />
              ))}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-emerald-200 bg-emerald-50/60 px-3 py-3 text-center text-xs text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300">
              No tool has errored in this window.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
