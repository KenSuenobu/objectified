'use client';

import * as React from 'react';
import { Ban, Check, Link2, RotateCcw, SearchX, ShieldCheck, UserPlus, Wrench } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableBulkAction,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFilterChip,
  DataTableFoot,
  DataTablePager,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Input } from '@/app/components/ui/Input';
import { Switch } from '@/app/components/ui/Switch';
import { LintDecisionBadge } from '@/app/utils/lint-policy-ui';
import { gradeBand } from '@/app/components/ui/statusVocabulary';
import {
  EMPTY_WORKSPACE_FILTERS,
  selectionKey,
  type BulkActionSet,
  type LintWorkspaceFinding,
  type WorkspaceFilters,
  type WorkspaceSort,
} from '@/app/utils/lint-workspace';
import { cn } from '@lib/utils';

import {
  BULK_VERBS,
  COVERAGE_OPTIONS,
  LINT_QUEUE_PAGE_SIZE,
  NO_VALUE,
  SORT_OPTIONS,
  SUBJECT_TYPE_OPTIONS,
  axisLabel,
  clearableFilterCount,
  facetGroups,
  findingPath,
  findingSubjectName,
  queueOffsetForPage,
  queuePageCount,
  queuePageNumber,
  queueRangeLabel,
  severityLabel,
  shareableUrl,
  withFacetToggled,
  type WaiverDialogMode,
} from './lintWorkspaceModel';

/**
 * The findings queue — HIVE-5.8 (#5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, the Queue tab: the two-row toolbar, the
 * shareable-URL line, the seven-column table, the foot and the sticky bulk bar.
 *
 * ### What changed from the table this replaces
 *
 * A hand-built `<table>` on the `dashboardScreenClasses` string constants, with its own
 * checkbox column, its own `px-6 py-3` cells, its own Previous/Next pair and a single
 * centred sentence where an empty state should be. It is now {@link DataTable}: the sticky
 * caps header, the roving row focus, the skeleton shaped like the content, the in-card empty
 * and error states and the inverted bulk bar all come from the one list surface, and the
 * badges resolve through the shared status vocabulary.
 *
 * ### Why no column is sortable
 *
 * The queue's ordering is a *server* parameter with four named orders — severity, newest,
 * rule, subject — and no direction. Making the columns sortable would offer an ascending and
 * a descending state the endpoint has no way to honour, and two of the four orders (newest,
 * and severity's rule/path tiebreak) are not a column at all. The toolbar's select is the
 * honest control, and it is the one the URL carries.
 *
 * ### The URL line
 *
 * The mono strip under the toolbar is the mockup's, and it earns its place: every narrowing
 * on this screen is in the address bar, saved views are built out of it, and the line is
 * what makes that visible rather than merely true.
 */

/** Props for {@link LintQueueTable}. */
export interface LintQueueTableProps {
  /** The findings of the current page. */
  findings: readonly LintWorkspaceFinding[];
  /** How many findings matched in total. */
  total: number;
  /** The current offset. */
  offset: number;
  /** Facet counts from the findings response. */
  facets: Record<string, Record<string, number>>;
  /** The filter state, which lives in the URL. */
  filters: WorkspaceFilters;
  /** The sort, which lives in the URL. */
  sort: string;
  /** The route the URL line prints. */
  pathname: string;
  /** True while the queue read is in flight. */
  loading?: boolean;
  /** The read's failure, when it failed. */
  error?: string | null;
  /** Re-run the read. */
  onRetry: () => void;
  /** Replace the filter state (which resets paging and the selection). */
  onFiltersChange: (filters: WorkspaceFilters) => void;
  /** Change the sort. */
  onSortChange: (sort: WorkspaceSort) => void;
  /** Move to a 1-based page. */
  onOffsetChange: (offset: number) => void;
  /** The selected findings, by {@link selectionKey}. */
  selected: ReadonlySet<string>;
  /** Replace the selection. */
  onSelectionChange: (selected: Set<string>) => void;
  /** Open one finding's drawer. */
  onOpenFinding: (finding: LintWorkspaceFinding) => void;
  /** Apply a bulk decision to the selection. */
  onBulkApply: (set: BulkActionSet, verbLabel: string) => void;
  /** Open the waiver dialog in one of its two shapes. */
  onOpenWaiverDialog: (mode: WaiverDialogMode) => void;
  /** True while a bulk write is in flight. */
  bulkBusy?: boolean;
}

