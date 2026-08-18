'use client';

/**
 * Project scores — Trend / Quality / Lint (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html` §"Project scores" overlay — three underline
 * tabs, a gridded trend chart over a dense `Recorded · Overall · Grade` table, the quality
 * ring beside its grade with per-category meters and the improvement cards, and the lint
 * banner over its findings.
 *
 * ### Kept 1:1, re-skinned entirely
 *
 * Every sentence, empty state and derivation is the one this screen already had — the ticket
 * asks for "their existing copy and empty states", and the copy is what tells a reader that
 * this history is browser-local and unsynced. What changed is that none of it names a colour
 * any more. It carried eleven palettes: `bg-red-100 / text-red-800`, `bg-amber-100`,
 * `bg-blue-100`, `border-red-200 bg-red-50`, `text-emerald-500`, `stroke-gray-200`,
 * `fill-gray-500`, `text-indigo-500 dark:text-indigo-400` for the chart, and three
 * `text-gray-*` quiet lines. They are the shared vocabulary now — `statusTone` for a
 * severity, `Ring` and `Meter` for a score, `Badge` for a pill — so a *medium* here is the
 * same amber as a *medium* in the lint workspace.
 *
 * ### Opened from three screens
 *
 * Projects (the card's Quality and Lint orbs, and the table's trend cell), the Catalog list
 * and a catalog item's detail. Its props are unchanged for exactly that reason: this ticket
 * re-skins a dialog three screens share rather than forking a fourth copy of it.
 */

import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Card } from '@/app/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { EmptyState } from '@/app/components/ui/EmptyState';
import {
  Meter,
  METRIC_TONE_INK_CLASS,
  METRIC_TONE_MARK_CLASS,
  Ring,
  ringTier,
} from '@/app/components/ui/metrics';
import { SVG_TEXT_SIZE } from '@/app/components/ui/svgTypography';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import {
  getLatestProjectQualitySnapshotWithReport,
  snapshotHasLintReport,
  snapshotHasQualityReport,
  type ProjectQualityReportSection,
  type ProjectQualitySnapshot,
  type StoredLintFinding,
  type StoredQualityIssue,
} from '@/app/utils/project-quality-score-history';
import { cn } from '@lib/utils';

interface ProjectQualityHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  projectId: string;
  history: ProjectQualitySnapshot[];
  initialSection?: ProjectQualityReportSection;
}

/** The plotting box of the Trend tab's chart, in user units. */
const CHART_W = 700;
const CHART_H = 160;
const CHART_PAD_LEFT = 28;
const CHART_PAD_RIGHT = 8;
const CHART_PAD_Y = 14;

/** The scores the chart rules, top first — the A boundary and the three below it. */
const CHART_GRIDLINES = [100, 75, 50, 25] as const;

/**
 * An instant, as the dialog prints it.
 *
 * @param iso The timestamp.
 * @returns `Aug 15, 09:12` in the reader's locale, or the raw string if it will not parse.
 */
function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A stored severity as a badge tone.
 *
 * `high` is not in the shared vocabulary — it is this analyser's word for what the rest of the
 * app calls `error` — so it is mapped here rather than added to a vocabulary the other
 * severities of the product do not use.
 *
 * @param severity The stored severity string.
 * @returns The badge's `status`, which the vocabulary turns into a tone.
 */
function severityStatus(severity: string): string {
  const normalised = severity.trim().toLowerCase();
  if (normalised === 'critical' || normalised === 'high') return 'error';
  if (normalised === 'medium') return 'warning';
  return 'info';
}

/** The improvement suggestions of the Quality tab. */
function QualityIssueList({ issues }: { issues: StoredQualityIssue[] }) {
  if (issues.length === 0) {
    return (
      <EmptyState
        variant="compact"
        surface={false}
        tone="neutral"
        icon={<CheckCircle2 />}
        title="No quality issues recorded"
        description="The analyzed specification met all tracked quality checks."
      />
    );
  }

  return (
    <div className="pqh-list">
      {issues.map((issue, index) => (
        <Card
          variant="flat"
          key={`${issue.path}-${issue.message}-${index}`}
          className="pqh-finding"
        >
          <div className="pqh-finding__head">
            <Badge status={severityStatus(issue.severity)}>{issue.severity}</Badge>
            <Badge variant="outline">{issue.category}</Badge>
            <span className="pqh-finding__title">{issue.message}</span>
          </div>
          {issue.suggestion ? (
            <p className="pqh-finding__note">Suggestion: {issue.suggestion}</p>
          ) : null}
          {issue.path ? <p className="pqh-finding__path mono">{issue.path}</p> : null}
        </Card>
      ))}
    </div>
  );
}

