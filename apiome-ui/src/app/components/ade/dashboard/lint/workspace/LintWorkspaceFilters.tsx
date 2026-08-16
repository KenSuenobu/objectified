'use client';

/**
 * Filter toolbar for the lint workspace queue (CLX-4.1, #4859).
 *
 * Multi-select chip groups for the closed vocabularies (severity, state, axis, grade),
 * facet-driven scanner/profile selects, free-text search, and a "new only" regression toggle.
 * Controlled: filter state lives in the page (URL-serialized via filtersToSearchParams).
 */

import React from 'react';
import { Input, Switch } from '@/app/components/ui';
import {
  WORKSPACE_AXES,
  WORKSPACE_GRADES,
  WORKSPACE_SEVERITIES,
  WORKSPACE_SORTS,
  WORKSPACE_STATES,
  activeFilterCount,
  EMPTY_WORKSPACE_FILTERS,
  type WorkspaceFilters,
} from '@/app/utils/lint-workspace';
import { dashboardPanelPaddedClass } from '../../dashboardScreenClasses';
import { cn } from '@lib/utils';

const groupLabelClass =
  'text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400';
const chipBaseClass =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors';
const chipOffClass =
  'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700';
const chipOnClass =
  'border-indigo-500 bg-indigo-50 text-indigo-800 dark:border-indigo-400 dark:bg-indigo-900/40 dark:text-indigo-200';
const selectClass =
  'rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200';

const AXIS_LABELS: Record<string, string> = {
  quality: 'Quality',
  protocol: 'Protocol',
  security: 'Security',
  supply_chain: 'Supply chain',
  supportability: 'Supportability',
  compatibility: 'Compatibility',
};

const STATE_LABELS: Record<string, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  waiver_requested: 'Waiver requested',
  waived: 'Waived',
  fixed: 'Fixed',
  false_positive: 'False positive',
};

export interface LintWorkspaceFiltersProps {
  filters: WorkspaceFilters;
  sort: string;
  /** Facet counts over the current (filtered) queue, from the findings response. */
  facets: Record<string, Record<string, number>>;
  onChange: (filters: WorkspaceFilters) => void;
  onSortChange: (sort: string) => void;
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** One toggleable facet chip with an optional count. */
function FacetChip({
  label,
  active,
  count,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(chipBaseClass, active ? chipOnClass : chipOffClass)}
    >
      {label}
      {count !== undefined && <span className="font-normal opacity-70">{count}</span>}
    </button>
  );
}

/** The workspace queue filter toolbar. */
export default function LintWorkspaceFilters({
  filters,
  sort,
  facets,
  onChange,
  onSortChange,
}: LintWorkspaceFiltersProps) {
  const activeCount = activeFilterCount(filters);
  const scanners = Object.keys(facets.scannerId ?? {}).filter((s) => s !== 'none');

  return (
    <div
      data-testid="lint-workspace-filters"
      className={cn(dashboardPanelPaddedClass, 'space-y-3')}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Input
          data-testid="workspace-search"
          type="search"
          placeholder="Search rule, message, subject…"
          value={filters.q}
          onChange={(e) => onChange({ ...filters, q: e.target.value })}
          className="h-8 w-64 text-sm"
        />
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <Switch
            data-testid="workspace-new-only"
            checked={filters.newOnly}
            onCheckedChange={(checked: boolean) => onChange({ ...filters, newOnly: checked })}
          />
          New only
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          Sort
          <select
            data-testid="workspace-sort"
            className={selectClass}
            value={sort}
            onChange={(e) => onSortChange(e.target.value)}
          >
            {WORKSPACE_SORTS.map((key) => (
              <option key={key} value={key}>
                {key[0].toUpperCase() + key.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {scanners.length > 0 && (
          <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
            Source
            <select
              data-testid="workspace-scanner"
              className={selectClass}
              value={filters.scanner[0] ?? ''}
              onChange={(e) =>
                onChange({ ...filters, scanner: e.target.value ? [e.target.value] : [] })
              }
            >
              <option value="">All scanners</option>
              {scanners.map((scanner) => (
                <option key={scanner} value={scanner}>
                  {scanner}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          Coverage
          <select
            data-testid="workspace-coverage"
            className={selectClass}
            value={filters.coverage}
            onChange={(e) =>
              onChange({
                ...filters,
                coverage: (e.target.value || '') as WorkspaceFilters['coverage'],
              })
            }
          >
            <option value="">Any</option>
            <option value="missing">Missing required</option>
            <option value="met">Met</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          Subject
          <select
            data-testid="workspace-subject-type"
            className={selectClass}
            value={filters.subjectType}
            onChange={(e) => onChange({ ...filters, subjectType: e.target.value })}
          >
            <option value="">All subjects</option>
            <option value="catalog_revision">Catalog revisions</option>
            <option value="mcp_endpoint_version">MCP servers</option>
          </select>
        </label>
        {activeCount > 0 && (
          <button
            type="button"
            data-testid="workspace-clear-filters"
            className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            onClick={() =>
              onChange({ ...EMPTY_WORKSPACE_FILTERS, projectId: filters.projectId })
            }
          >
            Clear filters ({activeCount})
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className={groupLabelClass}>Severity</span>
          {WORKSPACE_SEVERITIES.map((severity) => (
            <FacetChip
              key={severity}
              testId={`facet-severity-${severity}`}
              label={severity}
              active={filters.severity.includes(severity)}
              count={facets.severity?.[severity]}
              onClick={() =>
                onChange({ ...filters, severity: toggle(filters.severity, severity) })
              }
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={groupLabelClass}>State</span>
          {WORKSPACE_STATES.map((state) => (
            <FacetChip
              key={state}
              testId={`facet-state-${state}`}
              label={STATE_LABELS[state] ?? state}
              active={filters.state.includes(state)}
              count={facets.effectiveState?.[state]}
              onClick={() => onChange({ ...filters, state: toggle(filters.state, state) })}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={groupLabelClass}>Axis</span>
          {WORKSPACE_AXES.map((axis) => (
            <FacetChip
              key={axis}
              testId={`facet-axis-${axis}`}
              label={AXIS_LABELS[axis] ?? axis}
              active={filters.axis.includes(axis)}
              count={facets.axis?.[axis]}
              onClick={() => onChange({ ...filters, axis: toggle(filters.axis, axis) })}
            />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={groupLabelClass}>Grade</span>
          {WORKSPACE_GRADES.map((grade) => (
            <FacetChip
              key={grade}
              testId={`facet-grade-${grade}`}
              label={grade}
              active={filters.grade.includes(grade)}
              count={facets.grade?.[grade]}
              onClick={() => onChange({ ...filters, grade: toggle(filters.grade, grade) })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
