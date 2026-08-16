'use client';

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/Tooltip';
import {
  type RepositoryHealth,
  type RepositoryHealthLevel,
  repositoryHealthAriaLabel,
  repositoryHealthClass,
  repositoryHealthLabel,
  repositoryHealthTooltipLines,
} from './repositoryHealth';

/** The level icon; matched to the pill palette so shape and colour agree. */
function HealthIcon({ level, className }: { level: RepositoryHealthLevel; className: string }) {
  if (level === 'error') return <XCircle className={className} aria-hidden />;
  if (level === 'warnings') return <AlertTriangle className={className} aria-hidden />;
  return <CheckCircle2 className={className} aria-hidden />;
}

/**
 * At-a-glance repository health pill (REPO-6.5, #2798).
 *
 * Renders the level the API computed — `healthy`, `warnings` or `error` — with a tooltip
 * whose first line is the most recently observed contributing factor, so an operator
 * hovering a red badge learns *what changed*, not just that something is wrong.
 *
 * Returns `null` when `health` is absent, so a repository whose health could not be
 * computed shows nothing rather than a guessed verdict.
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
        <span
          data-testid="repository-health-badge"
          data-health-level={health.level}
          role="img"
          aria-label={repositoryHealthAriaLabel(health)}
          tabIndex={0}
          className={cn(
            'inline-flex cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider outline-none',
            'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
            repositoryHealthClass(health.level),
            className
          )}
        >
          <HealthIcon level={health.level} className="h-3 w-3 shrink-0" />
          {compact ? null : label}
        </span>
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
