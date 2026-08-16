'use client';

import type { ReactNode } from 'react';
import { cn } from '@lib/utils';
import { getProjectDomainCategoryLabel } from '@/app/utils/project-domain-categories';
import { letterGradeFromOverallPercent } from '@/app/utils/numeric-score-tier';
import { Ring } from '@/app/components/ui/metrics';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';
import { formatRelativeTime } from '@/app/ade/dashboard/versions/version-history-dag';

/**
 * The hit area around an orb (HIVE-2.6, #5285).
 *
 * The orb itself is a `<Ring>`, which owns its size, its tier colour and its own reading of
 * the score; this is only the button wrapped round it. Before that ticket this card carried a
 * `scoreOrbBorderClass` of its own — `border-emerald-500 / indigo-500 / amber-500 / rose-500`,
 * a fourth copy of the same four literals, none of which followed a theme.
 */
const ORB_BUTTON =
  'inline-flex rounded-full transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]';

export interface ProjectsDashboardProjectCardProps {
  project: {
    id: string;
    name: string;
    slug?: string;
    description: string;
    enabled: boolean;
    deleted_at: string | null;
    updated_at: string;
    creator_name: string;
    creator_email: string;
    metadata?: { domainCategory?: string; summary?: string };
    /** Mean quality score across the project's versions; orb fallback when history is empty. */
    qualityScore?: number | null;
    qualityGrade?: string | null;
    /** Live version count from the server summary (0 = empty project). */
    versionsCount?: number;
  };
  qualityHistory: ProjectQualitySnapshot[];
  avatarGradientClass: string;
  avatarInitials: string;
  creatorInitials: string;
  shortProjectId: string;
  onOpenQualityHistory: () => void;
  onOpenLintReport: () => void;
  onNavigateToVersions: () => void;
  actionsSlot: ReactNode;
}

