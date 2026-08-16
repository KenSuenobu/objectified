'use client';

/**
 * The §Tables specimens of the gallery (HIVE-2.3, #5282).
 *
 * The production counterpart of the Tables section of
 * `docs/mockups/foundations/design-system.html`, plus the three list screens the ticket is
 * judged on: `build/projects.html`, `workspace/api-keys.html` and `sources/catalog.html`.
 *
 * It lives in its own file rather than inline in `page.tsx` because it is the only section
 * of the gallery with real state — a selection, a sort, a page, and the four things a list
 * can be doing at any moment. Standing beside the mockup it answers the question the ticket
 * asks: can the three reference tables be drawn from column definitions alone, with no
 * page-local table CSS?
 */

import * as React from 'react';
import { Ban, Copy, Download, LayoutGrid, List, Pencil, Trash2 } from 'lucide-react';

import {
  Badge,
  Button,
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
  Segmented,
  SegmentedItem,
  dataTableRangeLabel,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui';

// ---------------------------------------------------------------------------------------
// Specimen data
// ---------------------------------------------------------------------------------------

/** One row of `docs/mockups/build/projects.html`. */
interface Project {
  id: string;
  name: string;
  slug: string;
  versions: number;
  status: 'active' | 'draft' | 'deleted';
  owner: string;
  updated: string;
}

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Payments API', slug: 'payments-api', versions: 12, status: 'active', owner: 'Ada Lovelace', updated: '2 hours ago' },
  { id: 'p2', name: 'Orders Service', slug: 'orders-service', versions: 4, status: 'active', owner: 'Grace Hopper', updated: 'yesterday' },
  { id: 'p3', name: 'Inventory Events', slug: 'inventory-events', versions: 7, status: 'draft', owner: 'Ada Lovelace', updated: 'Jul 30' },
  { id: 'p4', name: 'Legacy Gateway', slug: 'legacy-gateway', versions: 1, status: 'deleted', owner: 'Ada Lovelace', updated: 'Jun 3' },
];

/** One row of `docs/mockups/workspace/api-keys.html`. */
interface ApiKey {
  id: string;
  name: string;
  created: string;
  prefix: string;
  scopes: string[];
  lastUsed: string;
  status: 'active' | 'revoked';
}

const API_KEYS: ApiKey[] = [
  { id: 'k1', name: 'ci-deploy', created: 'Created by Ada · Aug 1', prefix: 'apk_live_7f3a…', scopes: ['*'], lastUsed: '2 minutes ago', status: 'active' },
  { id: 'k2', name: 'lint-bot', created: 'Created by Grace · Jul 12', prefix: 'apk_live_a91c…', scopes: ['lint:read', 'diff:read'], lastUsed: 'yesterday', status: 'active' },
  { id: 'k3', name: 'old-agent', created: 'Revoked by Ada · Jun 3', prefix: 'apk_live_0c22…', scopes: ['diff:read'], lastUsed: 'Jun 2', status: 'revoked' },
];

/** One row of `docs/mockups/sources/catalog.html` — the wide table. */
interface CatalogItem {
  id: string;
  title: string;
  format: string;
  version: string;
  operations: number;
  owner: string;
  source: string;
  imported: string;
}

const CATALOG: CatalogItem[] = [
  { id: 'c1', title: 'Stripe API', format: 'OpenAPI 3.1', version: '2024-06', operations: 412, owner: 'Ada Lovelace', source: 'github.com/stripe/openapi', imported: 'Aug 1' },
  { id: 'c2', title: 'Twilio Messaging', format: 'OpenAPI 3.0', version: 'v1', operations: 96, owner: 'Grace Hopper', source: 'twilio.com/docs', imported: 'Jul 9' },
  { id: 'c3', title: 'Internal Billing', format: 'AsyncAPI 3.0', version: '0.4.1', operations: 31, owner: 'Linus Torvalds', source: 'Uploaded file', imported: 'Jun 22' },
];

/** The four things a list can be doing, as the specimen's own switch. */
const TABLE_STATES = [
  { id: 'ready', label: 'Ready' },
  { id: 'loading', label: 'Loading' },
  { id: 'empty', label: 'Empty' },
  { id: 'error', label: 'Error' },
] as const;

type TableState = (typeof TABLE_STATES)[number]['id'];

