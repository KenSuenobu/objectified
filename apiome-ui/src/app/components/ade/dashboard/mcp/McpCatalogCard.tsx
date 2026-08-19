'use client';

/**
 * One endpoint in the grade-led MCP catalog (V2-MCP-24.8 / MCAT-10.8; redesigned HIVE-7.7, #5324).
 *
 * Authority: `docs/mockups/sources/mcp-servers.html` — the `.mcp-card` grid card and the
 * `.list-row` dense row, whose **Notes → Keeps (1:1)** list fixes what each of them carries:
 * grade glyph (with the score in the grid), logo, name, host, Published/Unpublished, transport,
 * visibility, auth, the `t · r · rt · p` counts, versions, health, recency, freshness, and the
 * Changed marker.
 *
 * ### What the redesign changed
 *
 * 1. **The card drew itself.** `rounded-lg border border-gray-200 bg-white p-4 shadow-sm
 *    dark:border-gray-700 dark:bg-gray-800` is `ui/Card`'s `hover` + `link` surface — the same
 *    panel every other card on every other screen is, so a card in the MCP catalog lifts on
 *    hover by the same 1 px and casts the same shadow as one in the spec catalog.
 * 2. **Hover and focus were indigo.** `group-hover:text-indigo-600 dark:group-hover:text-indigo-400`
 *    and a `focus-visible:ring-indigo-500` on both forms. DESIGN.md §0 retires indigo; the accent
 *    is azure, and the focus ring is the app-wide unlayered `*:focus-visible` rule, so neither is
 *    spelled here at all any more.
 * 3. **The counts and the arrow were greys.** `text-gray-600 dark:text-gray-300` and
 *    `text-gray-300` froze the quiet steps on two palettes; they are `--fg-muted` and
 *    `--fg-faint`, which follow all nine themes.
 * 4. **The Changed marker was an amber box** built from five palette classes. It is
 *    `Badge status="new"` — honey, which DESIGN.md §2 reserves for exactly this: a *new/changed*
 *    marker, a brand ornament rather than a warning.
 * 5. **There was no logo when the server advertised none.** The mockup draws a tinted initials
 *    avatar in that case, which is `ui/Avatar` — so every card has the same left edge and a
 *    reader can tell two similarly-named servers apart at a glance.
 *
 * One thing is deliberately *not* copied from the mockup: its unreachable card carries a
 * `--danger` inset frame. That frame measures 2.46:1 in Nord (the figure HIVE-7.5 recorded for
 * its own danger zone), so it is emphasis and never the only signal — the row beside it prints
 * "Unreachable" in words, and the card reads correctly with the frame ignored entirely.
 */

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { cn } from '@lib/utils';
import { Avatar } from '../../../ui/Avatar';
import { Badge } from '../../../ui/Badge';
import { cardVariants } from '../../../ui/Card';
import { GradeGlyph } from '../../../ui/mcp/GradeGlyph';
import { McpBadge } from '../../../ui/mcp/McpBadge';
import { HealthPill } from '../../../ui/mcp/HealthPill';
import { FreshnessPill } from '../../../ui/mcp/FreshnessPill';
import { RecencyPill } from '../../../ui/mcp/RecencyPill';
import {
  mcpAuthBadge,
  mcpHealthFromDiscoveryStatus,
  mcpPublishedBadge,
  mcpTransportBadge,
  mcpVisibilityBadge,
} from './mcpUiPrimitives';
import type { McpBrowseEndpoint } from './mcpBrowseUi';
import type { McpCatalogDensity } from './mcpCatalogUi';

export interface McpCatalogCardProps {
  endpoint: McpBrowseEndpoint;
  /** Detail route the card links to (e.g. `/ade/dashboard/mcp/<id>`). */
  href: string;
  /** Grid card (default) or a compact one-row dense-list entry. */
  density?: McpCatalogDensity;
  /** Render the "Changed since last view" marker (set by the page from the seen snapshot). */
  changed?: boolean;
}

/** What the capability-count string means, spelled out for the pointer and for `aria`. */
const CAPABILITY_COUNTS_TITLE = 'tools / resources / resource templates / prompts';

/**
 * The endpoint's mark: the server's advertised logo when it has one, else a tinted initials
 * avatar (the mockup's `.avatar--xs`).
 *
 * The logo is a *referenced* `https` URL the REST side already validated, so it is a plain
 * `<img>` rather than a `next/image` (which would proxy-fetch it through the optimizer) with
 * `referrerPolicy="no-referrer"` so loading it leaks nothing. Any failure falls back to the
 * initials rather than leaving a broken picture on the card. Decorative either way — the name
 * beside it is the accessible label.
 *
 * @param props The endpoint to mark.
 * @returns The logo or the initials chip.
 */