export function ProjectsDashboardProjectCard({
  project,
  qualityHistory,
  avatarGradientClass,
  avatarInitials,
  creatorInitials,
  shortProjectId,
  onOpenQualityHistory,
  onOpenLintReport,
  onNavigateToVersions,
  actionsSlot,
}: ProjectsDashboardProjectCardProps) {
  const domainCategoryLabel = getProjectDomainCategoryLabel(project.metadata?.domainCategory);
  const isDeleted = Boolean(project.deleted_at);
  const attentionVisual = !project.enabled || isDeleted;
  const versionsCount = typeof project.versionsCount === 'number' ? project.versionsCount : 0;
  const isEmptyProject = versionsCount === 0;

  // Prefer browser-local trend history; fall back to the server version-summary score/grade so
  // imports that never wrote localStorage still light up the orbs (same fallback as the table).
  // Empty projects never show scores — even if stale local history exists.
  const latest =
    !isEmptyProject && qualityHistory.length > 0
      ? qualityHistory[qualityHistory.length - 1]
      : null;
  const qualityValue = isEmptyProject
    ? null
    : latest != null
      ? latest.overall
      : typeof project.qualityScore === 'number'
        ? project.qualityScore
        : null;
  const lintLetter = isEmptyProject
    ? null
    : latest != null
      ? latest.grade ?? letterGradeFromOverallPercent(latest.overall)
      : project.qualityGrade?.trim() ||
        (qualityValue != null ? letterGradeFromOverallPercent(qualityValue) : null);

  const summaryLine =
    project.metadata?.summary?.trim() ||
    project.description?.trim() ||
    'No description yet.';

  const versionsLabel = `${versionsCount} version${versionsCount === 1 ? '' : 's'}`;

  return (
    <article
      className={cn(
        'overflow-hidden rounded-lg border bg-white transition-colors dark:bg-gray-800',
        attentionVisual
          ? 'border-amber-200/60 dark:border-amber-700/40'
          : 'border-gray-200 hover:border-indigo-300 dark:border-gray-700 dark:hover:border-indigo-600',
        isDeleted && 'opacity-90'
      )}
    >
      <div className="relative p-5">
        <div className="absolute right-4 top-4 z-[1] flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {actionsSlot}
        </div>

        <div
          role={isDeleted ? undefined : 'button'}
          tabIndex={isDeleted ? undefined : 0}
          className={cn(!isDeleted && 'cursor-pointer')}
          onClick={() => {
            if (!isDeleted) onNavigateToVersions();
          }}
          onKeyDown={(e) => {
            if (isDeleted) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onNavigateToVersions();
            }
          }}
        >
          <div className="flex items-start gap-3 pr-10">
            <span
              className={cn(
                'inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br font-mono font-bold text-white',
                avatarGradientClass
              )}
            >
              {avatarInitials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate font-bold text-gray-900 dark:text-white">{project.name}</h3>
                {domainCategoryLabel ? (
                  <span
                    className="inline-flex max-w-full shrink-0 items-center rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
                    title={domainCategoryLabel}
                  >
                    {domainCategoryLabel}
                  </span>
                ) : null}
              </div>
              <p
                className="truncate font-mono text-2xs text-gray-500 dark:text-gray-400"
                title={project.slug ?? project.id}
              >
                {shortProjectId}
                {project.slug ? ` · ${project.slug}` : ''}
              </p>
            </div>
            <div className="shrink-0">
              {isDeleted ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                  Deleted
                </span>
              ) : !project.enabled ? (
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                  Disabled
                </span>
              ) : (
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Active
                </span>
              )}
            </div>
          </div>

          <p className="mt-3 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{summaryLine}</p>

          {isEmptyProject ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <p
                className="text-xs font-medium text-gray-500 dark:text-gray-400"
                data-testid="project-card-empty"
              >
                Empty project
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                <span className="font-semibold font-mono tabular-nums text-gray-700 dark:text-gray-200">
                  0
                </span>{' '}
                versions
              </p>
            </div>
          ) : (
            <div className="mt-4 flex items-end gap-3">
              <div className="grid flex-1 grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-2xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Quality
                  </p>
                  {qualityValue != null ? (
                    <button
                      type="button"
                      className={cn('mt-1', ORB_BUTTON)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenQualityHistory();
                      }}
                      title="Open quality score history"
                    >
                      <Ring score={qualityValue} label="Quality score" size="sm" />
                    </button>
                  ) : (
                    <Ring score={null} label="Quality score" size="sm" className="mt-1" />
                  )}
                </div>
                <div>
                  <p className="text-2xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Lint
                  </p>
                  {lintLetter ? (
                    <button
                      type="button"
                      className={cn('mt-1', ORB_BUTTON)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenLintReport();
                      }}
                      title="Open lint report"
                    >
                      <Ring
                        score={qualityValue}
                        grade={lintLetter}
                        display="grade"
                        label="Lint grade"
                        size="sm"
                      />
                    </button>
                  ) : (
                    <Ring score={null} label="Lint grade" size="sm" className="mt-1" />
                  )}
                </div>
                <div>
                  <p className="text-2xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Debt
                  </p>
                  <Ring
                    score={null}
                    label="Technical debt"
                    size="sm"
                    className="mt-1"
                    title="Technical debt (not yet computed)"
                  />
                </div>
              </div>
              <p
                className="shrink-0 pb-1 text-right text-xs text-gray-400 dark:text-gray-500"
                data-testid="project-card-versions-count"
                title={versionsLabel}
              >
                <span className="font-semibold font-mono tabular-nums text-gray-700 dark:text-gray-200">
                  {versionsCount}
                </span>{' '}
                {versionsCount === 1 ? 'version' : 'versions'}
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-2xs font-semibold text-white ring-2 ring-white dark:ring-gray-800">
              {(creatorInitials.slice(0, 2) || '?').toUpperCase()}
            </div>
            <span className="truncate text-2xs text-gray-500 dark:text-gray-400">{project.creator_name}</span>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'flex items-center justify-between border-t px-5 py-3 text-xs',
          attentionVisual
            ? 'border-amber-200/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-900/10'
            : 'border-gray-100 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/40'
        )}
      >
        <span className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <span className="font-mono">{project.enabled ? 'enabled' : 'disabled'}</span>
          <span className="text-gray-300 dark:text-gray-600">·</span>
          <span className={project.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500'}>
            {isDeleted ? 'deleted' : project.enabled ? 'active' : 'inactive'}
          </span>
        </span>
        <span className="text-gray-500 dark:text-gray-400" title={project.updated_at}>
          {formatRelativeTime(project.updated_at) ?? '—'}
        </span>
      </div>
    </article>
  );
}
