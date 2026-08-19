'use client';

/**
 * Accessible multi-axis score/coverage table (CLX-1.2, #4849).
 *
 * Renders each axis with score/grade or an explicit "Not assessed" gap — never conflating gaps
 * with a clean (zero-finding) score. Primary surface is a semantic table; keeps CSS-token classes
 * only (no hard-coded colour literals).
 */

import * as React from 'react';
import { cn } from '@lib/utils';
import { Badge } from '@/app/components/ui/Badge';
import {
  buildGovernanceDocsHref,
  lintAxisBand,
  lintAxisCompositeLabel,
  lintAxisScoreLabel,
  type LintAxis,
  type LintAxisBand,
  type LintAxisEvaluation,
} from '@/app/utils/lint-axis-ui';

/**
 * The tone each band's score chip takes (HIVE-7.2, #5319).
 *
 * The mockup paints the figure itself — `<td class="t-num t-warn">61</td>` — and that is the
 * one thing the nine-theme sweep will not allow: `--warn-fg` measures 3.32:1 on the plain
 * surface in High contrast, 2.05:1 in Solarized and 1.59:1 in Nord, all under the 4.5:1 a
 * word needs. So the figure keeps the *pair* the tone was calibrated against — ink on its own
 * soft ground — as a `Badge`, which is the same move HIVE-7.1 made for the unavailable-format
 * chip. A gap has no tone at all: "Not assessed" is a state, not a grade.
 */
const BAND_TONE: Record<LintAxisBand, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  strong: 'ok',
  fair: 'warn',
  weak: 'danger',
  gap: 'neutral',
};

interface Props {
  evaluation: LintAxisEvaluation;
  className?: string;
  /** Optional heading override. */
  title?: string;
}

function AxisScoreCell({ axis }: { axis: LintAxis }) {
  const band = lintAxisBand(axis);
  if (!axis.assessed) {
    return (
      <Badge variant="outline" title={axis.notAssessedReason ?? undefined}>
        Not assessed
      </Badge>
    );
  }
  return (
    <Badge variant={BAND_TONE[band]} mono square>
      {lintAxisScoreLabel(axis)}
    </Badge>
  );
}

export function LintAxisCoveragePanel({
  evaluation,
  className,
  title = 'Score axes & coverage',
}: Props) {
  const composite = lintAxisCompositeLabel(evaluation);
  const assessedCount = evaluation.axes.filter((a) => a.assessed).length;

  return (
    <section
      className={cn('space-y-3', className)}
      data-testid="lint-axis-coverage-panel"
      aria-label={title}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="cid-panel__title">{title}</h3>
        <p className="text-xs text-fg-muted">
          {assessedCount} of {evaluation.axes.length} axes assessed
          {composite ? (
            <>
              {' '}
              · composite <span className="font-mono font-medium text-fg">{composite}</span>
            </>
          ) : (
            <> · composite withheld (required coverage incomplete)</>
          )}
        </p>
      </div>
      <p className="text-2xs text-fg-muted">
        Algorithm{' '}
        <a
          href={buildGovernanceDocsHref(evaluation.algorithmDocsPage)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-accent-fg underline-offset-2 hover:underline"
          data-testid="lint-axis-algorithm-docs-link"
        >
          {evaluation.algorithmId}
        </a>{' '}
        v{evaluation.algorithmVersion}. Not assessed means no scanner evidence — it is not a clean
        score.
      </p>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="min-w-full border-collapse text-left text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="bg-subtle text-2xs font-semibold uppercase tracking-wider text-fg">
            <tr>
              <th scope="col" className="px-3 py-2">
                Axis
              </th>
              <th scope="col" className="px-3 py-2">
                Score
              </th>
              <th scope="col" className="px-3 py-2">
                Coverage
              </th>
              <th scope="col" className="px-3 py-2">
                Notes
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {evaluation.axes.map((axis) => (
              <tr key={axis.key} data-testid={`lint-axis-row-${axis.key}`}>
                <th
                  scope="row"
                  className="whitespace-nowrap px-3 py-2.5 font-medium text-fg"
                >
                  {axis.label}
                </th>
                <td className="px-3 py-2.5">
                  <AxisScoreCell axis={axis} />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs uppercase text-fg-muted">
                  {axis.coverageState}
                </td>
                <td className="px-3 py-2.5 text-xs text-fg-muted">
                  {axis.assessed
                    ? `w=${axis.weight}`
                    : axis.notAssessedReason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
