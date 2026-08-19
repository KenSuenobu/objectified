'use client';

/**
 * What a repository's scanner has actually been doing, as one small mark (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html` — the `scanbars` strip in the card's
 * footer and the table's *Importable* column, the `meter` beside a repository with an
 * importable share, the spinner while a scan runs, and the em dash when there is nothing yet.
 *
 * ### Four shapes, one decision
 *
 * Which of the four to draw is {@link repositoryIndexSnapshot}'s answer, not this component's:
 * the rule ("scan history wins over file counts, which win over the running spinner") is a
 * rule about data and belongs where it can be tested without a DOM. This file is only the
 * paint.
 *
 * ### Why the bars are not a `Sparkline`
 *
 * `ui/metrics/Sparkline` plots a *trend* — a continuous series where the shape between points
 * is meaningful. Ten scan outcomes are ten independent events, two-valued, and the one thing a
 * reader needs from them is which ones failed. A line through them would imply a trajectory
 * that does not exist. The importable share, by contrast, *is* a share of a finite thing, so
 * that one is the shared {@link Meter}.
 */

import * as React from 'react';

import { Meter } from '@/app/components/ui/metrics';
import { Spinner } from '@/app/components/ui/Spinner';
import { cn } from '@lib/utils';

import { repositoryIndexSnapshot, type DashboardRepository } from './repositoriesModel';

/** The tallest a succeeded-scan bar is drawn, as a share of the strip's height. */
const OK_BAR_HEIGHT = '100%';

/** …and a failed one, which is drawn short so a failure reads before its colour does. */
const FAILED_BAR_HEIGHT = '35%';

export interface RepositoryIndexMarkProps {
  /** The repository whose snapshot to draw. */
  repository: DashboardRepository;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * Render the mark. See {@link RepositoryIndexMarkProps}.
 *
 * @returns The scan strip, the importable meter, a spinner, or the em dash — each carrying the
 *   snapshot's sentence as its accessible name, so the shape is never the only account of it.
 */
export function RepositoryIndexMark({ repository, className }: RepositoryIndexMarkProps) {
  const snapshot = repositoryIndexSnapshot(repository);

  if (snapshot.kind === 'scans') {
    return (
      <span
        role="img"
        aria-label={snapshot.label}
        title={snapshot.label}
        data-testid="repository-scanbars"
        className={cn('repo-scanbars', className)}
      >
        {snapshot.bars.map((bar, index) => (
          <span
            key={`${bar.finishedAt}-${index}`}
            data-failed={bar.failed ? '' : undefined}
            style={{ blockSize: bar.failed ? FAILED_BAR_HEIGHT : OK_BAR_HEIGHT }}
          />
        ))}
      </span>
    );
  }

  if (snapshot.kind === 'meter') {
    // No importable tally yet: an empty track rather than a 0 % fill, which would report a
    // measured zero where the truth is that nothing has been measured.
    if (snapshot.percent === null) {
      return (
        <span
          role="img"
          aria-label={snapshot.label}
          title={snapshot.label}
          data-testid="repository-index-pending"
          className={cn('repo-index-pending', className)}
        >
          <span className="repo-index-pending__track" />
        </span>
      );
    }
    return (
      <span className={cn('repo-index-meter', className)} title={snapshot.label}>
        <Meter
          label={`Importable share of ${repository.name}`}
          value={snapshot.importable}
          max={snapshot.total}
          // A *score*, not a load: a high importable share is good news, and the usage bands
          // that turn 80 % amber would read backwards here.
          tone="ok"
          warnAt={null}
          thin
          // The share is printed by the wrapper, not by the meter: `Meter` inks its own figure
          // in the tone's saturated `-fg`, and `--ok-fg` at this size measures under 4.5:1 on
          // the plain surface in five of the nine themes (the same exposure HIVE-7.2 recorded
          // against this primitive). The wrapper's figure is `--fg-muted`, which clears AA
          // everywhere, and the bar beside it still carries the tone.
          showValue={false}
          valueText={snapshot.label}
          data-testid="repository-index-meter"
        />
        <span aria-hidden className="repo-index-meter__value">
          {snapshot.percent}%
        </span>
      </span>
    );
  }

  if (snapshot.kind === 'scanning') {
    return (
      <span
        data-testid="repository-index-scanning"
        className={cn('repo-index-mark', className)}
        title={snapshot.label}
      >
        <Spinner size="xs" label={snapshot.label} />
      </span>
    );
  }

  /*
   * `role="img"` with the sentence as its name, rather than an em dash beside an `sr-only`
   * span. The span was the honest markup and it broke the page: `sr-only` is
   * `position: absolute`, its containing block is the initial one rather than the table's
   * `overflow-x-auto` wrapper, so at a narrow viewport it sat at its static position ~900px
   * out and dragged the *document*'s scroll width with it. Measured by
   * `e2e/hive-repositories.spec.ts`, which is the only place it can be seen.
   */
  return (
    <span
      role="img"
      aria-label={snapshot.label}
      data-testid="repository-index-none"
      className={cn('repo-index-mark repo-index-mark--empty', className)}
      title={snapshot.label}
    >
      —
    </span>
  );
}

export default RepositoryIndexMark;
