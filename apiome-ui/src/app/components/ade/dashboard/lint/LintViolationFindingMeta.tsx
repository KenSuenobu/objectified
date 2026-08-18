'use client';

/**
 * GOV-2.4 violation metadata row: rule id chip, guide name, rationale tooltip, and docs link
 * (re-skinned onto the shared vocabulary by HIVE-5.8, #5311).
 *
 * The severity was `severityBadgeClass` — three `bg-rose-100 / bg-amber-100 / bg-sky-100`
 * pairs, each doubled for dark mode — and the guide chip an indigo one. Both resolve through
 * `ui/Badge` now, so a warning is the same amber here as in the workspace queue and the row
 * follows all nine themes.
 */

import { ArrowUpRight } from 'lucide-react';
import { cn } from '@lib/utils';
import { Badge } from '@/app/components/ui/Badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/app/components/ui/Tooltip';
import type { EnrichedLintViolation } from '@/app/utils/lint-violation-display';

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
      <Badge status={finding.severity} className="capitalize">
        {finding.severity}
      </Badge>
      {!hideRuleChip ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <code data-testid="lint-violation-rule-chip" className="lr-rule">
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
        <Badge
          variant="outline"
          data-testid="lint-violation-guide-name"
          title="Style guide that produced this violation"
        >
          {finding.guideName}
        </Badge>
      ) : null}
      {finding.docsHref ? (
        <a
          href={finding.docsHref}
          data-testid="lint-violation-view-rule"
          target="_blank"
          rel="noopener noreferrer"
          className="lr-rule-link"
        >
          View rule
          <ArrowUpRight aria-hidden />
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
      className="flex flex-wrap items-center gap-2 border-b border-border pb-2"
      data-testid={`lint-violation-rule-group-${group.ruleId}`}
    >
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <code data-testid="lint-violation-rule-chip" className="lr-rule">
              {group.ruleId}
            </code>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            {group.rationale}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span className="text-2xs tabular-nums text-fg-muted">
        {group.findings.length} violation{group.findings.length === 1 ? '' : 's'}
      </span>
      {group.guideName ? (
        <Badge variant="outline" data-testid="lint-violation-guide-name">
          {group.guideName}
        </Badge>
      ) : null}
      {group.docsHref ? (
        <a
          href={group.docsHref}
          data-testid="lint-violation-view-rule"
          target="_blank"
          rel="noopener noreferrer"
          className="lr-rule-link"
        >
          View rule
          <ArrowUpRight aria-hidden />
        </a>
      ) : null}
    </div>
  );
}
