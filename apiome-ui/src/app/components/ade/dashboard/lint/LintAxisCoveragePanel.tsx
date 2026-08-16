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
import {
  buildGovernanceDocsHref,
  lintAxisBand,
  lintAxisCompositeLabel,
  lintAxisScoreLabel,
  type LintAxis,
  type LintAxisBand,
  type LintAxisEvaluation,
} from '@/app/utils/lint-axis-ui';

const BAND_TEXT: Record<LintAxisBand, string> = {
  strong: 'text-emerald-700 dark:text-emerald-300',
  fair: 'text-amber-700 dark:text-amber-300',
  weak: 'text-rose-700 dark:text-rose-300',
  gap: 'text-gray-500 dark:text-gray-400',
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
      <span
        className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-700 dark:text-gray-300"
        title={axis.notAssessedReason ?? undefined}
      >
        Not assessed
      </span>
    );
  }
  return (
    <span className={cn('font-mono text-sm font-semibold tabular-nums', BAND_TEXT[band])}>
      {lintAxisScoreLabel(axis)}
    </span>
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
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {assessedCount} of {evaluation.axes.length} axes assessed
          {composite ? (
            <>
              {' '}
              · composite <span className="font-mono font-medium text-gray-700 dark:text-gray-200">{composite}</span>
            </>
          ) : (
            <> · composite withheld (required coverage incomplete)</>
          )}
        </p>
      </div>
      <p className="text-2xs text-gray-500 dark:text-gray-400">
        Algorithm{' '}
        <a
          href={buildGovernanceDocsHref(evaluation.algorithmDocsPage)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
          data-testid="lint-axis-algorithm-docs-link"
        >
          {evaluation.algorithmId}
        </a>{' '}
        v{evaluation.algorithmVersion}. Not assessed means no scanner evidence — it is not a clean
        score.
      </p>

      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
        <table className="min-w-full border-collapse text-left text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="bg-gray-50 text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">
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
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {evaluation.axes.map((axis) => (
              <tr key={axis.key} data-testid={`lint-axis-row-${axis.key}`}>
                <th
                  scope="row"
                  className="whitespace-nowrap px-3 py-2.5 font-medium text-gray-800 dark:text-gray-100"
                >
                  {axis.label}
                </th>
                <td className="px-3 py-2.5">
                  <AxisScoreCell axis={axis} />
                </td>
                <td className="px-3 py-2.5 font-mono text-xs uppercase text-gray-500 dark:text-gray-400">
                  {axis.coverageState}
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400">
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