/** How many rows a page of the specimen holds — enough to make the pager real. */
const PAGE_SIZE = 4;

// ---------------------------------------------------------------------------------------

/**
 * The gallery's three tables.
 *
 * @returns The Projects, API keys and Catalog specimens.
 */
export function TablesShowcase() {
  const [state, setState] = React.useState<TableState>('ready');
  const [view, setView] = React.useState('table');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [page, setPage] = React.useState(1);
  const [sort, setSort] = React.useState<DataTableSortState | null>({
    column: 'name',
    direction: 'asc',
  });
  const [catalogSort, setCatalogSort] = React.useState<DataTableSortState | null>({
    column: 'title',
    direction: 'asc',
  });

  const projectColumns: Array<DataTableColumn<Project>> = [
    {
      id: 'name',
      header: 'Project',
      sortable: true,
      skeletonWidth: '9rem',
      cell: (project) => (
        <>
          <DataTableCellPrimary>{project.name}</DataTableCellPrimary>
          <DataTableCellSub className="mono">{project.slug}</DataTableCellSub>
        </>
      ),
    },
    {
      id: 'versions',
      header: 'Versions',
      sortable: true,
      align: 'end',
      skeletonWidth: '2rem',
      cell: (project) => <span className="tabular-nums">{project.versions}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      skeletonWidth: '4rem',
      cell: (project) => <Badge status={project.status}>{project.status}</Badge>,
    },
    {
      id: 'owner',
      header: 'Created by',
      skeletonWidth: '7rem',
      cell: (project) => project.owner,
    },
    {
      id: 'updated',
      header: 'Updated',
      sortable: true,
      skeletonWidth: '5rem',
      cell: (project) => <span className="text-fg-muted">{project.updated}</span>,
    },
    {
      id: 'actions',
      headerLabel: 'Actions',
      actions: true,
      align: 'end',
      cell: (project) => (
        <>
          <Button variant="ghost" size="icon" aria-label={`Edit ${project.name}`}>
            <Pencil aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Delete ${project.name}`}>
            <Trash2 aria-hidden />
          </Button>
        </>
      ),
    },
  ];

  const apiKeyColumns: Array<DataTableColumn<ApiKey>> = [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      cell: (key) => (
        <>
          <DataTableCellPrimary>{key.name}</DataTableCellPrimary>
          <DataTableCellSub>{key.created}</DataTableCellSub>
        </>
      ),
    },
    { id: 'prefix', header: 'Prefix', className: 'mono text-xs', cell: (key) => key.prefix },
    {
      id: 'scopes',
      header: 'Scopes',
      cell: (key) => (
        <span className="flex flex-wrap gap-1">
          {key.scopes.map((scope) => (
            <Badge key={scope} variant="neutral" mono>
              {scope}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      sortable: true,
      cell: (key) => <span className="text-fg-muted">{key.lastUsed}</span>,
    },
    { id: 'status', header: 'Status', cell: (key) => <Badge status={key.status}>{key.status}</Badge> },
    {
      id: 'actions',
      headerLabel: 'Actions',
      actions: true,
      align: 'end',
      cell: (key) => (
        <>
          <Button variant="ghost" size="icon" aria-label={`Copy the prefix of ${key.name}`}>
            <Copy aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Revoke ${key.name}`}>
            <Ban aria-hidden />
          </Button>
        </>
      ),
    },
  ];

  const catalogColumns: Array<DataTableColumn<CatalogItem>> = [
    {
      id: 'title',
      header: 'Item',
      sortable: true,
      cell: (item) => <DataTableCellPrimary>{item.title}</DataTableCellPrimary>,
    },
    { id: 'format', header: 'Format', cell: (item) => <Badge variant="neutral">{item.format}</Badge> },
    { id: 'version', header: 'Version', className: 'mono text-xs', cell: (item) => item.version },
    {
      id: 'operations',
      header: 'Operations',
      align: 'end',
      sortable: true,
      cell: (item) => <span className="tabular-nums">{item.operations}</span>,
    },
    { id: 'owner', header: 'Owner', cell: (item) => item.owner },
    {
      id: 'source',
      header: 'Source',
      cell: (item) => <span className="text-fg-muted">{item.source}</span>,
    },
    {
      id: 'imported',
      header: 'Imported',
      sortable: true,
      align: 'end',
      cell: (item) => item.imported,
    },
  ];

  const rows = state === 'ready' ? PROJECTS : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-fg-muted">State</span>
        <Segmented size="sm" value={state} onValueChange={(next) => setState(next as TableState)} aria-label="Table state">
          {TABLE_STATES.map((option) => (
            <SegmentedItem key={option.id} value={option.id}>
              {option.label}
            </SegmentedItem>
          ))}
        </Segmented>
        <span className="text-xs text-fg-muted">
          Loading draws skeleton rows shaped like the columns — never a spinner in a table.
        </span>
      </div>

      <DataTable
        caption="Projects"
        columns={projectColumns}
        rows={rows}
        getRowId={(project) => project.id}
        getRowLabel={(project) => project.name}
        selectedIds={selected}
        onSelectionChange={setSelected}
        sort={sort}
        onSortChange={setSort}
        onRowActivate={() => undefined}
        rowClassName={(project) => (project.status === 'deleted' ? 'opacity-60' : undefined)}
        loading={state === 'loading'}
        error={state === 'error' ? 'Could not load projects — the API did not answer.' : undefined}
        empty={
          state === 'empty' ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-sm font-medium text-fg">No projects yet</p>
              <p className="text-xs text-fg-muted">
                A project holds the versions of one API. HIVE-2.5 brings the hex art.
              </p>
              <Button size="sm" variant="primary">
                New project
              </Button>
            </div>
          ) : undefined
        }
        bulkActions={
          <>
            <DataTableBulkAction>
              <Download aria-hidden />
              Export
            </DataTableBulkAction>
            <DataTableBulkAction>
              <Trash2 aria-hidden />
              Delete
            </DataTableBulkAction>
          </>
        }
        toolbar={
          <DataTableToolbar>
            <DataTableSearch aria-label="Filter projects" placeholder="Filter projects…" />
            {['all', 'active', 'draft', 'deleted'].map((facet) => (
              <DataTableFilterChip
                key={facet}
                active={statusFilter === facet}
                count={facet === 'all' ? PROJECTS.length : PROJECTS.filter((p) => p.status === facet).length}
                onClick={() => setStatusFilter(facet)}
              >
                {facet[0].toUpperCase() + facet.slice(1)}
              </DataTableFilterChip>
            ))}
            <DataTableToolbarSpacer />
            <Segmented size="sm" value={view} onValueChange={setView} aria-label="Project view">
              <SegmentedItem value="cards">
                <LayoutGrid aria-hidden />
                Cards
              </SegmentedItem>
              <SegmentedItem value="table">
                <List aria-hidden />
                Table
              </SegmentedItem>
            </Segmented>
          </DataTableToolbar>
        }
        footer={
          <DataTableFoot>
            <span>{dataTableRangeLabel(page, PAGE_SIZE, rows.length ? 14 : 0, 'project')}</span>
            <DataTablePager page={page} pageCount={4} onPageChange={setPage} />
          </DataTableFoot>
        }
      />

      <div className="flex flex-col gap-2">
        <p className="text-xs text-fg-muted">
          Dense, and with the revoked key held out of selection — a row the viewer cannot act
          on says so with a disabled checkbox rather than by silently ignoring the click.
        </p>
        <DataTable
          caption="API keys"
          dense
          columns={apiKeyColumns}
          rows={API_KEYS}
          getRowId={(key) => key.id}
          getRowLabel={(key) => key.name}
          selectedIds={[]}
          onSelectionChange={() => undefined}
          isRowSelectable={(key) => key.status === 'active'}
          sort={{ column: 'name', direction: 'asc' }}
          onSortChange={() => undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-fg-muted">
          Seven columns: the table scrolls sideways inside its own card, and the page never
          does.
        </p>
        <DataTable
          caption="Catalog"
          scrollX
          columns={catalogColumns}
          rows={CATALOG}
          getRowId={(item) => item.id}
          sort={catalogSort}
          onSortChange={setCatalogSort}
          footer={
            <DataTableFoot>
              <span>{dataTableRangeLabel(1, PAGE_SIZE, CATALOG.length, 'item')}</span>
            </DataTableFoot>
          }
        />
      </div>
    </div>
  );
}
