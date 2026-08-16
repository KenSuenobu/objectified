'use client';

/**
 * The workspace findings queue table (CLX-4.1, #4859).
 *
 * Renders enriched finding rows with checkbox multi-select (the app's first bulk-select
 * surface), severity + decision badges, a "New" regression pill, subject/grade context,
 * and offset pagination. Selection state (a Set of selectionKey strings) lives in the page.
 */

import React from 'react';
import { Button, Checkbox } from '@/app/components/ui';
import { gradeChipClass, severityBadgeClass } from '@/app/utils/version-lint-report';
import { LintDecisionBadge } from '@/app/utils/lint-policy-ui';
import { selectionKey, type LintWorkspaceFinding } from '@/app/utils/lint-workspace';
import {
  dashboardTableTheadClass,
  dashboardTableWrapClass,
  dashboardTbodyClass,
  dashboardThClass,
  dashboardTrHoverClass,
} from '../../dashboardScreenClasses';
import { cn } from '@lib/utils';

const cellClass = 'px-6 py-3 text-sm text-gray-700 dark:text-gray-300 align-top';

export interface LintWorkspaceQueueTableProps {
  findings: LintWorkspaceFinding[];
  total: number;
  limit: number;
  offset: number;
  loading?: boolean;
  selected: Set<string>;
  onSelectionChange: (selected: Set<string>) => void;
  onOpenDetail: (finding: LintWorkspaceFinding) => void;
  onPageChange: (offset: number) => void;
}

/** Findings queue with bulk select + pagination. */
export default function LintWorkspaceQueueTable({
  findings,
  total,
  limit,
  offset,
  loading,
  selected,
  onSelectionChange,
  onOpenDetail,
  onPageChange,
}: LintWorkspaceQueueTableProps) {
  const pageKeys = findings.map(selectionKey);
  const allSelected = pageKeys.length > 0 && pageKeys.every((key) => selected.has(key));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) pageKeys.forEach((key) => next.delete(key));
    else pageKeys.forEach((key) => next.add(key));
    onSelectionChange(next);
  };

  const toggleOne = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  };

  return (
    <div className={dashboardTableWrapClass} data-testid="lint-workspace-queue">
      <table className="min-w-full">
        <thead className={dashboardTableTheadClass}>
          <tr>
            <th className="w-10 px-4 py-3">
              <Checkbox
                aria-label="Select all findings on this page"
                data-testid="queue-select-all"
                checked={allSelected}
                onCheckedChange={toggleAll}
              />
            </th>
            <th className={dashboardThClass}>Finding</th>
            <th className={dashboardThClass}>Severity</th>
            <th className={dashboardThClass}>State</th>
            <th className={dashboardThClass}>Subject</th>
            <th className={dashboardThClass}>Axis</th>
            <th className={dashboardThClass}>Source</th>
          </tr>
        </thead>
        <tbody className={dashboardTbodyClass}>
          {findings.map((finding) => {
            const key = selectionKey(finding);
            const path =
              typeof finding.location.path === 'string' ? finding.location.path : null;
            return (
              <tr
                key={`${key}|${finding.scannerId}`}
                data-testid="workspace-finding-row"
                className={cn(dashboardTrHoverClass, 'cursor-pointer')}
                onClick={() => onOpenDetail(finding)}
              >
                <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    aria-label={`Select finding ${finding.ruleId ?? finding.sourceFingerprint}`}
                    data-testid="queue-select-row"
                    checked={selected.has(key)}
                    onCheckedChange={() => toggleOne(key)}
                  />
                </td>
                <td className={cellClass}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {finding.ruleId ?? 'unknown-rule'}
                    </span>
                    {finding.isNew && (
                      <span
                        data-testid="finding-new-pill"
                        className="inline-flex items-center rounded bg-rose-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
                      >
                        New
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                    {finding.message}
                  </p>
                  {path && (
                    <p className="mt-0.5 font-mono text-2xs text-gray-400 dark:text-gray-500">
                      {path}
                    </p>
                  )}
                </td>
                <td className={cellClass}>
                  <span
                    className={cn(
                      'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide',
                      severityBadgeClass(finding.severity ?? ''),
                    )}
                  >
                    {finding.severity ?? '—'}
                  </span>
                </td>
                <td className={cellClass}>
                  <LintDecisionBadge state={finding.effectiveState} waived={finding.waived} />
                </td>
                <td className={cellClass}>
                  <div className="text-gray-900 dark:text-gray-100">
                    {finding.projectName ?? finding.subjectLabel ?? '—'}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                    {finding.projectName && finding.subjectLabel && (
                      <span>{finding.subjectLabel}</span>
                    )}
                    {finding.compositeGrade && (
                      <span
                        className={cn(
                          'inline-flex items-center rounded px-1 py-0 text-2xs font-semibold',
                          gradeChipClass(finding.compositeGrade),
                        )}
                      >
                        {finding.compositeGrade}
                      </span>
                    )}
                    {finding.subjectType === 'mcp_endpoint_version' && <span>MCP</span>}
                  </div>
                </td>
                <td className={cellClass}>{finding.axisKey.replace('_', ' ')}</td>
                <td className={cn(cellClass, 'font-mono text-xs')}>{finding.scannerId}</td>
              </tr>
            );
          })}
          {findings.length === 0 && !loading && (
            <tr>
              <td
                colSpan={7}
                className="px-6 py-10 text-center text-sm text-gray-500 dark:text-gray-400"
              >
                No findings match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="flex items-center justify-between border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span data-testid="queue-pagination-summary">
          {total === 0
            ? 'No findings'
            : `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="queue-prev-page"
            disabled={offset <= 0 || loading}
            onClick={() => onPageChange(Math.max(0, offset - limit))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="queue-next-page"
            disabled={offset + limit >= total || loading}
            onClick={() => onPageChange(offset + limit)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
