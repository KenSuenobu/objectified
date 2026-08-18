'use client';

/**
 * One of the two revision cards at the top of the compare dialog (HIVE-6.3, #5314).
 *
 * Authority: `docs/mockups/build/version-dialogs.html` §Compare — a flat card per side
 * carrying the version label, a Published pill, the revision note, the stored changelog and
 * the breaking hints extracted from it.
 *
 * It was written twice in `page.tsx`, once per side, with the amber hint line spelled
 * `text-amber-700 dark:text-amber-300` in both. Written once here the two sides cannot drift,
 * and the hint takes an `Alert`'s tone rather than a hue of its own.
 */

import * as React from 'react';

import { Badge } from '@/app/components/ui/Badge';

export interface CompareRevisionCardProps {
  /** The version label, already prefixed (`v2.3.1`). */
  label: string;
  /** Which side of the comparison this is — printed after the label, as the mockup prints it. */
  side: 'base' | 'compare to';
  /** Whether the revision is published; draws the Published pill. */
  published?: boolean;
  /** The revision's short message, if it has one. */
  revisionNote?: string | null;
  /** The stored changelog markdown, if any. */
  changelog?: string | null;
  /** Breaking hints extracted from the changelog. */
  breakingHints?: readonly string[];
}

/**
 * Render one side's card.
 *
 * @param props See {@link CompareRevisionCardProps}.
 * @returns The card.
 */
export function CompareRevisionCard({
  label,
  side,
  published = false,
  revisionNote,
  changelog,
  breakingHints = [],
}: CompareRevisionCardProps) {
  const note = revisionNote?.trim();
  const body = changelog?.trim();
  return (
    <div className="vdlg-revcard" data-side={side === 'base' ? 'base' : 'compare'}>
      <div className="vdlg-revcard__head">
        <span className="vdlg-revcard__label">
          {label} <span className="vdlg-quiet">({side})</span>
        </span>
        {published ? <Badge status="published">Published</Badge> : <Badge variant="outline">Draft</Badge>}
      </div>
      <div className="vdlg-revcard__note">
        <span className="vdlg-quiet">Revision note:</span> {note || '—'}
      </div>
      {body ? (
        <pre className="vdlg-revcard__changelog">{body}</pre>
      ) : (
        <p className="vdlg-quiet">No changelog</p>
      )}
      {breakingHints.length > 0 ? (
        <p className="vdlg-revcard__hints">
          <Badge variant="warn">Breaking hints</Badge>
          {breakingHints.join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

export default CompareRevisionCard;