function EndpointMark({ endpoint }: { endpoint: McpBrowseEndpoint }): React.ReactElement {
  const [failed, setFailed] = React.useState(false);
  const iconUrl = endpoint.server_branding?.icon_url ?? null;
  if (iconUrl !== null && !failed) {
    return (
      <span className="mcp-card__logo" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element -- see the note above */}
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return <Avatar size="xs" name={endpoint.name} seed={endpoint.id} />;
}

/** The published / transport / visibility / auth badges an endpoint shows; auth only when present. */
function EndpointBadges({ endpoint }: { endpoint: McpBrowseEndpoint }): React.ReactElement {
  const published = mcpPublishedBadge(endpoint.published);
  const transport = mcpTransportBadge(endpoint.transport);
  const visibility = mcpVisibilityBadge(endpoint.visibility);
  const auth = endpoint.auth_scheme ? mcpAuthBadge(endpoint.auth_scheme) : null;
  return (
    <div className="mcp-card__badges">
      <McpBadge tone={published.tone}>{published.label}</McpBadge>
      <McpBadge tone={transport.tone}>{transport.label}</McpBadge>
      <McpBadge tone={visibility.tone}>{visibility.label}</McpBadge>
      {auth ? <McpBadge tone={auth.tone}>{auth.label}</McpBadge> : null}
    </div>
  );
}

/** Compact `3t · 2r · 1rt · 4p` capability counts with an accessible full label. */
function CapabilityCounts({ endpoint }: { endpoint: McpBrowseEndpoint }): React.ReactElement {
  return (
    <span className="mcp-card__caps" title={CAPABILITY_COUNTS_TITLE}>
      {endpoint.tool_count}t · {endpoint.resource_count}r · {endpoint.resource_template_count}rt ·{' '}
      {endpoint.prompt_count}p
    </span>
  );
}

/** Compact version-history count, e.g. `3 versions`. */
function VersionCount({ endpoint }: { endpoint: McpBrowseEndpoint }): React.ReactElement {
  const count = endpoint.version_count;
  return (
    <span className="mcp-card__caps" title="Discovery snapshots retained for this server">
      {count === 1 ? '1 version' : `${count} versions`}
    </span>
  );
}

/**
 * The "Changed since last view" marker.
 *
 * Honey, through `Badge status="new"`: DESIGN.md §2 spends honey on "new"/"starred"/"preview"
 * markers and forbids it meaning *warning*, which is exactly the distinction this chip needs —
 * a versioned surface is news, not a problem.
 */
function ChangedMarker(): React.ReactElement {
  return (
    <Badge status="new" title="This endpoint's surface has versioned since your last visit">
      <Sparkles aria-hidden />
      Changed
    </Badge>
  );
}

/**
 * `<McpCatalogCard>` — one endpoint in the grade-led catalog. The A–F grade glyph leads; the name
 * links to the endpoint detail; transport / visibility / auth render as badges; capability counts,
 * a health pill, and a recency pill summarize the surface. A "Changed" marker appears when the
 * endpoint versioned since the user's last visit. The `density` prop switches between the roomy
 * grid card and a compact dense-list row, sharing the same atoms.
 */
export const McpCatalogCard = React.forwardRef<HTMLAnchorElement, McpCatalogCardProps>(
  ({ endpoint, href, density = 'grid', changed = false }, ref) => {
    // The endpoint's reachability decides whether the card wears the emphasis frame. It is never
    // the only signal: the health pill beside it says the same thing in words.
    const health = mcpHealthFromDiscoveryStatus(endpoint.last_discovery_status);
    const alert = health === 'unreachable' || endpoint.quarantined ? 'danger' : undefined;

    if (density === 'list') {
      return (
        <Link
          ref={ref}
          href={href}
          className="mcp-row"
          data-alert={alert}
          data-testid={`mcp-row-${endpoint.id}`}
          aria-label={`Open ${endpoint.name}`}
        >
          <GradeGlyph grade={endpoint.grade} score={endpoint.score} size="sm" showScore={false} />
          <div className="mcp-row__main">
            <div className="mcp-row__title">
              <EndpointMark endpoint={endpoint} />
              <span className="mcp-row__name">{endpoint.name}</span>
              {changed ? <ChangedMarker /> : null}
              <FreshnessPill
                freshness={endpoint.freshness}
                lastKnownGoodAt={endpoint.last_known_good_at}
              />
            </div>
            <div className="mcp-row__sub">
              <CapabilityCounts endpoint={endpoint} />
              <span aria-hidden>·</span>
              <VersionCount endpoint={endpoint} />
              <span aria-hidden>·</span>
              <HealthPill discoveryStatus={endpoint.last_discovery_status} dotOnly />
            </div>
          </div>
          <div className="mcp-row__badges">
            <EndpointBadges endpoint={endpoint} />
          </div>
          <RecencyPill
            timestamp={endpoint.last_discovered_at}
            prefix=""
            hideIcon
            className="mcp-row__when"
          />
          <ArrowRight className="mcp-row__go" aria-hidden />
        </Link>
      );
    }

    return (
      <Link
        ref={ref}
        href={href}
        className={cn(cardVariants({ hover: true, link: true }), 'mcp-card')}
        data-alert={alert}
        data-testid={`mcp-card-${endpoint.id}`}
        aria-label={`Open ${endpoint.name}`}
      >
        <div className="mcp-card__head">
          <GradeGlyph grade={endpoint.grade} score={endpoint.score} size="md" />
          <div className="mcp-card__ident">
            <div className="mcp-card__title">
              <EndpointMark endpoint={endpoint} />
              <span className="mcp-card__name">{endpoint.name}</span>
              <ArrowRight className="mcp-card__go" aria-hidden />
            </div>
            <div className="mono mcp-card__host">{endpoint.host}</div>
          </div>
        </div>

        <EndpointBadges endpoint={endpoint} />

        <div className="mcp-card__foot">
          <div className="mcp-card__metrics">
            <CapabilityCounts endpoint={endpoint} />
            <span aria-hidden>·</span>
            <VersionCount endpoint={endpoint} />
          </div>
          <HealthPill discoveryStatus={endpoint.last_discovery_status} />
        </div>

        <div className="mcp-card__foot">
          <RecencyPill timestamp={endpoint.last_discovered_at} />
          <div className="mcp-card__marks">
            <FreshnessPill
              freshness={endpoint.freshness}
              lastKnownGoodAt={endpoint.last_known_good_at}
            />
            {changed ? <ChangedMarker /> : null}
          </div>
        </div>
      </Link>
    );
  },
);
McpCatalogCard.displayName = 'McpCatalogCard';
