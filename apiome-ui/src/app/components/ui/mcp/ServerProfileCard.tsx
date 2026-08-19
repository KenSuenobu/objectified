'use client';

import * as React from 'react';
import { ExternalLink, FileText, GitBranch, Server, ShieldCheck } from 'lucide-react';
import { cn } from '../../../../../lib/utils';
import { GradeGlyph } from './GradeGlyph';
import { HealthPill } from './HealthPill';
import { RecencyPill } from './RecencyPill';
import { McpBadge } from './McpBadge';
import {
  mcpProvenanceAddedViaBadge,
  mcpProvenanceTriggerBadge,
  mcpTransportBadge,
} from '../../ade/dashboard/mcp/mcpUiPrimitives';
import { mcpVersionSeqLabel } from '../../ade/dashboard/mcp/mcpVersionsUi';
import {
  mcpTypeCountTiles,
  type McpServerProfile,
} from '../../ade/dashboard/mcp/mcpInsightUi';

export interface ServerProfileCardProps extends React.HTMLAttributes<HTMLElement> {
  /** The assembled, presentation-ready server identity (see {@link mcpServerProfileFrom}). */
  profile: McpServerProfile;
  /**
   * Optional in-page href to the composite trust radar (MCAT-17.4) so the compact trust snapshot
   * links to the full signal. When omitted, the snapshot renders as static text.
   */
  trustHref?: string;
  /**
   * Optional handler to reveal the composite trust view — e.g. switch to its tab when the Insight
   * tab hosts the panels as tabs rather than one scrolling page. Takes precedence over `trustHref`:
   * when provided, the snapshot renders a button that calls this instead of an anchor.
   */
  onNavigateTrust?: () => void;
  /** Current time in epoch ms, injected for deterministic recency in tests. Defaults to "now". */
  nowMs?: number;
}

/**
 * The card's leading identity glyph: the server's advertised logo when it has one (V2-MCP-34.2),
 * otherwise the generic server icon. The logo is a *referenced* `https` URL the REST side already
 * validated (SSRF-safe, length-bounded); it is rendered with `referrerPolicy="no-referrer"` so
 * browsing it leaks nothing, and any load failure (dead link, non-image) falls back to the generic
 * glyph so the card is never broken.
 */
function ServerIdentityGlyph({ iconUrl, name }: { iconUrl: string | null; name: string }) {
  const [failed, setFailed] = React.useState(false);
  if (iconUrl !== null && !failed) {
    // A remote, per-server logo URL is not a build-time asset and must not go through the Next image
    // optimizer (which would proxy-fetch it) — so a plain <img> referencing the validated URL is intended.
    return (
      // eslint-disable-next-line @next/next/no-img-element -- see note above
      <img
        src={iconUrl}
        alt={`${name} logo`}
        className="h-5 w-5 shrink-0 rounded object-contain"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <Server className="h-5 w-5 shrink-0 text-accent-fg" aria-hidden />
  );
}

/** One compact capability-count chip (kind → count), rendered from the surface metrics. */
function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md bg-inset px-2 py-1 text-xs text-fg-muted">
      <span className="font-semibold tabular-nums text-fg">{value}</span>
      {label}
    </span>
  );
}

/**
 * `<ServerProfileCard>` — the at-a-glance "who is this server" identity card (V2-MCP-29.1 /
 * MCAT-15.1) that heads the endpoint Insight tab. It composes the shared MCP primitives (grade
 * glyph, transport badge, health & recency pills) into one header: the server's name/title/version,
 * negotiated protocol, transport, quality grade, capability counts, discovery-health, the "surface
 * last changed" recency, a compact trust snapshot linking to the composite trust radar (17.4), and
 * the server's `instructions` rendered prominently when present.
 *
 * It is purely presentational — every field is read from the pre-assembled {@link McpServerProfile},
 * which degrades each value to `null` — so an older (2025-03-26) server missing a title, an unscored
 * snapshot, or an unavailable surface all render a coherent card rather than a broken one. All colors
 * and spacing come from the shared tokens/primitives; no literals live here.
 */
