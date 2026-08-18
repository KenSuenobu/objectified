'use client';

/**
 * The types table (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Registry → *Filters + types table* —
 * sortable `Name · Namespace · Category · Description · Usage · Type · actions`, the search
 * field, the namespace chip with its `×`, the category select, the Show-system checkbox and
 * the refresh button, over a foot that counts what the filters left.
 *
 * ### What this replaces
 *
 * 180 lines of `<table>` inside `PrimitivesManagementClient`: a `SortableTh` per column over
 * `dashboardScreenClasses`, `px-6 py-4` cells, a `bg-indigo-100 text-indigo-800` category pill,
 * two more hand-built status pills, and Edit/Delete as bare `<button>`s inked `text-indigo-600`
 * and `text-red-600` with `disabled:opacity-50`. It is {@link DataTable} now, so the header is
 * sticky and sorted with `aria-sort`, the wait draws per-column skeletons, and the row actions
 * are real {@link Button}s that the `.` shortcut can reach.
 *
 * ### The system rows stay locked
 *
 * The ticket's first acceptance criterion. A `std/*` type's two verbs are `disabled` and each
 * carries the reason as its tooltip ({@link SYSTEM_EDIT_TOOLTIP} / {@link SYSTEM_DELETE_TOOLTIP}),
 * exactly as before — the lock is not a style, so restyling must not touch it.
 */

import * as React from 'react';
import Link from 'next/link';
import { FileCode, Pencil, RefreshCw, Shield, Trash2 } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableFilterChip,
  DataTableFoot,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Label } from '@/app/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { PRIMITIVES_TABLE_SORT_LABELS } from '@/app/utils/primitives-table-sort';

import {
  SYSTEM_DELETE_TOOLTIP,
  SYSTEM_EDIT_TOOLTIP,
  namespaceFilterChipLabel,
  primitiveDetailHref,
  primitiveScopeBadge,
  typesFootLabel,
  type NamespaceSelection,
} from './primitivesModel';

/** The shape this table needs of a primitive; the screen's own row type is wider. */
export interface PrimitiveRow {
  /** Registry id. */
  id: string;
  /** The type's name. */
  name: string;
  /** Its one-line purpose, or `null`. */
  description: string | null;
  /** The JSON Schema type it builds on — `string`, `object`, … */
  category: string;
  /** Its namespace path, or `null` when it was saved without one. */
  namespace?: string | null;
  /** How many places bind it. */
  usage_count: number;
  /** True for a platform-curated `std/*` type. */
  is_system: boolean;
}

/** The category chosen in the toolbar's select; `all` is the unfiltered state. */
export const ALL_CATEGORIES = 'all';

export interface PrimitiveTypesTableProps {
  /** The rows to draw — already searched, filtered and sorted by the screen. */
  primitives: readonly PrimitiveRow[];
  /** How many types the tenant has in all, for the foot. */
  totalCount: number;
  /** True while the list is being read. */
  loading: boolean;
  /** The active sort. */
  sort: DataTableSortState | null;
  /** Change it. */
  onSortChange: (next: DataTableSortState | null) => void;
  /** The search box's value. */
  search: string;
  /** Change it. */
  onSearchChange: (value: string) => void;
  /** Every category present in the registry, for the select. */
  categories: readonly string[];
  /** The chosen category, or {@link ALL_CATEGORIES}. */
  category: string;
  /** Change it. */
  onCategoryChange: (value: string) => void;
  /** Whether `std/*` types are listed. */
  showSystem: boolean;
  /** Change it. */
  onShowSystemChange: (value: boolean) => void;
  /** The namespace the collections panel selected, or `null`. */
  namespaceSelection: NamespaceSelection | null;
  /** Clear that selection. */
  onClearNamespace: () => void;
  /** Re-read the registry. */
  onRefresh: () => void;
  /** Open one type's detail page. */
  onOpen: (primitive: PrimitiveRow) => void;
  /** Open the editor on that type. */
  onEdit: (primitive: PrimitiveRow) => void;
  /** Delete it, behind the confirm. */
  onDelete: (primitive: PrimitiveRow) => void;
}

/**
 * Render the table. See {@link PrimitiveTypesTableProps}.
 *
 * @returns The types card: toolbar, table, foot.
 */
