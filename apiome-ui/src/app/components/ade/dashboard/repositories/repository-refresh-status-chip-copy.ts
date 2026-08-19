/**
 * Presentational copy + tone classes for the per-file refresh status chip
 * (RAR-2.3, #3520).
 *
 * The REST read model surfaces `refresh_status` as one of the kebab-case codes
 * below (see apiome-rest `RefreshStatus`). This module is the single place
 * that maps a code to user-facing label + tooltip + tone classes, so the
 * repository file browser and any other surface render the state machine
 * identically. Kept pure (no React) so it is unit-testable in isolation, mirroring
 * `branch-divergence-chip-copy.ts`.
 */

/** Wire codes for the per-file refresh state (must match REST `RefreshStatus`). */
export type RefreshStatusCode =
  | 'up-to-date'
  | 'stale'
  | 'refreshing'
  | 'failed'
  | 'diverged';

export type RefreshStatusTone = RefreshStatusCode;

export interface RefreshStatusPresentation {
  /** Short chip label. */
  label: string;
  /** Longer hover/aria explanation of the state. */
  description: string;
  /** Tone key for class selection. */
  tone: RefreshStatusTone;
}

const PRESENTATION: Record<RefreshStatusCode, Omit<RefreshStatusPresentation, 'tone'>> = {
  'up-to-date': {
    label: 'Up to date',
    description: 'The imported version reflects the latest source commit.',
  },
  stale: {
    label: 'Stale',
    description: 'A newer source commit with changed content is available to import.',
  },
  refreshing: {
    label: 'Refreshing',
    description: 'A refresh is in progress for this file.',
  },
  failed: {
    label: 'Failed',
    description: 'The most recent refresh attempt failed; it will be retried.',
  },
  diverged: {
    label: 'Diverged',
    description:
      'The imported version was edited after import; auto-refresh is held until resolved.',
  },
};

/**
 * Resolve the chip label, description, and tone for a refresh status code.
 * Unknown/missing codes fall back to the neutral up-to-date presentation so the
 * UI never renders a blank chip.
 *
 * @param status The `refresh_status` code from the REST read model.
 * @returns Label, description, and tone for the chip.
 */
export function getRefreshStatusPresentation(
  status: string | null | undefined,
): RefreshStatusPresentation {
  const code = (status ?? '') as RefreshStatusCode;
  const copy = PRESENTATION[code] ?? PRESENTATION['up-to-date'];
  const tone: RefreshStatusTone = (code in PRESENTATION ? code : 'up-to-date');
  return { ...copy, tone };
}

/*
 * `refreshStatusChipToneClasses` was here until HIVE-7.5 (#5322).
 *
 * It returned a glass/border palette string per tone — `border-amber-300/60 bg-amber-50/50
 * text-amber-950 dark:border-amber-700/45 …` — which froze the chip on one light palette and
 * one dark one out of the nine the app ships. Both surfaces that drew it (the Specs tab and
 * the list page's refresh-activity panel) now render `ui/Badge` with the tone from
 * `REFRESH_STATUS_TONE` in `repositoriesModel`, so a refresh state is the same object as
 * every other status pill in the product. The copy above stays: a label and its explanation
 * are not presentation.
 */
