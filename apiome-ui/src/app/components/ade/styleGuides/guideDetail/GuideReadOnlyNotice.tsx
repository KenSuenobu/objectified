'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';

import type { GuideReadOnlyReason } from './guideDetailModel';

/**
 * Why this guide cannot be edited from here — HIVE-5.7 (#5310).
 *
 * Authority: `docs/mockups/govern/style-guide-detail.html`, its `.callout--honey` lock
 * banner and the **Notes → States** list, which fixes all four sentences.
 *
 * There are two reasons and two surfaces, and the copy differs across all four pairings:
 * the built-in guide is read-only *to everyone* and the way out is to duplicate it; a
 * member is read-only *on every guide* and the way out is to ask an administrator. Saying
 * "read-only" and stopping would leave both readers with no next step, which is the failure
 * DESIGN.md §8 names for an empty or gated state.
 *
 * `info`, not the untinted neutral the mockup paints: `Alert`'s neutral tone is
 * `--fg-muted` on `--bg-subtle`, which measures 4.35:1 in Solarized — under AA. HIVE-5.4
 * measured that pair and HIVE-5.6 made the same substitution on the guides list.
 */

/** Which surface the notice is standing on — the two have different next steps. */
export type GuideReadOnlySurface = 'rules' | 'custom-rules';

/** The four sentences, by reason and surface. */
const COPY: Record<GuideReadOnlySurface, Record<'builtin' | 'member', string>> = {
  rules: {
    builtin:
      'The built-in “Apiome Recommended” guide is read-only. Duplicate it from the Style ' +
      'Guides list to customize its rules.',
    member:
      'Only tenant administrators can change style guide rules. You can browse the catalog.',
  },
  'custom-rules': {
    builtin:
      'The built-in “Apiome Recommended” guide is read-only. Duplicate it from the Style ' +
      'Guides list to author custom rules.',
    member:
      'Only tenant administrators can edit custom rules. You can preview violations.',
  },
};

/** Props for {@link GuideReadOnlyNotice}. */
export interface GuideReadOnlyNoticeProps {
  /** Why, or `null` when the viewer may edit — in which case nothing is drawn. */
  reason: GuideReadOnlyReason;
  /** Which tab is asking. */
  surface: GuideReadOnlySurface;
}

/**
 * The read-only banner.
 *
 * @param props See {@link GuideReadOnlyNoticeProps}.
 * @returns The banner, or `null` when the viewer may edit.
 */
export default function GuideReadOnlyNotice({ reason, surface }: GuideReadOnlyNoticeProps) {
  if (!reason) return null;
  return (
    <Alert
      variant="info"
      icon={<Lock aria-hidden className="mt-px size-4 shrink-0" />}
      data-testid={`guide-readonly-${surface}`}
    >
      {COPY[surface][reason]}
    </Alert>
  );
}
