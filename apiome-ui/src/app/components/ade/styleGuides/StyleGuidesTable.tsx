'use client';

import * as React from 'react';
import Link from 'next/link';
import { BadgeCheck, BookOpenCheck, Copy, Info, Lock, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFilterChip,
  DataTableFoot,
  DataTableSearch,
  DataTableToolbar,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';

import {
  describeGuideCount,
  formatGuideDate,
  guideRuleCountLabel,
  isBuiltinGuide,
  matchesStyleGuideFacet,
  searchStyleGuides,
  sortStyleGuides,
  STYLE_GUIDE_FACETS,
  STYLE_GUIDE_FACET_LABELS,
  styleGuideFacetCounts,
  styleGuideRowActions,
  styleGuideTone,
  type StyleGuide,
  type StyleGuideFacet,
} from './styleGuidesModel';

/**
 * The guides list — HIVE-5.6 (#5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html`, the `.table-wrap` of its first tab;
 * DESIGN.md §8 (list page) and §3.1 (the shared status vocabulary).
 *
 * ### What changed from the screen this replaces
 *
 * The old table was five hand-built columns over `border-slate-200` with three inline badge
 * palettes (`bg-slate-100`, `bg-emerald-100`, `bg-indigo-100`), a centred spinner for the
 * wait, and a bare "No style guides yet." paragraph for the empty case. It is now
 * {@link DataTable}, which brings the sticky caps header, sortable columns, the skeleton and
 * the in-card empty state; the toolbar, the facet chips and the foot are the mockup's
 * additions.
 *
 * ### The two things the row itself has to make obvious
 *
 * 1. **Which guide is read-only.** The built-in guide carries a `Built-in` badge with a lock
 *    and offers Assign and Duplicate only — the ticket's first acceptance criterion, and a
 *    property of {@link styleGuideRowActions} rather than of this file's JSX.
 * 2. **What a guide actually governs.** The Assignments column is the tenant-default badge
 *    plus one chip per pinned project, which is exactly what `resolve_style_guide` (GOV-1.4)
 *    reads when it picks a guide for a lint run.
 *
 * ### One departure from the mockup
 *
 * The mockup's toolbar carries a "Sorted by name" menu button beside the chips. Sorting is on
 * the column headers here, where `DataTable` already puts it with `aria-sort` — a second
 * control for the same state is a second thing that can disagree with it.
 */

/** Props for {@link StyleGuidesTable}. */
export interface StyleGuidesTableProps {
  /** Every guide of the tenant, as the API ordered them. */
  guides: readonly StyleGuide[];
  /** True while the first read is in flight. */
  loading?: boolean;
  /** Why the list could not be read. Replaces the body with a retry. */
  error?: string | null;
  /** Retry the read. */
  onRetry?: () => void;
  /** Whether the viewer administers this tenant. Gates every action. */
  canMutate: boolean;
  /** True while a write is in flight, so the row's controls go inert. */
  busy?: boolean;
  /** Open the assign dialog for a guide. */
  onAssign: (guide: StyleGuide) => void;
  /** Open the create dialog with this guide as the rule source. */
  onDuplicate: (guide: StyleGuide) => void;
  /** Open the rename dialog. */
  onEdit: (guide: StyleGuide) => void;
  /** Open the delete confirm. */
  onDelete: (guide: StyleGuide) => void;
  /** Create an empty guide, from the empty state. */
  onCreate: () => void;
  /** Create a guide from the built-in one, from the empty state. */
  onStartFromRecommended: () => void;
  /** Whether a built-in guide exists to start from. */
  hasRecommended: boolean;
  /** Where a guide's detail page lives, given its id. */
  guideHref: (guide: StyleGuide) => string;
}

/**
 * The guides list, its toolbar, its foot and its per-row actions.
 *
 * @param props See {@link StyleGuidesTableProps}.
 * @returns The table card.
 */
export default function StyleGuidesTable({
  guides,
  loading = false,
  error = null,
  onRetry,
  canMutate,
  busy = false,
  onAssign,
  onDuplicate,
  onEdit,
  onDelete,
  onCreate,
  onStartFromRecommended,
  hasRecommended,
  guideHref,
}: StyleGuidesTableProps) {
  const [query, setQuery] = React.useState('');
  const [facet, setFacet] = React.useState<StyleGuideFacet>('all');
  const [sort, setSort] = React.useState<DataTableSortState | null>(null);

  const searched = React.useMemo(() => searchStyleGuides(guides, query), [guides, query]);
  const counts = React.useMemo(() => styleGuideFacetCounts(searched), [searched]);
  const visible = React.useMemo(
    () =>
      sortStyleGuides(
        searched.filter((guide) => matchesStyleGuideFacet(guide, facet)),
        sort
      ),
    [searched, facet, sort]
  );
  const narrowed = query.trim().length > 0 || facet !== 'all';

  const columns = React.useMemo<DataTableColumn<StyleGuide>[]>(() => {
    const base: DataTableColumn<StyleGuide>[] = [
      {
        id: 'name',
        header: 'Name',
        sortable: true,
        cell: (guide) => (
          <div className="sg-identity" data-testid="style-guide-row" data-guide-name={guide.name}>
            <span className="tnt-icon-tile" data-tone={styleGuideTone(guide)}>
              <BookOpenCheck aria-hidden />
            </span>
            <span className="sg-identity__text">
              <span className="sg-identity__line">
                <Link href={guideHref(guide)} className="sg-identity__link">
                  <DataTableCellPrimary className="sg-identity__name">
                    {guide.name}
                  </DataTableCellPrimary>
                </Link>
                {isBuiltinGuide(guide) && (
                  <Badge variant="outline">
                    <Lock aria-hidden />
                    Built-in
                  </Badge>
                )}
                {guide.isDefault && (
                  <Badge variant="ok">
                    <BadgeCheck aria-hidden />
                    Default
                  </Badge>
                )}
              </span>
              {guide.description ? (
                <DataTableCellSub className="sg-identity__desc">
                  {guide.description}
                </DataTableCellSub>
              ) : null}
            </span>
          </div>
        ),
        skeletonWidth: '14rem',
      },
      {
        id: 'rules',
        header: 'Rules on',
        sortable: true,
        align: 'end',
        cell: (guide) => <span className="sg-rules mono">{guideRuleCountLabel(guide)}</span>,
        skeletonWidth: '3.5rem',
      },
      {
        id: 'assignments',
        header: 'Assignments',
        sortable: true,
        cell: (guide) =>
          guide.isDefault || guide.projectAssignments.length > 0 ? (
            <span className="sg-chips">
              {guide.isDefault && (
                <Badge variant="ok">
                  <BadgeCheck aria-hidden />
                  Tenant default
                </Badge>
              )}
              {guide.projectAssignments.map((assignment) => (
                <Badge key={assignment.projectId} variant="accent">
                  {assignment.projectName}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="sg-empty-cell">—</span>
          ),
        skeletonWidth: '6rem',
      },
      {
        id: 'updated',
        header: 'Updated',
        sortable: true,
        cell: (guide) => <span className="sg-stamp">{formatGuideDate(guide.updatedAt)}</span>,
        skeletonWidth: '5.5rem',
      },
    ];

    if (!canMutate) return base;

    return [
      ...base,
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        cell: (guide) => {
          const actions = styleGuideRowActions(guide, canMutate);
          return (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid={`style-guide-assign-${guide.id}`}
                onClick={() => onAssign(guide)}
              >
                Assign…
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5"
                disabled={busy}
                title="Duplicate"
                aria-label={`Duplicate ${guide.name}`}
                data-testid={`style-guide-duplicate-${guide.id}`}
                onClick={() => onDuplicate(guide)}
              >
                <Copy aria-hidden />
              </Button>
              {actions.canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-1.5"
                  disabled={busy}
                  title="Edit"
                  aria-label={`Edit ${guide.name}`}
                  data-testid={`style-guide-edit-${guide.id}`}
                  onClick={() => onEdit(guide)}
                >
                  <Pencil aria-hidden />
                </Button>
              )}
              {actions.canDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="sg-delete px-1.5"
                  disabled={busy}
                  title="Delete"
                  aria-label={`Delete ${guide.name}`}
                  data-testid={`style-guide-delete-${guide.id}`}
                  onClick={() => onDelete(guide)}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </>
          );
        },
        skeletonWidth: '5rem',
      },
    ];
  }, [busy, canMutate, guideHref, onAssign, onDelete, onDuplicate, onEdit]);

  return (
    <DataTable
      columns={columns}
      rows={visible}
      getRowId={(guide) => guide.id}
      getRowLabel={(guide) => guide.name}
      caption="Style guides for this workspace"
      scrollX
      loading={loading}
      loadingLabel="Loading style guides…"
      error={error}
      onRetry={onRetry}
      sort={sort}
      onSortChange={setSort}
      data-testid="style-guides-table"
      toolbar={
        <DataTableToolbar>
          <DataTableSearch
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter guides…"
            aria-label="Filter style guides"
            data-testid="style-guides-search"
          />
          {STYLE_GUIDE_FACETS.map((entry) => (
            <DataTableFilterChip
              key={entry}
              active={facet === entry}
              count={counts[entry]}
              data-testid={`style-guides-facet-${entry}`}
              onClick={() => setFacet(entry)}
            >
              {entry === 'assigned' ? <BadgeCheck className="sg-chip-glyph" aria-hidden /> : null}
              {STYLE_GUIDE_FACET_LABELS[entry]}
            </DataTableFilterChip>
          ))}
        </DataTableToolbar>
      }
      empty={
        narrowed ? (
          <EmptyState
            variant="compact"
            icon={<BookOpenCheck aria-hidden />}
            title="No style guides match these filters"
            description="Clear the search box or pick a different chip."
            action={
              <Button
                variant="outline"
                size="sm"
                data-testid="style-guides-clear-filters"
                onClick={() => {
                  setQuery('');
                  setFacet('all');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<BookOpenCheck aria-hidden />}
            title="No style guides yet."
            description="Start from Apiome Recommended and tailor it, or create an empty guide and add rules as you go."
            action={
              canMutate ? (
                <>
                  {hasRecommended && (
                    <Button variant="outline" onClick={onStartFromRecommended}>
                      <Sparkles aria-hidden />
                      Start from Recommended
                    </Button>
                  )}
                  <Button onClick={onCreate}>
                    <Plus aria-hidden />
                    New guide
                  </Button>
                </>
              ) : undefined
            }
          />
        )
      }
      footer={
        <DataTableFoot>
          <span className="sg-foot-note">
            <Info aria-hidden />
            The built-in “Apiome Recommended” guide is read-only — duplicate it to customize.
            Open a guide to tailor its rule catalog.
          </span>
          <span data-testid="style-guides-count">{describeGuideCount(visible.length)}</span>
        </DataTableFoot>
      }
    />
  );
}
