'use client';

/**
 * Discovery health & availability timeline (V2-MCP-31.1 / MCAT-17.1).
 *
 * "Is this server actually reachable, and has it been reliable over time?" The endpoint record only
 * carries the *last* discovery outcome; this panel shows the trajectory. From the `health` block of
 * `insight/reliability` it renders three things:
 *
 * - an **availability %** over the recent discovery window (ok / (ok + failed) terminal jobs);
 * - a **timeline** of each recent discovery job's outcome (ok / unreachable / auth_error / …) as a
 *   colour-coded status strip via {@link StackedTimeline}, with a per-code failure breakdown; and
 * - the endpoint's **backoff / quarantine** state — a prominent banner when the server has tripped
 *   the consecutive-failure threshold and been auto-excluded from the discovery sweep.
 *
 * All series-shaping and tallies come from the pure, unit-tested {@link mcpDiscoveryHealthTimeline}
 * projection over the parsed health, so the strip, the counts, and the availability figure can never
 * disagree. The component owns its loading / error / empty states.
 */

import * as React from 'react';
import { Activity, AlertOctagon, Clock, ShieldOff } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { STATUS_TONE_SOFT_CLASS } from '@/app/components/ui/statusVocabulary';
import { StackedTimeline, chartSeriesStyle } from '@/app/components/ui/mcp/charts';
import {
  mcpAvailabilityKind,
  mcpDiscoveryEventLabel,
  mcpDiscoveryEventTime,
  mcpDiscoveryHealthTimeline,
  mcpDiscoveryOutcomeLabel,
  type McpDiscoveryHealth,
} from '@/app/components/ade/dashboard/mcp/mcpReliabilityUi';

interface Props {
  /** The parsed discovery health, or `null` while it has not loaded. */
  health: McpDiscoveryHealth | null;
  loading: boolean;
  error: string | null;
}

/** The availability figure's colour by health band — token classes only, no literals in consumers. */
const AVAILABILITY_TONE: Record<
  ReturnType<typeof mcpAvailabilityKind>,
  string
> = {
  healthy: STATUS_TONE_SOFT_CLASS.ok,
  degraded: STATUS_TONE_SOFT_CLASS.warn,
  poor: STATUS_TONE_SOFT_CLASS.danger,
  unknown: STATUS_TONE_SOFT_CLASS.neutral,
};

/** One legend row: a swatch drawn with the band's own chart colour, plus its label. */
function LegendSwatch({ tone, label }: { tone: 'green' | 'red' | 'neutral'; label: string }) {
  const style = chartSeriesStyle(tone);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden>
        <rect x={0} y={0} width={10} height={10} rx={2} className={style.fillClass} />
      </svg>
      {label}
    </span>
  );
}

/**
 * The discovery-health panel. See the module doc for the acceptance criteria it satisfies (the
 * timeline matches the seeded job history, the availability % matches a hand count, a quarantined
 * endpoint is clearly flagged, and an empty history shows an empty state).
 */
export function DiscoveryHealthPanel({ health, loading, error }: Props) {
  if (loading && !health) {
    return <LoadingState minHeightClassName="min-h-[200px]" message="Loading discovery health…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<Activity className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Discovery health unavailable"
        description={error}
      />
    );
  }
  if (!health) return null;

  // Never discovered and never quarantined: no history at all → an empty state, not an empty chart.
  if (health.event_count === 0 && !health.quarantined && !health.last_discovered_at) {
    return (
      <EmptyState
        variant="compact"
        icon={<Activity className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="No discovery history yet"
        description="This endpoint has not been discovered yet, so there is no reliability timeline to show. Run discovery to start recording its health."
      />
    );
  }

  const timeline = mcpDiscoveryHealthTimeline(health);
  const availabilityKind = mcpAvailabilityKind(health.availability_pct);
  const availabilityText =
    health.availability_pct === null ? '—' : `${health.availability_pct}%`;

  return (
    <div className="space-y-4" aria-busy={loading}>
      {/* Quarantine banner — the auto-disable state the AC asks us to flag prominently. */}
      {health.quarantined ? (
        <div className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger-fg">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-0.5">
            <p className="font-semibold">Quarantined — auto-excluded from discovery</p>
            <p>
              This server tripped the consecutive-failure threshold and is paused until it recovers.
              {health.quarantine_reason ? (
                <>
                  {' '}
                  Reason: <span className="font-medium">{health.quarantine_reason}</span>.
                </>
              ) : null}
            </p>
            {health.quarantined_at ? (
              <p>
                Since {mcpDiscoveryEventTime(health.quarantined_at)} ·{' '}
                <span className="tabular-nums">{health.consecutive_failures}</span> consecutive{' '}
                {health.consecutive_failures === 1 ? 'failure' : 'failures'}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Availability headline + outcome tallies over the window. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-fg-muted">
            Availability
          </div>
          <div className={`mcp-tone-figure mcp-tone-figure--lead mt-1 ${AVAILABILITY_TONE[availabilityKind]}`}>
            {availabilityText}
          </div>
          <div className="mt-0.5 text-xs text-fg-muted">
            over{' '}
            <span className="font-semibold tabular-nums text-fg">
              {health.terminal_count}
            </span>{' '}
            completed {health.terminal_count === 1 ? 'attempt' : 'attempts'}
            {health.truncated ? ' (most recent)' : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className={`mcp-tone-figure ${STATUS_TONE_SOFT_CLASS.ok}`}>
            {health.ok_count} ok
          </span>
          <span className={`mcp-tone-figure ${STATUS_TONE_SOFT_CLASS.danger}`}>
            {health.failed_count} failed
          </span>
          {health.pending_count > 0 ? (
            <span className="text-fg-muted">
              <span className="font-semibold tabular-nums">{health.pending_count}</span> pending
            </span>
          ) : null}
        </div>
      </div>

      {/* Outcome timeline — one colour-coded column per recent discovery job, oldest→newest. */}
      {timeline.hasEvents ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <LegendSwatch tone="green" label="OK" />
            <LegendSwatch tone="red" label="Failed" />
            {health.pending_count > 0 ? <LegendSwatch tone="neutral" label="Pending" /> : null}
          </div>
          <StackedTimeline
            series={timeline.series}
            periods={timeline.periods}
            domainMax={1}
            title="Discovery outcomes over time — ok, failed, and in-flight jobs"
            periodActionLabel={(_period, index) =>
              mcpDiscoveryEventLabel(timeline.events[index])
            }
          />
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border bg-inset px-3 py-4 text-center text-xs text-fg-muted">
          No discovery jobs recorded in the recent window yet.
        </p>
      )}

      {/* Per-code failure breakdown — what the failures actually were. */}
      {timeline.failures.length > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
            <AlertOctagon className="size-3.5 text-danger" aria-hidden />
            Failure breakdown
          </div>
          <div className="flex flex-wrap gap-2">
            {timeline.failures.map((failure) => (
              <span
                key={failure.code}
                className="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2.5 py-1 text-xs text-danger-fg"
              >
                <span className="font-medium">{failure.label}</span>
                <span className="tabular-nums">×{failure.count}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Last-attempt footnote — the most recent outcome and when it ran. */}
      {health.last_status || health.last_discovered_at ? (
        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Clock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          Last discovery
          {health.last_status ? (
            <>
              {' '}
              <span className="font-medium text-fg">
                {mcpDiscoveryOutcomeLabel(health.last_status)}
              </span>
            </>
          ) : null}
          {health.last_discovered_at ? (
            <> · {mcpDiscoveryEventTime(health.last_discovered_at)}</>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
