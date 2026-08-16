'use client';

/**
 * Peer percentile & category ranking (V2-MCP-32.3 / MCAT-18.3).
 *
 * "Is this a good weather server?" needs a *peer baseline*, not an absolute grade. This panel — on the
 * endpoint **Insight** tab's *Reliability & trust* section — ranks the server against the other live
 * servers in its catalog **category** on four axes (grade, safety, documentation, latency). From the
 * `insight/percentile` payload it renders, per axis, a **"top N%" badge** toned by relative standing,
 * the server's own value, and its "rank K of N" basis — so an evaluator sees not just that a server
 * scores 70 for documentation, but that that puts it in the *top 10% of finance servers*.
 *
 * The projections come from the pure, unit-tested {@link mcpPeerPercentileFromPayload} and its band /
 * badge helpers, so the badge, the tone, and the caption can never disagree. The component owns its
 * loading / error / nothing-ranked-yet states; a single-member category is called out explicitly
 * rather than shown as a meaningless "top 100%", and any unmeasured axis is a labelled gap, never a
 * misleading zero. Every colour resolves from a token via the shared {@link McpBadge} — no colour
 * literal appears here.
 */

import * as React from 'react';
import { Info, Trophy, Users } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { McpBadge } from '@/app/components/ui/mcp/McpBadge';
import {
  MCP_PEER_BAND_TONE,
  mcpPeerBadgeLabel,
  mcpPeerBand,
  mcpPeerCategoryLabel,
  type McpPeerAxis,
  type McpPeerPercentileProfile,
} from '@/app/components/ade/dashboard/mcp/mcpPeerPercentileUi';

interface Props {
  /** The parsed peer-ranking profile, or `null` while it has not loaded. */
  profile: McpPeerPercentileProfile | null;
  loading: boolean;
  error: string | null;
}

/** One row of the per-axis ranking: label, the "top N%" badge (or a gap), the value, and the basis. */
function AxisRow({ axis }: { axis: McpPeerAxis }) {
  const badgeLabel = mcpPeerBadgeLabel(axis);
  const tone = MCP_PEER_BAND_TONE[mcpPeerBand(axis)];
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{axis.label}</div>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{axis.detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {axis.available ? (
          <span className="text-sm font-semibold tabular-nums text-gray-700 dark:text-gray-200">
            {axis.value}
            <span className="text-xs font-normal text-gray-400 dark:text-gray-500">/100</span>
          </span>
        ) : null}
        {badgeLabel ? (
          <McpBadge tone={tone}>{badgeLabel}</McpBadge>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-700 dark:text-gray-300">
            Not ranked
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * The peer percentile & category ranking panel. See the module doc for the acceptance criteria it
 * satisfies — the ranking is a peer baseline within the category, single-member categories are handled
 * explicitly, and unmeasured axes render as labelled gaps rather than zeros.
 */
export function PeerPercentilePanel({ profile, loading, error }: Props) {
  if (loading && !profile) {
    return <LoadingState minHeightClassName="min-h-[200px]" message="Loading peer ranking…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<Trophy className="h-8 w-8 text-white" aria-hidden />}
        title="Peer ranking unavailable"
        description={error}
      />
    );
  }
  if (!profile) return null;

  // Nothing to rank against or nothing measured yet — a first-run state, not an error.
  if (profile.rankedCount === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<Trophy className="h-8 w-8 text-white" aria-hidden />}
        title="Not enough peers to rank yet"
        description="This server has no measured axis to rank, or no peers in its category to rank against. Register and discover more servers in this category — then grade, documentation, safety, and latency rankings appear here."
      />
    );
  }

  const categoryLabel = mcpPeerCategoryLabel(profile.category);
  const soleMember = profile.cohortSize <= 1;

  return (
    <div className="space-y-4" aria-busy={loading}>
      {/* Cohort context — who this server is being ranked against. */}
      <div className="flex items-start gap-2 rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800 dark:border-indigo-900/40 dark:bg-indigo-900/20 dark:text-indigo-200">
        <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {soleMember ? (
          <p>
            The only server in the{' '}
            <span className="font-semibold">{categoryLabel}</span> category — it leads its cohort by
            default. Add more servers in this category for a meaningful ranking.
          </p>
        ) : (
          <p>
            Ranked against{' '}
            <span className="font-semibold tabular-nums">{profile.cohortSize}</span>{' '}
            <span className="font-semibold">{categoryLabel}</span> — a peer baseline within its
            category, not an absolute grade.
          </p>
        )}
      </div>

      <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
        {profile.axes.map((axis) => (
          <AxisRow key={axis.key} axis={axis} />
        ))}
      </ul>

      {profile.rankedCount < profile.axes.length ? (
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Info className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
          Unranked axes have no measurement on this server yet — they are not counted as a low rank.
        </p>
      ) : null}
    </div>
  );
}