/** The structural errors and warnings of the Lint tab. */
function LintFindingList({ findings }: { findings: StoredLintFinding[] }) {
  if (findings.length === 0) {
    return (
      <EmptyState
        variant="compact"
        surface={false}
        tone="neutral"
        icon={<CheckCircle2 />}
        title="No lint findings recorded"
        description="No structural errors or warnings were stored for this import."
      />
    );
  }

  return (
    <div className="pqh-list">
      {findings.map((finding, index) => (
        <Card
          variant="flat"
          key={`${finding.type}-${finding.message}-${finding.path ?? ''}-${index}`}
          className="pqh-finding"
        >
          <div className="pqh-finding__head">
            <Badge status={finding.type === 'error' ? 'error' : 'warning'}>{finding.type}</Badge>
            <Badge variant="outline">{finding.severity}</Badge>
            <span className="pqh-finding__title">{finding.message}</span>
          </div>
          {finding.path ? <p className="pqh-finding__path mono">{finding.path}</p> : null}
        </Card>
      ))}
    </div>
  );
}

const SECTIONS: { id: ProjectQualityReportSection; label: string }[] = [
  { id: 'trend', label: 'Trend' },
  { id: 'quality', label: 'Quality' },
  { id: 'lint', label: 'Lint' },
];

/**
 * Render the scores dialog.
 *
 * @param props The project it is about, its browser-local history, and which tab to open on.
 * @returns The dialog.
 */
