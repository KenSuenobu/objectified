'use client';

/**
 * The project facts aside (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Related artifacts + project facts — the
 * right-hand card: *Id · Slug · Head · Last published · Publishable*, a hairline, then the
 * Published surface and Export studio links.
 *
 * One of the mockup's *Adds*: the screen this replaces put the project's identity nowhere but
 * the selector. Every fact here is already in the screen's state — nothing is fetched to draw
 * it — and the two links are the two Ship surfaces a project's revisions end up on.
 */

import * as React from 'react';
import Link from 'next/link';
import { Globe, PackageOpen } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';

import { shortRevisionId, type Project, type VersionsHeadLine } from './versionsModel';

/** Where the published surface lives. */
export const PUBLISHED_ROUTE = '/ade/dashboard/published';

/** Where the export studio lives. */
export const EXPORT_STUDIO_ROUTE = '/ade/dashboard/export/studio';

export interface ProjectFactsCardProps {
  /** The selected project. */
  project: Project;
  /** The head and last-published labels. */
  headLine: VersionsHeadLine;
  /** The head revision's id, for the mono `· ver_…` suffix. */
  headRevisionId: string | null;
  /** The last published revision's `published_at`, already formatted, or `null`. */
  lastPublishedAt: string | null;
  /** Whether the project is publishable (not a catalog item). */
  publishable: boolean;
}

/**
 * Render the facts card. See {@link ProjectFactsCardProps}.
 *
 * @returns The card.
 */
export default function ProjectFactsCard({
  project,
  headLine,
  headRevisionId,
  lastPublishedAt,
  publishable,
}: ProjectFactsCardProps) {
  return (
    <Card className="ver-facts" data-testid="versions-project-facts">
      <h2 className="ver-facts__title">Project</h2>
      <dl className="ver-kv">
        <dt>Id</dt>
        <dd className="mono" title={project.id}>
          {shortRevisionId(project.id)}
        </dd>
        <dt>Slug</dt>
        <dd className="mono">{project.slug || '—'}</dd>
        <dt>Head</dt>
        <dd className="mono">
          {headLine.head ?? '—'}
          {headRevisionId ? ` · ${shortRevisionId(headRevisionId)}` : ''}
        </dd>
        <dt>Last published</dt>
        <dd className="mono">
          {headLine.lastPublished ?? '—'}
          {lastPublishedAt ? ` · ${lastPublishedAt}` : ''}
        </dd>
        <dt>Publishable</dt>
        <dd>{publishable ? 'Yes (not a catalog item)' : 'No — catalog item'}</dd>
      </dl>
      <hr className="ver-facts__rule" />
      <div className="ver-facts__links">
        <Button variant="outline" size="sm" asChild>
          <Link href={PUBLISHED_ROUTE}>
            <Globe aria-hidden />
            Published surface
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={EXPORT_STUDIO_ROUTE}>
            <PackageOpen aria-hidden />
            Export studio
          </Link>
        </Button>
      </div>
    </Card>
  );
}
