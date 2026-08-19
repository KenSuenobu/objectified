'use client';

/**
 * One repository, as a card (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html` §Grid view — the hex avatar, the name
 * over the mono `owner/name`, the compact health icon beside the lifecycle pill and the row
 * menu, the description (or "No description"), the provider · branch · file-count meta row,
 * and the footer's last-scan phrase beside the index mark.
 *
 * ### The whole card opens the repository, and it is still one link
 *
 * The card this replaces was an absolutely-positioned `<Link>` stretched over the tile, with
 * the tile's own contents set `pointer-events: none` and three islands switched back on with
 * `pointer-events-auto` — a health badge, a status pill and a menu button that were reachable
 * by pointer but not, reliably, by keyboard order.
 *
 * This one is an `<article>` with no role of its own, and the repository's **name** is the
 * link. `.repo-card__link::after` stretches that one link over the card, which gives back the
 * big hit area; anything that must stay clickable sits on `.repo-card__above`, one stacking
 * step higher. One tab stop, one accessible name, the same pointer target. The same fix
 * `ProjectCard` (HIVE-6.1) and `CatalogCard` (HIVE-7.1) made, for the same `nested-interactive`
 * finding.
 *
 * ### A card that is broken says so with its frame
 *
 * A repository whose last scan failed takes an inset `--danger` hairline — the mockup's
 * treatment, but as a token rather than the inline `box-shadow` it spells. The frame, not a
 * fade: the text on a broken card is the text most likely to be read.
 *
 * @see `./repositoriesModel.ts` — every figure and every string on this card.
 */

import * as React from 'react';
import Link from 'next/link';
import { FileCode2, GitBranch } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Spinner } from '@/app/components/ui/Spinner';
import { RepositoryHealthBadge } from '@/app/components/ade/dashboard/repositories/RepositoryHealthBadge';
import { formatLastScan } from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';

import { ProviderBadge } from './ProviderBadge';
import { RepositoryIndexMark } from './RepositoryIndexMark';
import { RepositoryRowMenu, type RepositoryRowHandlers } from './RepositoryRowMenu';
import {
  REPOSITORY_STATUS_LABEL,
  REPOSITORY_STATUS_TONE,
  repositoryDetailHref,
  type DashboardRepository,
} from './repositoriesModel';

export interface RepositoryCardProps extends RepositoryRowHandlers {
  /** The repository this card is about. */
  repository: DashboardRepository;
  /** True while a write is in flight — the menu goes inert. */
  busy?: boolean;
}

/**
 * Render one repository card. See {@link RepositoryCardProps}.
 *
 * @returns The card.
 */
export function RepositoryCard({
  repository,
  busy = false,
  onOpenDetail,
  onRescan,
  onRemove,
}: RepositoryCardProps) {
  const failed = repository.status === 'error';
  const scanLabel = formatLastScan(repository.last_scanned_at, failed);

  return (
    <article
      className="repo-card"
      data-status={repository.status}
      data-testid="repository-card"
      data-repository-id={repository.id}
    >
      <div className="repo-card__body">
        <div className="repo-card__head">
          <Avatar shape="hex" size="lg" name={repository.name} id={repository.id} />
          <div className="repo-card__identity">
            <h3 className="repo-card__name">
              <Link href={repositoryDetailHref(repository.id)} className="repo-card__link">
                {repository.name}
              </Link>
            </h3>
            <p className="repo-card__full-name mono" title={repository.full_name}>
              {repository.full_name}
            </p>
          </div>
          <div className="repo-card__marks repo-card__above">
            {/* Health sits before the lifecycle status: "is it fine?" is read first. */}
            <RepositoryHealthBadge health={repository.health} compact />
            <Badge
              variant={REPOSITORY_STATUS_TONE[repository.status]}
              data-testid="repository-card-status"
            >
              {/* The badge's own word is what says "Scanning"; the spinner is decoration, so
                  it is hidden from assistive technology rather than announcing a second time. */}
              {repository.status === 'scanning' ? (
                <Spinner size="xs" label="Scanning" aria-hidden />
              ) : null}
              {REPOSITORY_STATUS_LABEL[repository.status]}
            </Badge>
            <RepositoryRowMenu
              repository={repository}
              busy={busy}
              onOpenDetail={onOpenDetail}
              onRescan={onRescan}
              onRemove={onRemove}
            />
          </div>
        </div>

        {/* Always two lines tall, so a grid of cards keeps its rhythm whether a repository
            carries a description or not. */}
        <p className="repo-card__summary" data-empty={repository.description ? undefined : ''}>
          {repository.description || 'No description'}
        </p>

        <div className="repo-card__meta">
          <ProviderBadge provider={repository.provider} />
          <span className="repo-card__fact" title={`Default branch: ${repository.default_branch}`}>
            <GitBranch aria-hidden />
            <span className="mono">{repository.default_branch}</span>
          </span>
          <span className="repo-card__fact">
            <FileCode2 aria-hidden />
            {(repository.total_files ?? 0).toLocaleString()} files
          </span>
        </div>
      </div>

      <footer className="repo-card__footer">
        <span className="repo-card__scan" data-failed={failed ? '' : undefined}>
          {scanLabel}
        </span>
        <span className="repo-card__above">
          <RepositoryIndexMark repository={repository} />
        </span>
      </footer>
    </article>
  );
}

export default RepositoryCard;
