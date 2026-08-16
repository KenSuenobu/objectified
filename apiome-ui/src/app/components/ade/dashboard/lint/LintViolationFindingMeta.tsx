'use client';

/**
 * GOV-2.4 violation metadata row: rule id chip, guide name, rationale tooltip, and docs link.
 */

import { ExternalLink } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/app/components/ui/Tooltip';
import type { EnrichedLintViolation } from '@/app/utils/lint-violation-display';
import { severityBadgeClass } from '@/app/utils/version-lint-report';

export interface LintViolationFindingMetaProps {
  finding: EnrichedLintViolation;
  className?: string;
  /** When grouping by rule, hide the per-row rule chip (the group header carries it). */
  hideRuleChip?: boolean;
}

/** Rule id chip, guide badge, rationale tooltip, and optional "View rule" link. */
export function LintViolationFindingMeta({
  finding,
  className,
  hideRuleChip = false,
}: LintViolationFindingMetaProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ${severityBadgeClass(finding.severity)}`}
      >
        {finding.severity}
      </span>
      {!hideRuleChip ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <code
                data-testid="lint-violation-rule-chip"
                className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-2xs text-gray-700 dark:bg-gray-800 dark:text-gray-300"
              >
                {finding.rule}
              </code>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm">
              {finding.rationale}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {finding.guideName ? (
        <span
          data-testid="lint-violation-guide-name"
          className="rounded bg-indigo-50 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
          title="Style guide that produced this violation"
        >
          {finding.guideName}
        </span>
      ) : null}
      {finding.docsHref ? (
        <a
          href={finding.docsHref}
          data-testid="lint-violation-view-rule"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-2xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          View rule
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

export interface LintViolationRuleGroupHeaderProps {
  group: {
    ruleId: string;
    guideName: string | null;
    rationale: string;
    docsHref: string | null;
    findings: EnrichedLintViolation[];
  };
}

/** Header for a group-by-rule cluster: rule chip + count + guide + rationale + docs link. */
export function LintViolationRuleGroupHeader({ group }: LintViolationRuleGroupHeaderProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-2 dark:border-gray-700"
      data-testid={`lint-violation-rule-group-${group.ruleId}`}
    >
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <code
              data-testid="lint-violation-rule-chip"
              className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-2xs font-semibold text-gray-800 dark:bg-gray-800 dark:text-gray-200"
            >
              {group.ruleId}
            </code>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            {group.rationale}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span className="text-2xs tabular-nums text-gray-500 dark:text-gray-400">
        {group.findings.length} violation{group.findings.length === 1 ? '' : 's'}
      </span>
      {group.guideName ? (
        <span
          data-testid="lint-violation-guide-name"
          className="rounded bg-indigo-50 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          {group.guideName}
        </span>
      ) : null}
      {group.docsHref ? (
        <a
          href={group.docsHref}
          data-testid="lint-violation-view-rule"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-2xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          View rule
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}