export default function PrimitiveTypesTable({
  primitives,
  totalCount,
  loading,
  sort,
  onSortChange,
  search,
  onSearchChange,
  categories,
  category,
  onCategoryChange,
  showSystem,
  onShowSystemChange,
  namespaceSelection,
  onClearNamespace,
  onRefresh,
  onOpen,
  onEdit,
  onDelete,
}: PrimitiveTypesTableProps) {
  const filtered =
    search.trim().length > 0 ||
    category !== ALL_CATEGORIES ||
    !showSystem ||
    namespaceSelection !== null;

  const columns: DataTableColumn<PrimitiveRow>[] = [
    {
      id: 'name',
      header: PRIMITIVES_TABLE_SORT_LABELS.name,
      sortable: true,
      skeletonWidth: '9rem',
      cell: (primitive) => (
        <span className="prm-type-name">
          <FileCode className="prm-type-glyph" aria-hidden />
          <Link
            href={primitiveDetailHref(primitive.id)}
            className="prm-type-link"
            // The row is clickable too; this is the keyboard's way in, and the reason the
            // name is a link rather than a `<span>` inside a clickable row.
            onClick={(event) => event.stopPropagation()}
          >
            <DataTableCellPrimary>{primitive.name}</DataTableCellPrimary>
          </Link>
        </span>
      ),
    },
    {
      id: 'namespace',
      header: PRIMITIVES_TABLE_SORT_LABELS.namespace,
      sortable: true,
      skeletonWidth: '8rem',
      cell: (primitive) =>
        primitive.namespace ? (
          <span className="prm-quiet mono">{primitive.namespace}</span>
        ) : (
          <span className="prm-faint">—</span>
        ),
    },
    {
      id: 'category',
      header: PRIMITIVES_TABLE_SORT_LABELS.category,
      sortable: true,
      skeletonWidth: '4rem',
      cell: (primitive) => <span className="prm-cat mono">{primitive.category}</span>,
    },
    {
      id: 'description',
      header: PRIMITIVES_TABLE_SORT_LABELS.description,
      sortable: true,
      skeletonWidth: '15rem',
      cell: (primitive) =>
        primitive.description ? (
          <span className="prm-desc" title={primitive.description}>
            {primitive.description}
          </span>
        ) : (
          <span className="prm-faint">—</span>
        ),
    },
    {
      id: 'usage',
      header: PRIMITIVES_TABLE_SORT_LABELS.usage,
      sortable: true,
      align: 'end',
      skeletonWidth: '2rem',
      cell: (primitive) => <span className="prm-num mono">{primitive.usage_count}</span>,
    },
    {
      id: 'type',
      header: PRIMITIVES_TABLE_SORT_LABELS.type,
      sortable: true,
      skeletonWidth: '4.5rem',
      cell: (primitive) => {
        const badge = primitiveScopeBadge(primitive.is_system);
        return (
          <Badge variant={badge.tone}>
            {primitive.is_system ? <Shield aria-hidden /> : null}
            {badge.label}
          </Badge>
        );
      },
    },
    {
      id: 'actions',
      headerLabel: 'Actions',
      actions: true,
      cell: (primitive) => (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            disabled={primitive.is_system}
            title={primitive.is_system ? SYSTEM_EDIT_TOOLTIP : 'Edit primitive'}
            aria-label={`Edit ${primitive.name}`}
            data-testid={`primitives-edit-${primitive.id}`}
            onClick={() => onEdit(primitive)}
          >
            <Pencil aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            disabled={primitive.is_system}
            title={primitive.is_system ? SYSTEM_DELETE_TOOLTIP : 'Delete primitive'}
            aria-label={`Delete ${primitive.name}`}
            data-testid={`primitives-delete-${primitive.id}`}
            onClick={() => onDelete(primitive)}
          >
            <Trash2 aria-hidden />
          </Button>
        </>
      ),
    },
  ];

  const toolbar = (
    <DataTableToolbar className="prm-types__toolbar">
      <DataTableSearch
        aria-label="Search primitives"
        placeholder="Search primitives..."
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        data-testid="primitives-search"
      />

      {namespaceSelection ? (
        <DataTableFilterChip
          active
          data-testid="selected-namespace-chip"
          onClick={onClearNamespace}
          title="Clear the namespace filter"
        >
          {namespaceFilterChipLabel(namespaceSelection)} ×
        </DataTableFilterChip>
      ) : null}

      <Select value={category} onValueChange={onCategoryChange}>
        <SelectTrigger
          className="prm-types__category"
          aria-label="Category"
          data-testid="primitives-category"
        >
          <SelectValue placeholder="All Categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_CATEGORIES}>All Categories</SelectItem>
          {categories.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="prm-types__switch">
        <Checkbox
          id="primitives-show-system"
          checked={showSystem}
          onCheckedChange={(checked) => onShowSystemChange(checked === true)}
        />
        <Label htmlFor="primitives-show-system">Show system</Label>
      </span>

      <DataTableToolbarSpacer />

      <Button
        variant="ghost"
        size="sm"
        className="px-1.5"
        onClick={onRefresh}
        disabled={loading}
        title="Refresh"
        aria-label="Refresh"
        data-testid="primitives-refresh"
      >
        <RefreshCw aria-hidden className={loading ? 'prm-spin' : undefined} />
      </Button>
    </DataTableToolbar>
  );

  return (
    <DataTable<PrimitiveRow>
      className="prm-types"
      caption="Primitives"
      scrollX
      columns={columns}
      rows={primitives}
      getRowId={(primitive) => primitive.id}
      getRowLabel={(primitive) => primitive.name}
      sort={sort}
      onSortChange={onSortChange}
      onRowActivate={onOpen}
      loading={loading}
      loadingLabel="Loading primitives…"
      empty={
        <EmptyState
          icon={<FileCode aria-hidden />}
          title="No Primitives Found"
          description="Try adjusting your filters or create a new primitive."
          variant="compact"
        />
      }
      toolbar={toolbar}
      footer={
        <DataTableFoot data-testid="primitives-foot">
          <span>{typesFootLabel(primitives.length, totalCount, filtered)}</span>
        </DataTableFoot>
      }
    />
  );
}
