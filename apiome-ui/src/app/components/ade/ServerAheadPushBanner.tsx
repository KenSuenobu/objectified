'use client';

/**
 * The server-ahead banner (git-like): the project's head moved after this reader's base.
 *
 * Re-skinned by HIVE-6.2 (#5313) to `docs/mockups/build/versions.html`'s
 * `.banner.banner--warn.banner--bar` — a full-width amber bar under the page header with the
 * title in weight, the API's detail beside it, and *Pull* / *Open merge* on the trailing edge.
 * It is `FEATURE_GITLIKE` data, so a non-production build marks it with the honey flag.
 */

import { CloudAlert, Download, GitMerge } from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { GitlikeFlag } from '@/app/components/ade/versions/GitlikeFlag';

type ServerAheadPushBannerProps = {
  /** Optional API detail (shown under the main line). */
  detail?: string;
  pullDisabled?: boolean;
  pullLoading?: boolean;
  onPull: () => void;
  onOpenMerge: () => void;
  /** Draw the honey `gitlike` flag beside the actions (non-production builds). */
  flagged?: boolean;
  /** Draw as a full-width bar under the page header rather than a rounded banner. */
  bar?: boolean;
};

export default function ServerAheadPushBanner({
  detail,
  pullDisabled,
  pullLoading,
  onPull,
  onOpenMerge,
  flagged = false,
  bar = false,
}: ServerAheadPushBannerProps) {
  return (
    <Alert
      variant="warn"
      bar={bar}
      role="alert"
      icon={<CloudAlert className="ver-banner__glyph" aria-hidden />}
      data-testid="server-ahead-push-banner"
      actions={
        <>
          {flagged ? <GitlikeFlag enabled /> : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pullDisabled || pullLoading}
            onClick={onPull}
          >
            <Download aria-hidden />
            {pullLoading ? 'Pulling…' : 'Pull'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onOpenMerge}>
            <GitMerge aria-hidden />
            Open merge
          </Button>
        </>
      }
    >
      <span className="ver-banner__title">Server is ahead of your last push.</span>{' '}
      <span className="ver-banner__body">Pull to integrate or open a merge.</span>
      {detail ? <span className="ver-banner__detail">{detail}</span> : null}
    </Alert>
  );
}