export function ProjectQualityHistoryDialog({
  open,
  onOpenChange,
  projectName,
  projectId,
  history,
  initialSection = 'trend',
}: ProjectQualityHistoryDialogProps) {
  const [section, setSection] = React.useState<ProjectQualityReportSection>(initialSection);

  const reportSnapshot = React.useMemo(() => {
    if (history.length === 0) return null;
    const fromHistory = [...history]
      .reverse()
      .find(
        (snap) =>
          snap.categories !== undefined ||
          snap.issues !== undefined ||
          snap.lintFindings !== undefined
      );
    return (
      fromHistory ??
      getLatestProjectQualitySnapshotWithReport(projectId) ??
      history[history.length - 1]
    );
  }, [history, projectId]);

  const plotWidth = CHART_W - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const plotHeight = CHART_H - CHART_PAD_Y * 2;
  const scoreY = (score: number) =>
    CHART_PAD_Y + plotHeight * (1 - Math.min(100, Math.max(0, score)) / 100);
  const points = history.map((snapshot, index) => ({
    x:
      history.length <= 1
        ? CHART_PAD_LEFT + plotWidth / 2
        : CHART_PAD_LEFT + (index / (history.length - 1)) * plotWidth,
    y: scoreY(snapshot.overall),
  }));
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');
  const floor = CHART_PAD_Y + plotHeight;
  const area =
    points.length > 1
      ? `${line} L ${points[points.length - 1].x.toFixed(1)} ${floor} L ${points[0].x.toFixed(1)} ${floor} Z`
      : '';

  const first = history[0];
  const last = history[history.length - 1];
  const trendTone = ringTier(last?.overall ?? null).tone;
  const lintFindings = reportSnapshot?.lintFindings ?? [];
  const lintErrors = lintFindings.filter((finding) => finding.type === 'error').length;
  const lintWarnings = lintFindings.filter((finding) => finding.type === 'warning').length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="pqh-dialog" aria-describedby={undefined}>
        <div className="pqh-dialog__head">
          <DialogHeader className="pr-8">
            <DialogTitle className="truncate">Project scores — {projectName}</DialogTitle>
          </DialogHeader>
          <div className={TAB_LIST_CLASS} role="tablist" aria-label="Project score views">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`project-scores-tab-${item.id}`}
                aria-selected={section === item.id}
                aria-controls={`project-scores-panel-${item.id}`}
                data-testid={`project-scores-tab-${item.id}`}
                className={tabTriggerClass({ active: section === item.id })}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="pqh-dialog__body">
          {section === 'trend' ? (
            <div
              role="tabpanel"
              id="project-scores-panel-trend"
              aria-labelledby="project-scores-tab-trend"
              className="pqh-panel"
            >
              <p className="pqh-lede">
                OpenAPI quality scores (0–100) recorded in this browser when an import finishes
                successfully. History is stored locally and is not synced across devices.
              </p>

              {history.length === 0 ? (
                <EmptyState
                  variant="compact"
                  surface={false}
                  tone="neutral"
                  title="No snapshots yet"
                  description="Import a specification to record the first score."
                />
              ) : (
                <>
                  <div className="pqh-chart">
                    <svg
                      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                      className={cn('pqh-chart__svg', METRIC_TONE_MARK_CLASS[trendTone])}
                      role="img"
                      aria-label={`Quality trend from ${
                        first ? formatShortDate(first.recordedAt) : ''
                      } to ${last ? formatShortDate(last.recordedAt) : ''}`}
                      focusable="false"
                    >
                      <g className="pqh-chart__grid">
                        {CHART_GRIDLINES.map((score) => (
                          <line
                            key={score}
                            x1={CHART_PAD_LEFT}
                            y1={scoreY(score)}
                            x2={CHART_W - CHART_PAD_RIGHT}
                            y2={scoreY(score)}
                          />
                        ))}
                      </g>
                      <g className="pqh-chart__ticks" fontSize={SVG_TEXT_SIZE.tick}>
                        {CHART_GRIDLINES.map((score) => (
                          <text key={score} x={0} y={scoreY(score) + 3}>
                            {score}
                          </text>
                        ))}
                      </g>
                      {area ? <path className="pqh-chart__area" d={area} /> : null}
                      {points.length > 1 ? (
                        <path className="pqh-chart__line" d={line} />
                      ) : null}
                      {points.map((point, index) => (
                        <circle
                          key={`${point.x}-${point.y}-${index}`}
                          className="pqh-chart__dot"
                          cx={point.x}
                          cy={point.y}
                          r={3.5}
                        />
                      ))}
                    </svg>
                    <div className="pqh-chart__axis">
                      <span>{first ? formatShortDate(first.recordedAt) : ''}</span>
                      <span>{last ? formatShortDate(last.recordedAt) : ''}</span>
                    </div>
                  </div>

                  <div className="pqh-table-wrap">
                    <table className="pqh-table">
                      <caption className="sr-only">Recorded quality scores, newest first</caption>
                      <thead>
                        <tr>
                          <th scope="col">Recorded</th>
                          <th scope="col">Overall</th>
                          <th scope="col">Grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...history].reverse().map((row, index) => (
                          <tr key={`${row.recordedAt}-${row.overall}-${index}`}>
                            <td className="mono">{formatShortDate(row.recordedAt)}</td>
                            <td>
                              <span
                                className={cn(
                                  'pqh-score mono',
                                  METRIC_TONE_INK_CLASS[ringTier(row.overall).tone]
                                )}
                              >
                                {row.overall}
                              </span>
                            </td>
                            <td>{row.grade}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {section === 'quality' ? (
            <div
              role="tabpanel"
              id="project-scores-panel-quality"
              aria-labelledby="project-scores-tab-quality"
              className="pqh-panel"
            >
              <p className="pqh-lede">
                Weighted quality breakdown and improvement suggestions from the most recent
                import that stored a detailed report.
              </p>
              {!reportSnapshot ? (
                <EmptyState
                  variant="compact"
                  surface={false}
                  tone="neutral"
                  title="No import scores recorded yet"
                  description="Import a specification to record the first score."
                />
              ) : !snapshotHasQualityReport(reportSnapshot) ? (
                <EmptyState
                  variant="compact"
                  surface={false}
                  tone="neutral"
                  title={`This snapshot only records the overall score (${reportSnapshot.overall})`}
                  description="Import again to capture the category breakdown and quality reasons."
                />
              ) : (
                <>
                  <div className="pqh-headline">
                    <Ring score={reportSnapshot.overall} label="Overall quality score" size="lg" />
                    <div>
                      <p className="pqh-headline__grade">Grade {reportSnapshot.grade}</p>
                      <p className="pqh-headline__note">
                        From import on {formatShortDate(reportSnapshot.recordedAt)}
                      </p>
                    </div>
                  </div>
                  {(reportSnapshot.categories?.length ?? 0) > 0 ? (
                    <div className="pqh-categories">
                      {reportSnapshot.categories!.map((category) => (
                        <Card variant="flat" key={category.id} className="pqh-category">
                          <p className="pqh-category__label">{category.label}</p>
                          <p className="pqh-category__value">
                            {category.points} / {category.maxPoints}
                          </p>
                          <Meter
                            label={`${category.label} score`}
                            value={category.percent}
                            tone={ringTier(category.percent).tone}
                            warnAt={null}
                          />
                        </Card>
                      ))}
                    </div>
                  ) : null}
                  <QualityIssueList issues={reportSnapshot.issues ?? []} />
                </>
              )}
            </div>
          ) : null}

          {section === 'lint' ? (
            <div
              role="tabpanel"
              id="project-scores-panel-lint"
              aria-labelledby="project-scores-tab-lint"
              className="pqh-panel"
            >
              <p className="pqh-lede">
                Structural validation errors and warnings from the most recent import that
                stored lint findings. The lint letter grade on the project card is derived from
                the overall quality score.
              </p>
              {!reportSnapshot ? (
                <EmptyState
                  variant="compact"
                  surface={false}
                  tone="neutral"
                  title="No import scores recorded yet"
                  description="Import a specification to record the first score."
                />
              ) : !snapshotHasLintReport(reportSnapshot) ? (
                <EmptyState
                  variant="compact"
                  surface={false}
                  tone="neutral"
                  title={`This snapshot only records the overall score (${reportSnapshot.overall})`}
                  description="Import again to capture lint findings."
                />
              ) : (
                <>
                  {/* `info`, not a bare neutral banner: DESIGN.md's untinted `.banner--neutral`
                      is `--fg-muted` on `--bg-subtle`, which HIVE-5.6 measured at 4.35:1 in
                      Solarized — under AA. `info` is a designed soft/ink pair. */}
                  <Alert variant="info">
                    <span>
                      From import on {formatShortDate(reportSnapshot.recordedAt)} ·{' '}
                      <strong>{lintErrors}</strong> {lintErrors === 1 ? 'error' : 'errors'},{' '}
                      <strong>{lintWarnings}</strong>{' '}
                      {lintWarnings === 1 ? 'warning' : 'warnings'}.
                    </span>
                  </Alert>
                  <LintFindingList findings={lintFindings} />
                </>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