/**
 * The Finding cell: the rule, the regression marker, the message and the document path.
 *
 * The rule id is the row's primary line rather than a button of its own. The whole row already
 * opens the drawer — by click and by `↵` on the focused row — so a second control inside it
 * would be a second way to do the same thing, and one that fires both handlers at once.
 *
 * @param props.finding The row.
 * @returns The cell.
 */
function FindingCell({ finding }: { finding: LintWorkspaceFinding }) {
  const path = findingPath(finding);
  return (
    <div className="lw-finding">
      <div className="lw-finding__head">
        <DataTableCellPrimary className="lw-finding__rule mono">
          {finding.ruleId ?? 'unknown-rule'}
        </DataTableCellPrimary>
        {finding.isNew && (
          <Badge status="new" data-testid="finding-new-pill">
            New
          </Badge>
        )}
      </div>
      {finding.message ? <p className="lw-finding__message">{finding.message}</p> : null}
      {path ? <p className="lw-finding__path mono">{path}</p> : null}
    </div>
  );
}

/**
 * The Subject cell: what the finding was raised on, and how that subject grades.
 *
 * @param props.finding The row.
 * @returns The cell.
 */
function SubjectCell({ finding }: { finding: LintWorkspaceFinding }) {
  const band = gradeBand(finding.compositeGrade);
  const showLabel = Boolean(finding.projectName && finding.subjectLabel);
  return (
    <div className="lw-subject">
      <DataTableCellPrimary>{findingSubjectName(finding)}</DataTableCellPrimary>
      <DataTableCellSub className="lw-subject__meta">
        {showLabel ? <span>{finding.subjectLabel}</span> : null}
        {finding.compositeGrade ? (
          <span className={cn('lw-grade-sq', band.solidClass)} title={`Composite grade ${finding.compositeGrade}`}>
            {finding.compositeGrade}
          </span>
        ) : (
          <span className="lw-subject__ungraded">ungraded</span>
        )}
        {finding.subjectType === 'mcp_endpoint_version' ? (
          <Badge variant="outline" square>
            MCP
          </Badge>
        ) : null}
      </DataTableCellSub>
    </div>
  );
}

/**
 * The queue: toolbar, facets, table, foot and bulk bar.
 *
 * @param props See {@link LintQueueTableProps}.
 * @returns The queue card.
 */
