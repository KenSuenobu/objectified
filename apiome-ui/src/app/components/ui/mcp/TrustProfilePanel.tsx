'use client';

/**
 * Composite trust profile radar (V2-MCP-31.4 / MCAT-17.4).
 *
 * The capstone of the endpoint **Insight** tab's *Reliability & trust* section: it collapses the
 * many scattered reliability/safety signals into one five-axis glance so an evaluator can size up a
 * server's trustworthiness at a look. From the `insight/trust` payload it renders three things:
 *
 * - a **composite headline** — the mean of the measured axes, toned by band, with an explicit
 *   "N of 5 signals measured" caption and a "heuristic composite, not an official rating" disclaimer;
 * - the **{@link Radar}** across the five normalized axes (quality, safety, documentation, stability,
 *   responsiveness), each 0–100; and
 * - a **per-axis list** — every axis's score, its one-line basis, and its methodology revealed on
 *   hover — with unmeasured axes shown as explicit *gaps* rather than zeros.
 *
 * The projections all come from the pure, unit-tested {@link mcpTrustProfileFromPayload} /
 * {@link mcpTrustRadarAxes} helpers, so the headline, the radar, and the list can never disagree. The
 * component owns its loading / error / empty (nothing measured yet) states. It is deliberately a
 * *heuristic* composite — a synthesized glance, not an official rating — and says so.
 */

import * as React from 'react';
import { Info, ShieldQuestion, Sparkles } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { STATUS_TONE_SOFT_CLASS } from '@/app/components/ui/statusVocabulary';
import { Radar, chartSeriesStyle } from '@/app/components/ui/mcp/charts';
import {
  MCP_TRUST_AXIS_MAX,
  MCP_TRUST_BAND_TONE,
  mcpTrustBand,
  mcpTrustFormatValue,
  mcpTrustRadarAxes,
  type McpTrustAxis,
  type McpTrustBand,
  type McpTrustProfile,
} from '@/app/components/ade/dashboard/mcp/mcpTrustUi';

interface Props {
  /** The parsed trust profile, or `null` while it has not loaded. */
  profile: McpTrustProfile | null;
  loading: boolean;
  error: string | null;
}

/**
 * The pair each score band renders its figure on.
 *
 * A `-fg` ink drawn straight onto the card measured 1.54–3.22:1 in the seven appearances that
 * inherit the light semantic pairs (HIVE-7.8, #5325 — the same exposure HIVE-7.7 recorded for
 * the health pill), so a figure that carries a tone wears the tone's *pair* and reads as a chip.
 * `.mcp-tone-figure` supplies the shape.
 */
const BAND_TEXT_TONE: Record<McpTrustBand, string> = {
  strong: STATUS_TONE_SOFT_CLASS.ok,
  fair: STATUS_TONE_SOFT_CLASS.warn,
  weak: STATUS_TONE_SOFT_CLASS.danger,
  gap: STATUS_TONE_SOFT_CLASS.neutral,
};

/** A small tone swatch drawn in the axis's own band colour (matches the radar fill language). */
function BandSwatch({ band }: { band: McpTrustBand }) {
  const style = chartSeriesStyle(MCP_TRUST_BAND_TONE[band]);
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden>
      <rect x={0} y={0} width={10} height={10} rx={2} className={style.fillClass} />
    </svg>
  );
}

/** One row of the per-axis list: swatch + label, the score (or a gap), the basis, and its methodology. */
function AxisRow({ axis }: { axis: McpTrustAxis }) {
  const band = mcpTrustBand(axis.value);
  return (
    <li className="flex items-start gap-2.5 py-2">
      <BandSwatch band={band} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-sm font-medium text-fg">
            {axis.label}
            {/* Methodology on hover — the native title makes it discoverable and accessible. */}
            <span
              className="inline-flex cursor-help text-fg-subtle"
              title={axis.methodology}
              aria-label={`How ${axis.label} is computed: ${axis.methodology}`}
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
            </span>
          </span>
          {axis.available ? (
            <span className={`mcp-tone-figure text-sm ${BAND_TEXT_TONE[band]}`}>
              {mcpTrustFormatValue(axis.value)}
              <span className="text-xs font-normal opacity-80">/100</span>
            </span>
          ) : (
            <span className="rounded-full bg-inset px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-fg-muted">
              Not measured
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-fg-muted">{axis.detail}</p>
      </div>
    </li>
  );
}

/**
 * The composite trust-profile panel. See the module doc for the acceptance criteria it satisfies —
 * the axes are computed from documented inputs, missing inputs render as explicit gaps (never zeros),
 * and each axis's methodology is shown on hover.
 */
export function TrustProfilePanel({ profile, loading, error }: Props) {
  if (loading && !profile) {
    return <LoadingState minHeightClassName="min-h-[220px]" message="Loading trust profile…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<ShieldQuestion className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Trust profile unavailable"
        description={error}
      />
    );
  }
  if (!profile) return null;

  // Nothing measurable yet: never discovered, never scored, never tested — an empty state, not a
  // radar collapsed to its centre.
  if (profile.availableCount === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<ShieldQuestion className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Not enough signal to profile yet"
        description="This server has not been scored, documented, changed, or tested enough to build a trust profile. Run discovery and test its tools to populate its axes."
      />
    );
  }

  const overallBand = mcpTrustBand(profile.overall);
  const radarAxes = mcpTrustRadarAxes(profile);
  const hasGaps = profile.availableCount < profile.axisCount;

  return (
    <div className="space-y-4" aria-busy={loading}>
      {/* Heuristic-composite disclaimer — this is a synthesized glance, not an official rating. */}
      <div className="flex items-start gap-2 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent-fg">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <p>
          A <span className="font-semibold">heuristic composite</span> synthesized from this
          server&apos;s quality, safety, documentation, stability, and responsiveness signals — a
          trust glance, not an official rating.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[auto,1fr] sm:items-center">
        {/* Radar + composite headline. */}
        <div className="flex flex-col items-center gap-2">
          <Radar
            axes={radarAxes}
            max={MCP_TRUST_AXIS_MAX}
            tone={MCP_TRUST_BAND_TONE[overallBand]}
            title={`Trust profile radar — overall ${mcpTrustFormatValue(profile.overall)} of 100`}
            className="h-40 w-40"
          />
          <div className="text-center">
            <div className={`mcp-tone-figure mcp-tone-figure--lead ${BAND_TEXT_TONE[overallBand]}`}>
              {mcpTrustFormatValue(profile.overall)}
              <span className="text-base font-normal text-fg-subtle">/100</span>
            </div>
            <div className="mt-0.5 text-xs text-fg-muted">
              overall ·{' '}
              <span className="font-semibold tabular-nums text-fg">
                {profile.availableCount}
              </span>{' '}
              of{' '}
              <span className="tabular-nums">{profile.axisCount}</span> signals measured
            </div>
          </div>
        </div>

        {/* Per-axis breakdown. */}
        <ul className="divide-y divide-border/60">
          {profile.axes.map((axis) => (
            <AxisRow key={axis.key} axis={axis} />
          ))}
        </ul>
      </div>

      {/* Gap footnote — spell out that unmeasured axes sit at the radar's centre, not at zero. */}
      {hasGaps ? (
        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Info className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          Unmeasured axes are shown as gaps at the centre — they are not scored zero, and are left
          out of the overall.
        </p>
      ) : null}
    </div>
  );
}
