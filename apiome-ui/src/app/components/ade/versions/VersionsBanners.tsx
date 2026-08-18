'use client';

/**
 * The three timeline banners (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Banners — *Compatibility · What's new ·
 * Deprecation*, stacked above the timeline; DESIGN.md §7 (`.banner`).
 *
 * Each is derived, not fetched, by `versionsModel` from data the screen already holds:
 *
 * - **Compatibility** reads the newest published revision's stored change classification
 *   (`/api/projects/{id}/changelogs`, the same list the Changes tab draws) — *"v2.3.0 → v2.3.1
 *   has 2 non-breaking changes and no breaking changes"* — and offers the Changes tab.
 * - **What's new** is the head revision's note, and offers the Changes tab as well.
 * - **Deprecation** is the newest deprecated revision with a sunset or a message, and offers
 *   the sunset timeline and the migration guide (#507).
 *
 * Any of the three may be absent, and a project with one draft revision shows only the
 * second. They are `Alert`s — the app's `.banner` — with the title in weight and the body in
 * the same ink, never faded: DESIGN.md §9 does not fade text a reader is meant to read. Their
 * actions are `outline` buttons rather than the mockup's ghosts: a ghost draws its label in
 * `--fg-muted`, and on the light `-soft` tints the dark themes keep, that ink is invisible.
 */

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, ShieldCheck, Sparkles, Sunset, TriangleAlert } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { MIGRATION_GUIDE_ISSUE_URL } from '@/app/utils/revision-deprecation';

import type { CompatibilityBanner, DeprecationBanner, WhatsNewBanner } from './versionsModel';

/** Where the sunset timeline lives. */
export const SUNSET_TIMELINE_ROUTE = '/ade/dashboard/versions/sunset-timeline';

export interface VersionsBannersProps {
  /** The compatibility banner, or `null`. */
  compatibility: CompatibilityBanner | null;
  /** The what's-new banner, or `null`. */
  whatsNew: WhatsNewBanner | null;
  /** The deprecation banner, or `null`. */
  deprecation: DeprecationBanner | null;
  /** Whether the Changes tab exists — the two "open changes" actions need it. */
  changesAvailable: boolean;
  /** Switch to the Changes tab. */
  onOpenChanges: () => void;
}

/** The `Alert` tone for each compatibility verdict. */
const COMPAT_VARIANT: Readonly<Record<CompatibilityBanner['tone'], 'ok' | 'warn' | 'danger' | 'neutral'>> =
  {
    ok: 'ok',
    warn: 'warn',
    danger: 'danger',
    neutral: 'neutral',
  };

/**
 * Render whichever banners apply. See {@link VersionsBannersProps}.
 *
 * @returns The stack, or `null` when none applies.
 */
export default function VersionsBanners({
  compatibility,
  whatsNew,
  deprecation,
  changesAvailable,
  onOpenChanges,
}: VersionsBannersProps) {
  if (!compatibility && !whatsNew && !deprecation) return null;

  return (
    <div className="ver-banners" data-testid="versions-banners">
      {compatibility ? (
        <Alert
          variant={COMPAT_VARIANT[compatibility.tone]}
          icon={
            compatibility.tone === 'ok' ? (
              <ShieldCheck className="ver-banner__glyph" aria-hidden />
            ) : (
              <TriangleAlert className="ver-banner__glyph" aria-hidden />
            )
          }
          role="status"
          data-testid="versions-banner-compat"
          actions={
            changesAvailable ? (
              <Button variant="outline" size="sm" onClick={onOpenChanges}>
                View report
              </Button>
            ) : undefined
          }
        >
          <span className="ver-banner__title">{compatibility.title}</span>{' '}
          <span className="ver-banner__body">{compatibility.body}</span>
        </Alert>
      ) : null}

      {whatsNew ? (
        <Alert
          variant="info"
          icon={<Sparkles className="ver-banner__glyph" aria-hidden />}
          role="status"
          data-testid="versions-banner-whats-new"
          actions={
            changesAvailable ? (
              <Button variant="outline" size="sm" onClick={onOpenChanges}>
                Open changes
              </Button>
            ) : undefined
          }
        >
          <span className="ver-banner__title">
            What’s new in {whatsNew.versionLabel} ({whatsNew.status}).
          </span>{' '}
          <span className="ver-banner__body">{whatsNew.summary}</span>
        </Alert>
      ) : null}

      {deprecation ? (
        <Alert
          variant="warn"
          icon={<Sunset className="ver-banner__glyph" aria-hidden />}
          role="status"
          data-testid="versions-banner-deprecation"
          actions={
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href={SUNSET_TIMELINE_ROUTE}>Sunset timeline</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={MIGRATION_GUIDE_ISSUE_URL} target="_blank" rel="noopener noreferrer">
                  Migration guide
                  <ArrowUpRight aria-hidden />
                </a>
              </Button>
            </>
          }
        >
          <span className="ver-banner__title">
            {deprecation.versionLabel} is deprecated
            {deprecation.sunsetLabel ? ` — sunset ${deprecation.sunsetLabel}.` : '.'}
          </span>{' '}
          <span className="ver-banner__body">
            {deprecation.successorLabel ? (
              <>
                Successor <span className="mono">{deprecation.successorLabel}</span>.{' '}
              </>
            ) : null}
            {deprecation.message ? <>{deprecation.message} </> : null}
            Consumers see the same warning on compatibility checks (#507).
          </span>
        </Alert>
      ) : null}
    </div>
  );
}