export default function LintQueueTable({
  findings,
  total,
  offset,
  facets,
  filters,
  sort,
  pathname,
  loading = false,
  error = null,
  onRetry,
  onFiltersChange,
  onSortChange,
  onOffsetChange,
  selected,
  onSelectionChange,
  onOpenFinding,
  onBulkApply,
  onOpenWaiverDialog,
  bulkBusy = false,
}: LintQueueTableProps) {
  const [owner, setOwner] = React.useState('');

  const groups = facetGroups(filters, facets);
  const clearable = clearableFilterCount(filters);
  const scanners = Object.keys(facets.scannerId ?? {}).filter((scanner) => scanner !== 'none');
  const url = shareableUrl(pathname, filters, sort, offset);
  const page = queuePageNumber(offset, LINT_QUEUE_PAGE_SIZE);
  const pageCount = queuePageCount(total, LINT_QUEUE_PAGE_SIZE);
  const narrowed = clearable > 0;

  const columns = React.useMemo<DataTableColumn<LintWorkspaceFinding>[]>(
    () => [
      {
        id: 'finding',
        header: 'Finding',
        cell: (finding) => <FindingCell finding={finding} />,
        skeletonWidth: '20rem',
      },
      {
        id: 'severity',
        header: 'Severity',
        cell: (finding) =>
          finding.severity ? (
            <Badge status={finding.severity}>{severityLabel(finding.severity)}</Badge>
          ) : (
            <span className="lw-quiet">{NO_VALUE}</span>
          ),
        skeletonWidth: '3.5rem',
      },
      {
        id: 'state',
        header: 'State',
        cell: (finding) => (
          <LintDecisionBadge state={finding.effectiveState} waived={finding.waived} />
        ),
        skeletonWidth: '4rem',
      },
      {
        id: 'subject',
        header: 'Subject',
        cell: (finding) => <SubjectCell finding={finding} />,
        skeletonWidth: '7rem',
      },
      {
        id: 'axis',
        header: 'Axis',
        cell: (finding) => <span className="lw-axis">{axisLabel(finding.axisKey)}</span>,
        skeletonWidth: '4rem',
      },
      {
        id: 'source',
        header: 'Source',
        cell: (finding) => <span className="lw-source mono">{finding.scannerId}</span>,
        skeletonWidth: '5rem',
      },
    ],
    []
  );

  /** Replace the filters, which is always also a reset of paging and of the selection. */
  const setFilters = (next: WorkspaceFilters) => onFiltersChange(next);

  return (
    <DataTable
      columns={columns}
      rows={findings}
      getRowId={selectionKey}
      getRowLabel={(finding) =>
        `${finding.ruleId ?? 'finding'} on ${findingSubjectName(finding)}`
      }
      caption="Lint findings across this workspace, with their policy decisions"
      scrollX
      loading={loading}
      loadingLabel="Loading the findings queue…"
      error={error ?? undefined}
      onRetry={error ? onRetry : undefined}
      selectedIds={[...selected]}
      onSelectionChange={(ids) => onSelectionChange(new Set(ids))}
      bulkNoun="finding"
      onRowActivate={onOpenFinding}
      data-testid="lint-workspace-queue"
      toolbar={
        <>
          <DataTableToolbar>
            <DataTableSearch
              value={filters.q}
              aria-label="Search findings"
              data-testid="workspace-search"
              placeholder="Search rule, message, subject…"
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            />
            <label className="lw-toolbar-field">
              <Switch
                checked={filters.newOnly}
                data-testid="workspace-new-only"
                onCheckedChange={(checked: boolean) =>
                  setFilters({ ...filters, newOnly: checked })
                }
              />
              New only
            </label>
            <label className="lw-toolbar-field">
              Sort
              <select
                className="hive-control lw-select"
                data-testid="workspace-sort"
                value={sort}
                onChange={(event) => onSortChange(event.target.value as WorkspaceSort)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {scanners.length > 0 && (
              <label className="lw-toolbar-field">
                Source
                <select
                  className="hive-control lw-select"
                  data-testid="workspace-scanner"
                  value={filters.scanner[0] ?? ''}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      scanner: event.target.value ? [event.target.value] : [],
                    })
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
            <label className="lw-toolbar-field">
              Coverage
              <select
                className="hive-control lw-select"
                data-testid="workspace-coverage"
                value={filters.coverage}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    coverage: event.target.value as WorkspaceFilters['coverage'],
                  })
                }
              >
                {COVERAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="lw-toolbar-field">
              Subject
              <select
                className="hive-control lw-select"
                data-testid="workspace-subject-type"
                value={filters.subjectType}
                onChange={(event) =>
                  setFilters({ ...filters, subjectType: event.target.value })
                }
              >
                {SUBJECT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <DataTableToolbarSpacer />
            {clearable > 0 && (
              <Button
                variant="link"
                size="sm"
                // `Button`'s `link` variant paints `--accent`, the fill hue: at this size it
                // measures 4.14:1 on the surface, under AA. `--accent-fg` is the step chosen
                // to be read as text. `LoginClient` makes the same override, for the same
                // reason; `e2e/hive-lint-workspace.spec.ts` is what caught it here.
                className="text-accent-fg"
                data-testid="workspace-clear-filters"
                onClick={() =>
                  setFilters({ ...EMPTY_WORKSPACE_FILTERS, projectId: filters.projectId })
                }
              >
                Clear filters ({clearable})
              </Button>
            )}
          </DataTableToolbar>

          <div className="lw-facets" data-testid="workspace-facets">
            {groups.map((group) => (
              <div key={group.key} className="lw-facet-group" role="group" aria-label={group.label}>
                <span className="lw-caps">{group.label}</span>
                {group.chips.map((chip) => (
                  <DataTableFilterChip
                    key={chip.value}
                    active={chip.active}
                    count={chip.count}
                    className="lw-facet-chip"
                    data-testid={`facet-${group.key}-${chip.value}`}
                    onClick={() => setFilters(withFacetToggled(filters, group.key, chip.value))}
                  >
                    {chip.tone ? (
                      <span className="lw-facet-dot" data-tone={chip.tone} aria-hidden />
                    ) : null}
                    {chip.label}
                  </DataTableFilterChip>
                ))}
              </div>
            ))}
          </div>

          <p className="lw-url" data-testid="workspace-url-line">
            <Link2 aria-hidden />
            <span className="lw-url__path mono">
              {url.path}
              <span className="lw-url__query">{url.query}</span>
            </span>
            <span className="lw-url__note">
              Shareable · selection clears when filters change
            </span>
          </p>
        </>
      }
      empty={
        narrowed ? (
          <EmptyState
            variant="compact"
            surface={false}
            tone="neutral"
            icon={<SearchX aria-hidden />}
            title="No findings match the current filters."
            description="Clear a chip or widen the subject scope."
            action={
              <Button
                variant="outline"
                size="sm"
                data-testid="workspace-empty-clear"
                onClick={() =>
                  setFilters({ ...EMPTY_WORKSPACE_FILTERS, projectId: filters.projectId })
                }
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            variant="compact"
            surface={false}
            icon={<ShieldCheck aria-hidden />}
            title="No lint findings in this workspace."
            description="Findings appear here once a scan records evidence against a revision or an MCP server."
          />
        )
      }
      bulkActions={
        <>
          {BULK_VERBS.map((verb) => (
            <DataTableBulkAction
              key={verb.state}
              disabled={bulkBusy}
              title={verb.title}
              data-testid={`bulk-${verb.state}`}
              onClick={() =>
                verb.opensWaiverDialog && verb.waiverMode
                  ? onOpenWaiverDialog(verb.waiverMode)
                  : onBulkApply({ state: verb.state }, verb.label)
              }
            >
              {verb.state === 'acknowledged' && <Check aria-hidden />}
              {verb.state === 'fixed' && <Wrench aria-hidden />}
              {verb.state === 'false_positive' && <Ban aria-hidden />}
              {verb.state === 'open' && <RotateCcw aria-hidden />}
              {verb.label}
            </DataTableBulkAction>
          ))}
          <span className="lw-bulk-rule" aria-hidden />
          <Input
            value={owner}
            className="lw-bulk-owner"
            data-testid="bulk-owner-input"
            aria-label="Assign owner (user id)"
            placeholder="Assign owner (user id)"
            onChange={(event) => setOwner(event.target.value)}
          />
          <DataTableBulkAction
            disabled={bulkBusy || !owner.trim()}
            data-testid="bulk-assign-owner"
            onClick={() => {
              onBulkApply({ ownerUserId: owner.trim() }, 'Assign');
              setOwner('');
            }}
          >
            <UserPlus aria-hidden />
            Assign
          </DataTableBulkAction>
        </>
      }
      footer={
        <DataTableFoot>
          <span data-testid="queue-pagination-summary">
            {queueRangeLabel(offset, LINT_QUEUE_PAGE_SIZE, total)}
          </span>
          <DataTablePager
            page={page}
            pageCount={pageCount}
            label="Findings pages"
            onPageChange={(next) => onOffsetChange(queueOffsetForPage(next, LINT_QUEUE_PAGE_SIZE))}
          />
        </DataTableFoot>
      }
    />
  );
}
