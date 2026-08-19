'use client';

/**
 * One provider's cached webhook ranges (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/webhook-allowlist.html` — the three-card provider grid: the
 * provider's name and glyph, a range count, the note, the refresh verdict, any last error, and
 * the CIDR chips themselves.
 *
 * ### Why staleness gets a frame and `skipped` does not
 *
 * A cached range list that stopped refreshing two weeks ago is a filter that will reject
 * legitimate deliveries the moment the provider moves its egress — so an overdue card takes
 * the warn frame *and* says "overdue" in its refresh line. A provider that publishes no list at
 * all is stale by the clock and settled in fact; drawing it amber for ever would train an
 * operator to ignore the colour on the cards that mean it. {@link isProviderOverdue} is where
 * that distinction is made, once.
 *
 * The provider's glyph is tinted by `.repo-provider[data-provider]` from the repositories
 * block (HIVE-7.3) rather than by a second table here — a GitLab mark is the same orange on
 * this screen as it is on the repositories list.
 */

import * as React from 'react';
import { Globe } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardContent } from '@/app/components/ui/Card';

import { ProviderGlyph } from './ProviderBadge';
import { REPOSITORY_PROVIDERS, type RepositoryProvider } from './repositoriesModel';
import {
  NO_RANGES_CACHED,
  type IpProvider,
  isProviderOverdue,
  providerLabel,
  rangeSourceTitle,
  refreshSummary,
} from './webhookAllowlistModel';

/**
 * The provider id as one the repositories block knows how to tint, or null.
 *
 * @param provider The allowlist provider id.
 * @returns The matching {@link RepositoryProvider}, or null for one this build has no mark
 *   for — which draws a neutral globe rather than nothing.
 */
function knownProvider(provider: string): RepositoryProvider | null {
  return (REPOSITORY_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as RepositoryProvider)
    : null;
}

export interface AllowlistProviderCardProps {
  /** The provider to draw. */
  provider: IpProvider;
}

/**
 * Render one provider card. See {@link AllowlistProviderCardProps}.
 *
 * @returns The card.
 */
export function AllowlistProviderCard({ provider }: AllowlistProviderCardProps) {
  const overdue = isProviderOverdue(provider);
  const known = knownProvider(provider.provider);
  const label = providerLabel(provider.provider);

  return (
    <Card
      className="wal-provider repo-provider"
      aria-label={`${label} ranges`}
      data-testid="provider-card"
      data-provider={provider.provider}
      data-stale={provider.stale ? 'true' : 'false'}
      data-overdue={overdue ? 'true' : undefined}
    >
      <CardContent className="wal-provider__body">
        <div className="wal-provider__head">
          <h3 className="wal-provider__name">
            {known ? (
              <ProviderGlyph provider={known} />
            ) : (
              <Globe className="repo-provider__glyph" aria-hidden />
            )}
            {label}
          </h3>
          <Badge variant="outline">
            {provider.rangeCount.toLocaleString()} range{provider.rangeCount === 1 ? '' : 's'}
          </Badge>
        </div>

        <p className="wal-provider__note">{provider.note}</p>
        <p
          className="wal-provider__refresh"
          data-overdue={overdue ? 'true' : undefined}
          data-testid="refresh-summary"
        >
          {refreshSummary(provider)}
        </p>

        {provider.lastError && provider.lastOutcome !== 'skipped' ? (
          <p className="wal-provider__error" role="status" data-testid="provider-error">
            {provider.lastError}
          </p>
        ) : null}

        {provider.ranges.length > 0 ? (
          <ul className="wal-provider__chips">
            {provider.ranges.map((range) => (
              <li
                key={range.cidr}
                className="wal-cidr mono"
                title={rangeSourceTitle(range.source)}
              >
                {range.cidr}
              </li>
            ))}
          </ul>
        ) : (
          <p className="wal-provider__empty">{NO_RANGES_CACHED}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default AllowlistProviderCard;