export const ServerProfileCard = React.forwardRef<HTMLElement, ServerProfileCardProps>(
  ({ profile, trustHref, onNavigateTrust, nowMs, className, ...props }, ref) => {
    const transport = mcpTransportBadge(profile.transport);
    // The catalog name is a useful subtitle only when it differs from the server-reported name shown
    // as the headline (otherwise it would just repeat it).
    const showEndpointSubtitle =
      profile.endpointName !== null && profile.endpointName !== profile.displayName;
    const counts = profile.capabilityCounts;
    const countTiles = counts ? mcpTypeCountTiles(counts) : [];

    return (
      <section
        ref={ref}
        aria-label={`Server profile — ${profile.displayName}`}
        className={cn(
          'rounded-lg bg-surface p-5 shadow-sm',
          className,
        )}
        {...props}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* Identity: grade glyph + name, url, and the protocol / transport / snapshot chips. */}
          <div className="flex min-w-0 items-start gap-4">
            <GradeGlyph
              variant="gauge"
              size="sm"
              grade={profile.grade}
              score={profile.score}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-lg font-semibold text-fg">
                <ServerIdentityGlyph iconUrl={profile.iconUrl} name={profile.displayName} />
                <span className="truncate">{profile.displayName}</span>
                {profile.serverVersion ? (
                  <span className="shrink-0 text-sm font-medium text-fg-subtle">
                    {profile.serverVersion}
                  </span>
                ) : null}
              </h3>
              {showEndpointSubtitle ? (
                <div className="mt-0.5 truncate text-sm text-fg-muted">
                  {profile.endpointName}
                </div>
              ) : null}
              {profile.endpointUrl ? (
                <div className="mt-0.5 truncate font-mono text-xs text-fg-muted">
                  {profile.endpointUrl}
                </div>
              ) : null}
              {profile.websiteUrl ? (
                <a
                  href={profile.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  referrerPolicy="no-referrer"
                  className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded-sm text-xs font-medium text-accent-fg hover:underline"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{profile.websiteUrl}</span>
                </a>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <McpBadge tone={transport.tone}>{transport.label}</McpBadge>
                {profile.protocolVersion ? (
                  <McpBadge tone="slate" title="Negotiated MCP protocol version">
                    MCP {profile.protocolVersion}
                  </McpBadge>
                ) : (
                  <span className="text-xs text-fg-subtle">
                    protocol unknown
                  </span>
                )}
                {profile.versionSeq !== null ? (
                  <McpBadge tone={profile.isCurrent ? 'green' : 'indigo'}>
                    {mcpVersionSeqLabel(profile.versionSeq)}
                    {profile.isCurrent ? ' · current' : ''}
                  </McpBadge>
                ) : null}
              </div>
            </div>
          </div>

          {/* Health + "surface last changed" recency, right-aligned. */}
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <HealthPill discoveryStatus={profile.discoveryStatus} />
            <RecencyPill
              timestamp={profile.lastChangedAt}
              prefix="Surface changed"
              nowMs={nowMs}
            />
          </div>
        </div>

        {/* Capability counts — only when the surface resolved. */}
        {counts ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <CountChip label="capabilities" value={counts.total} />
            <span className="text-fg-faint" aria-hidden>
              ·
            </span>
            {countTiles.map((tile) => (
              <CountChip key={tile.key} label={tile.label.toLowerCase()} value={tile.value} />
            ))}
          </div>
        ) : null}

        {/* Provenance strip (V2-MCP-34.5) — how the catalog knows this server: how the endpoint
            was added, and which discovery run produced the shown snapshot. Rendered whenever the
            endpoint record resolved; an unattributed snapshot reads "unrecorded", never a
            concrete origin. */}
        {profile.addedVia !== null ? (
          <div
            data-testid="provenance-strip"
            className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-fg-muted"
          >
            <GitBranch className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
            <span className="font-medium text-fg-muted">Provenance</span>
            <McpBadge
              tone={mcpProvenanceAddedViaBadge(profile.addedVia).tone}
              title="How this endpoint entered the catalog"
            >
              {mcpProvenanceAddedViaBadge(profile.addedVia).label}
            </McpBadge>
            {profile.versionSeq !== null ? (
              <>
                <span className="text-fg-faint" aria-hidden>
                  ·
                </span>
                <span>this snapshot via</span>
                <McpBadge
                  tone={mcpProvenanceTriggerBadge(profile.versionOrigin).tone}
                  title="Which discovery run produced the shown snapshot"
                >
                  {mcpProvenanceTriggerBadge(profile.versionOrigin).label}
                </McpBadge>
              </>
            ) : null}
          </div>
        ) : null}

        {/* Compact trust snapshot — a teaser for the composite trust radar (MCAT-17.4). */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-fg-muted">
          <ShieldCheck className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
          <span className="font-medium text-fg-muted">Trust</span>
          <span>
            Quality grade{' '}
            <span className="font-semibold text-fg">
              {profile.grade ?? '—'}
            </span>
            {profile.score !== null ? ` (${Math.round(profile.score)}/100)` : ''}
          </span>
          {onNavigateTrust ? (
            <button
              type="button"
              onClick={onNavigateTrust}
              className="ml-auto rounded-sm font-medium text-accent-fg hover:underline"
            >
              Composite trust radar →
            </button>
          ) : trustHref ? (
            <a
              href={trustHref}
              className="ml-auto rounded-sm font-medium text-accent-fg hover:underline"
            >
              Composite trust radar →
            </a>
          ) : (
            <span className="ml-auto text-fg-subtle">
              Composite trust radar coming soon
            </span>
          )}
        </div>

        {/* Server instructions, rendered prominently when present. */}
        {profile.instructions ? (
          <div className="mt-4">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-fg">
              <FileText className="h-4 w-4 text-fg-muted" aria-hidden />
              Instructions
            </h4>
            <div className="rounded-lg bg-inset p-3">
              <p className="whitespace-pre-wrap text-sm text-fg-muted">
                {profile.instructions}
              </p>
            </div>
          </div>
        ) : null}
      </section>
    );
  },
);
ServerProfileCard.displayName = 'ServerProfileCard';
