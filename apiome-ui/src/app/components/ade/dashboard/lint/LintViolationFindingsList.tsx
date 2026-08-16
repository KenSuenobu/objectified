'use client';

/**
 * GOV-2.4 findings list with group-by-rule toggle (persists per surface).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@lib/utils';
import { Switch } from '@/app/components/ui/Switch';
import {
  enrichLintViolations,
  groupLintViolationsByRule,
  type EnrichedLintViolation,
} from '@/app/utils/lint-violation-display';
import {
  persistLintViolationDisplayPreferences,
  readLintViolationDisplayPreferences,
  type LintViolationDisplayView,
} from '@/app/utils/lint-violation-display-preferences';
import type { VersionLintFinding, VersionLintReport } from '@/app/utils/version-lint-report';
import { useLintViolationContext } from './useLintViolationContext';
import {
  LintViolationFindingMeta,
  LintViolationRuleGroupHeader,
} from './LintViolationFindingMeta';

export interface LintViolationFindingsListProps {
  findings: VersionLintFinding[];
  guideName?: string | null;
  guideId?: string | null;
  preferenceView: LintViolationDisplayView;
  className?: string;
  emptyMessage?: string;
  /** Controlled group-by-rule mode; when omitted the list owns preference state. */
  groupByRule?: boolean;
  onGroupByRuleChange?: (value: boolean) => void;
  /** Optional path renderer (catalog deep links, etc.). */
  renderPath?: (finding: EnrichedLintViolation) => React.ReactNode;
  /** Row wrapper class (tier tinting in catalog panel). */
  rowClassName?: string;
  /** When false, omit the built-in "Findings" + toggle header (parent supplies it). */
  showHeader?: boolean;
}

function ViolationRow({
  finding,
  rowClassName,
  hideRuleChip,
  renderPath,
}: {
  finding: EnrichedLintViolation;
  rowClassName?: string;
  hideRuleChip?: boolean;
  renderPath?: (finding: EnrichedLintViolation) => React.ReactNode;
}) {
  return (
    <li className={cn('rounded-lg p-3', rowClassName)} data-testid="lint-violation-row">
      <LintViolationFindingMeta finding={finding} hideRuleChip={hideRuleChip} />
      {finding.path ? (
        <div className="mt-1 font-mono text-2xs text-gray-500 dark:text-gray-400">
          {renderPath ? renderPath(finding) : finding.path}
        </div>
      ) : null}
      <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">{finding.message}</p>
    </li>
  );
}

/**
 * Render lint findings with governance metadata and an optional group-by-rule layout.
 */
export function LintViolationFindingsList({
  findings,
  guideName = null,
  guideId = null,
  preferenceView,
  className,
  emptyMessage = 'No findings — clean bill of health.',
  groupByRule: groupByRuleProp,
  onGroupByRuleChange,
  renderPath,
  rowClassName,
  showHeader = true,
}: LintViolationFindingsListProps) {
  const { catalog, customDescriptions, loading: catalogLoading } = useLintViolationContext(guideId);
  const [groupByRuleInternal, setGroupByRuleInternal] = useState(false);

  useEffect(() => {
    if (groupByRuleProp !== undefined) return;
    setGroupByRuleInternal(readLintViolationDisplayPreferences(preferenceView).groupByRule);
  }, [preferenceView, groupByRuleProp]);

  const groupByRule = groupByRuleProp ?? groupByRuleInternal;

  const onGroupByRuleChangeHandler = useCallback(
    (checked: boolean) => {
      if (onGroupByRuleChange) {
        onGroupByRuleChange(checked);
      } else {
        setGroupByRuleInternal(checked);
        persistLintViolationDisplayPreferences(preferenceView, { groupByRule: checked });
      }
    },
    [onGroupByRuleChange, preferenceView],
  );

  const enriched = useMemo(() => {
    if (!catalog || findings.length === 0) return [];
    return enrichLintViolations(findings, {
      guideName: guideName ?? null,
      catalog,
      customDescriptions,
    });
  }, [findings, guideName, catalog, customDescriptions]);

  const groups = useMemo(
    () => (groupByRule ? groupLintViolationsByRule(enriched) : []),
    [groupByRule, enriched],
  );

  if (findings.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="lint-violations-empty">
        {emptyMessage}
      </p>
    );
  }

  if (catalogLoading && enriched.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="lint-violations-loading">
        Loading rule metadata…
      </p>
    );
  }

  const rows = enriched.length > 0 ? enriched : findings.map((f) => ({
    ...f,
    guideName: guideName ?? null,
    rationale: f.message,
    docsHref: null,
  }));

  return (
    <div className={className} data-testid="lint-violations-list">
      {showHeader ? (
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Findings
          </span>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <Switch
              checked={groupByRule}
              onCheckedChange={onGroupByRuleChangeHandler}
              aria-label="Group findings by rule"
              data-testid="lint-violations-group-by-rule"
            />
            Group by rule
          </label>
        </div>
      ) : null}

      {groupByRule ? (
        <div className="space-y-4" data-testid="lint-violations-grouped">
          {groups.map((group) => (
            <section key={group.ruleId}>
              <LintViolationRuleGroupHeader group={group} />
              <ul className="mt-2 space-y-2">
                {group.findings.map((finding) => (
                  <ViolationRow
                    key={finding.id}
                    finding={finding}
                    rowClassName={rowClassName}
                    hideRuleChip
                    renderPath={renderPath}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="space-y-2" data-testid="lint-violations-flat">
          {rows.map((finding) => (
            <ViolationRow
              key={finding.id}
              finding={finding}
              rowClassName={rowClassName}
              renderPath={renderPath}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Convenience: pull guide fields from a full lint report. */
export function lintReportGuideContext(report: VersionLintReport | null): {
  guideName: string | null;
  guideId: string | null;
} {
  if (!report) return { guideName: null, guideId: null };
  return {
    guideName: report.guideName ?? null,
    guideId: report.guideId ?? null,
  };
}
