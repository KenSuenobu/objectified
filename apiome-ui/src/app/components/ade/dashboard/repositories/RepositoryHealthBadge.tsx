'use client';

import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { cn } from '@lib/utils';
import { Badge } from '@/app/components/ui/Badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/Tooltip';
import { REPOSITORY_HEALTH_TONE } from '@/app/components/ade/repositories/repositoriesModel';
import {
  type RepositoryHealth,
  type RepositoryHealthLevel,
  repositoryHealthAriaLabel,
  repositoryHealthLabel,
  repositoryHealthTooltipLines,
} from './repositoryHealth';

/** The level icon; matched to the pill tone so shape and colour agree. */
function HealthIcon({ level }: { level: RepositoryHealthLevel }) {
  if (level === 'error') return <CircleX aria-hidden />;
  if (level === 'warnings') return <TriangleAlert aria-hidden />;
  return <CircleCheck aria-hidden />;
}

/**
 * At-a-glance repository health pill (REPO-6.5, #2798; re-tokened by HIVE-7.3, #5320).
 *
 * Renders the level the API computed — `healthy`, `warnings` or `error` — with a tooltip whose
 * first line is the most recently observed contributing factor, so an operator hovering a red
 * badge learns *what changed*, not just that something is wrong.
 *
 * Returns `null` when `health` is absent, so a repository whose health could not be computed
 * shows nothing rather than a guessed verdict.
 *
 * ### What HIVE-7.3 changed
 *
 * The three palettes were `bg-emerald-100 text-emerald-700 dark:…` triples living in
 * `repositoryHealth.ts`, which froze the badge on one light and one dark palette out of the
 * nine the app now ships. The level now resolves through `REPOSITORY_HEALTH_TONE` — the
 * ticket's "health states map to the shared status vocabulary" criterion — and the pill itself
 * is the shared {@link Badge}, so it is the same object as every other status pill on the row.
 *
 * @param health The parsed health object from the repository record.
 * @param compact When true, renders the icon alone (for dense rows); the label is still
 *   available to screen readers and in the tooltip.
 * @param className Extra classes for the pill.
 */
export function RepositoryHealthBadge({
  health,
  compact = false,
  className,
}: {
  health: RepositoryHealth | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!health) return null;

  const lines = repositoryHealthTooltipLines(health);
  const label = repositoryHealthLabel(health.level);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          data-testid="repository-health-badge"
          data-health-level={health.level}
          variant={REPOSITORY_HEALTH_TONE[health.level]}
          role="img"
          aria-label={repositoryHealthAriaLabel(health)}
          tabIndex={0}
          className={cn('repo-health', compact && 'repo-health--compact', className)}
        >
          <HealthIcon level={health.level} />
          {compact ? null : label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-xs text-left leading-snug">
        <span className="block font-semibold">Health: {label}</span>
        {lines.map((line) => (
          <span key={line} className="mt-1 block">
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
