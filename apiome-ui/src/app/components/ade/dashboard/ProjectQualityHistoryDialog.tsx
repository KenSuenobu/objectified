'use client';

import { useId, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/Dialog';
import {
  buildQualityTrendPoints,
  getLatestProjectQualitySnapshotWithReport,
  snapshotHasLintReport,
  snapshotHasQualityReport,
  type ProjectQualityReportSection,
  type ProjectQualitySnapshot,
  type StoredLintFinding,
  type StoredQualityIssue,
} from '../../../utils/project-quality-score-history';
import { getNumericScoreTier } from '../../../utils/numeric-score-tier';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../ui/tabStyles';
import { cn } from '@lib/utils';
import { SVG_TEXT_SIZE } from '../../ui/svgTypography';

interface ProjectQualityHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  projectId: string;
  history: ProjectQualitySnapshot[];
  initialSection?: ProjectQualityReportSection;
}

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function severityBadgeClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') {
    return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
  }
  if (severity === 'medium') {
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  }
  return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
}

function QualityIssueList({ issues }: { issues: StoredQualityIssue[] }) {
  if (issues.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-center">
        <div>
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500" aria-hidden />
          <p className="text-sm font-medium text-gray-900 dark:text-white">No quality issues recorded</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            The analyzed specification met all tracked quality checks.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {issues.map((issue, index) => (
        <div
          key={`${issue.path}-${issue.message}-${index}`}
          className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30"
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className={cn(
                'mt-0.5 h-5 w-5 shrink-0',
                issue.severity === 'high'
                  ? 'text-red-500'
                  : issue.severity === 'medium'
                    ? 'text-amber-500'
                    : 'text-blue-500'
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="break-words text-sm font-medium text-gray-900 dark:text-white">
                  {issue.message}
                </span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', severityBadgeClass(issue.severity))}>
                  {issue.severity}
                </span>
                <span className="rounded bg-gray-200 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  {issue.category}
                </span>
              </div>
              {issue.suggestion ? (
                <p className="break-words text-sm text-gray-600 dark:text-gray-400">{issue.suggestion}</p>
              ) : null}
              {issue.path ? (
                <p className="mt-2 break-all font-mono text-xs text-gray-500 dark:text-gray-400">
                  {issue.path}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LintFindingList({ findings }: { findings: StoredLintFinding[] }) {
  if (findings.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-center">
        <div>
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-500" aria-hidden />
          <p className="text-sm font-medium text-gray-900 dark:text-white">No lint findings recorded</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            No structural errors or warnings were stored for this import.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {findings.map((finding, index) => (
        <div
          key={`${finding.type}-${finding.message}-${finding.path ?? ''}-${index}`}
          className={cn(
            'rounded-lg border p-4',
            finding.type === 'error'
              ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
              : 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
          )}
        >
          <div className="flex items-start gap-3">
            {finding.type === 'error' ? (
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
            ) : (
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            )}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'break-words text-sm font-medium',
                    finding.type === 'error'
                      ? 'text-red-900 dark:text-red-200'
                      : 'text-amber-900 dark:text-amber-200'
                  )}
                >
                  {finding.message}
                </span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', severityBadgeClass(finding.severity))}>
                  {finding.severity}
                </span>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide',
                    finding.type === 'error'
                      ? 'bg-red-200 text-red-900 dark:bg-red-900/50 dark:text-red-100'
                      : 'bg-amber-200 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100'
                  )}
                >
                  {finding.type}
                </span>
              </div>
              {finding.path ? (
                <p className="break-all font-mono text-xs text-gray-600 dark:text-gray-400">
                  {finding.path}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const SECTIONS: { id: ProjectQualityReportSection; label: string }[] = [
  { id: 'trend', label: 'Trend' },
  { id: 'quality', label: 'Quality' },
  { id: 'lint', label: 'Lint' },
];

export function ProjectQualityHistoryDialog({
  open,
  onOpenChange,
  projectName,
  projectId,
  history,
  initialSection = 'trend',
}: ProjectQualityHistoryDialogProps) {
  const gradId = `pqhist-${useId().replace(/\W/g, '')}`;
  const [section, setSection] = useState<ProjectQualityReportSection>(initialSection);

  const reportSnapshot = useMemo(() => {
    if (history.length === 0) return null;
    const fromHistory = [...history]
      .reverse()
      .find(
        (snap) =>
          snap.categories !== undefined || snap.issues !== undefined || snap.lintFindings !== undefined
      );
    return fromHistory ?? getLatestProjectQualitySnapshotWithReport(projectId) ?? history[history.length - 1];
  }, [history, projectId]);

  const overalls = history.map((h) => h.overall);
  const pts = buildQualityTrendPoints(overalls);
  const w = 400;
  const h = 160;
  const pad = 36;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  const lineD =
    pts.length === 0
      ? ''
      : pts
          .map((p, i) => {
            const x = pad + (p.x / 100) * innerW;
            const y = pad + (p.y / 100) * innerH;
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(' ');

  const areaD =
    lineD && pts.length > 0
      ? `${lineD} L ${pad + innerW} ${pad + innerH} L ${pad} ${pad + innerH} Z`
      : '';

  const first = history[0];
  const last = history[history.length - 1];
  const reportTier = reportSnapshot ? getNumericScoreTier(reportSnapshot.overall) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[90vh] max-h-[90vh] w-full min-w-0 max-w-2xl flex-col gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <div className="shrink-0 space-y-4 border-b border-gray-200 px-6 pb-4 pt-6 dark:border-gray-700">
          <DialogHeader className="pr-8">
            <DialogTitle className="truncate">Project scores — {projectName}</DialogTitle>
          </DialogHeader>

          <div className={TAB_LIST_CLASS} role="tablist" aria-label="Project score views">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={section === item.id}
                className={tabTriggerClass({ active: section === item.id })}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-6 py-4">
          {section === 'trend' ? (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                OpenAPI quality scores (0–100) recorded in this browser when an import finishes successfully. History is
                stored locally and is not synced across devices.
              </p>

              {history.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-500">
                  No snapshots yet. Import a specification to record the first score.
                </p>
              ) : (
                <>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
                    <svg
                      viewBox={`0 0 ${w} ${h}`}
                      className="h-40 w-full max-w-full text-indigo-500 dark:text-indigo-400"
                      role="img"
                      aria-label={`Quality trend from ${first ? formatShortDate(first.recordedAt) : ''} to ${last ? formatShortDate(last.recordedAt) : ''}`}
                    >
                      <title>Overall quality {overalls.join(', ')}</title>
                      {[0, 25, 50, 75, 100].map((tick) => {
                        const y = pad + ((100 - tick) / 100) * innerH;
                        return (
                          <g key={tick}>
                            <line
                              x1={pad}
                              y1={y}
                              x2={pad + innerW}
                              y2={y}
                              className="stroke-gray-200 dark:stroke-gray-700"
                              strokeWidth={1}
                            />
                            <text x={4} y={y + 4} fontSize={SVG_TEXT_SIZE.label} className="fill-gray-500 font-medium">
                              {tick}
                            </text>
                          </g>
                        );
                      })}
                      <defs>
                        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="currentColor" stopOpacity={0.2} />
                          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      {areaD ? <path d={areaD} fill={`url(#${gradId})`} /> : null}
                      {lineD ? (
                        <path
                          d={lineD}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.5}
                          vectorEffect="non-scaling-stroke"
                        />
                      ) : null}
                      {pts.map((p, i) => {
                        const cx = pad + (p.x / 100) * innerW;
                        const cy = pad + (p.y / 100) * innerH;
                        return (
                          <circle
                            key={`${p.x}-${p.y}-${i}`}
                            cx={cx}
                            cy={cy}
                            r={4}
                            className="fill-white stroke-current dark:fill-gray-900"
                            strokeWidth={2}
                          />
                        );
                      })}
                    </svg>
                    <div className="mt-2 flex justify-between px-1 text-xs text-gray-500 dark:text-gray-400">
                      <span>{first ? formatShortDate(first.recordedAt) : ''}</span>
                      <span>{last ? formatShortDate(last.recordedAt) : ''}</span>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                    <table className="w-full table-fixed text-sm">
                      <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
                        <tr>
                          <th className="w-[45%] px-3 py-2 font-semibold">Recorded</th>
                          <th className="w-[30%] px-3 py-2 font-semibold">Overall</th>
                          <th className="w-[25%] px-3 py-2 font-semibold">Grade</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {[...history].reverse().map((row, idx) => {
                          const tier = getNumericScoreTier(row.overall);
                          return (
                            <tr key={`${row.recordedAt}-${row.overall}-${idx}`}>
                              <td className="truncate px-3 py-2 text-gray-700 dark:text-gray-300">
                                {formatShortDate(row.recordedAt)}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`font-semibold tabular-nums ${tier.textClass}`}>{row.overall}</span>
                              </td>
                              <td className="px-3 py-2 text-gray-800 dark:text-gray-200">{row.grade}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          ) : null}

          {section === 'quality' ? (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Weighted quality breakdown and improvement suggestions from the most recent import that stored a detailed
                report.
              </p>
              {!reportSnapshot ? (
                <p className="py-8 text-center text-sm text-gray-500">No import scores recorded yet.</p>
              ) : !snapshotHasQualityReport(reportSnapshot) ? (
                <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  This snapshot only records the overall score ({reportSnapshot.overall}). Import again to capture category
                  breakdown and quality reasons.
                </p>
              ) : (
                <>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          From import on {formatShortDate(reportSnapshot.recordedAt)}
                        </p>
                        <p className={`mt-1 text-2xl font-bold tabular-nums ${reportTier?.textClass ?? ''}`}>
                          {reportSnapshot.overall}
                          <span className="ml-2 text-base font-semibold text-gray-600 dark:text-gray-300">
                            grade {reportSnapshot.grade}
                          </span>
                        </p>
                      </div>
                    </div>
                    {(reportSnapshot.categories?.length ?? 0) > 0 ? (
                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {reportSnapshot.categories!.map((cat) => {
                          const tier = getNumericScoreTier(cat.percent);
                          return (
                            <div
                              key={cat.id}
                              className="min-w-0 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className="min-w-0 break-words text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                                  {cat.label}
                                </span>
                                <span className={`shrink-0 text-sm font-bold tabular-nums ${tier.textClass}`}>
                                  {cat.points}/{cat.maxPoints}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{cat.percent}% of category</p>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  <QualityIssueList issues={reportSnapshot.issues ?? []} />
                </>
              )}
            </>
          ) : null}

          {section === 'lint' ? (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Structural validation errors and warnings from the most recent import that stored lint findings. The lint
                letter grade on the project card is derived from the overall quality score.
              </p>
              {!reportSnapshot ? (
                <p className="py-8 text-center text-sm text-gray-500">No import scores recorded yet.</p>
              ) : !snapshotHasLintReport(reportSnapshot) ? (
                <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  This snapshot only records the overall score ({reportSnapshot.overall}). Import again to capture lint
                  findings.
                </p>
              ) : (
                <>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-900/40">
                    <span className="text-gray-600 dark:text-gray-400">From import on </span>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {formatShortDate(reportSnapshot.recordedAt)}
                    </span>
                    <span className="mx-2 text-gray-300 dark:text-gray-600">·</span>
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {(reportSnapshot.lintFindings ?? []).filter((f) => f.type === 'error').length} errors
                    </span>
                    <span className="text-gray-500 dark:text-gray-400">, </span>
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {(reportSnapshot.lintFindings ?? []).filter((f) => f.type === 'warning').length} warnings
                    </span>
                  </div>
                  <LintFindingList findings={reportSnapshot.lintFindings ?? []} />
                </>
              )}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
