'use client';

/**
 * The honey `gitlike` flag (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` — its page-local `.flag` chip, drawn beside
 * every affordance that `FEATURE_GITLIKE` gates: the Merge button, the Change report tab, the
 * server-ahead banner, the tag and branch panels, the history-graph strip, eight row-menu
 * items and the Delete/Freeze confirms.
 *
 * It is a *marker*, not a badge in the status vocabulary: honey is DESIGN.md §2's brand
 * ornament for "new / preview / marker", never a warning, and the chip says one word. What it
 * marks and when it is drawn is decided by `gitlikeAffordance` in `versionsModel`; this only
 * paints it.
 */

import * as React from 'react';
import { Flag } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  GITLIKE_FLAG_LABEL,
  GITLIKE_FLAG_ON_TITLE,
  GITLIKE_FLAG_TITLE,
} from './versionsModel';

export interface GitlikeFlagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /**
   * Whether the flag is on in this build.
   *
   * Only the `title` changes: off says *compiled but hidden today*, on says *part of the
   * git-like feature set*. The chip itself is the same either way.
   */
  enabled?: boolean;
}

/**
 * Render the flag chip.
 *
 * @param props See {@link GitlikeFlagProps}; the rest lands on the `<span>`.
 * @returns The chip.
 */
export function GitlikeFlag({ enabled = false, className, title, ...props }: GitlikeFlagProps) {
  return (
    <span
      className={cn('ver-flag', className)}
      title={title ?? (enabled ? GITLIKE_FLAG_ON_TITLE : GITLIKE_FLAG_TITLE)}
      data-testid="gitlike-flag"
      {...props}
    >
      <Flag aria-hidden />
      {GITLIKE_FLAG_LABEL}
    </span>
  );
}

export default GitlikeFlag;
