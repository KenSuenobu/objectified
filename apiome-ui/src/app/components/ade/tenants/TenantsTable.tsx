'use client';

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Building2,
  Check,
  Ellipsis,
  LogIn,
  Lock,
  Pencil,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Users,
} from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
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
  matchesTenantFacet,
  searchTenantRows,
  sortTenantRows,
  summariseTenantRows,
  tenantFacetCounts,
  tenantStatus,
  tenantStatusLabel,
  TENANT_FACETS,
  TENANT_FACET_LABELS,
  type TenantFacet,
  type TenantRow,
} from './tenantsModel';

/**
 * The tenants list — HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `#tenants-table`; DESIGN.md §8 (list
 * pattern) and §2.4 (the shared status vocabulary).
 *
 * ### What changed from the screen this replaces
 *
 * The old table was four hand-built `<th>`/`<td>` columns over
 * `dashboardScreenClasses.ts`, with a gradient "Current" pill, two bespoke status chips and
 * a menu whose Manage item reached into the DOM. It is now {@link DataTable} — so it gets
 * the sticky caps header, the row-hover actions, the `.` shortcut, the skeleton and the
 * in-card empty state for free — with the toolbar the mockup adds: a search box over name
 * *and* slug, and the three facet chips.
 *
 * Two columns are new and both are derivable from what the page already loads: **Your role**
 * (the viewer administers this tenant, or does not) and **Status**, which now goes through
 * the status vocabulary instead of naming emerald and red itself.
 *
 * The mockup also draws a **Plan** column. It is deliberately absent: plan data comes from
 * `/api/tenants/license`, a proxy scoped to the session's current tenant, so the column
 * could only ever be filled in for one row out of however many. A column that is blank for
 * every tenant but one is worse than no column, and the plan is shown where it can be
 * correct — in the drawer's License & plan tab.
 */

/** Props for {@link TenantsTable}. */
export interface TenantsTableProps {
  /** Every tenant the viewer belongs to, with `isAdmin`/`isCurrent` already attached. */
  rows: readonly TenantRow[];
  /** True while the page is loading the tenant lists. */
  loading?: boolean;
  /** The load error, if the tenant lists could not be read. */
  error?: string | null;
  /** Retry the load. */
  onRetry?: () => void;
  /** Switch the session to this tenant. */
  onSelectTenant: (tenant: TenantRow) => void;
  /** Open the manage drawer for this tenant. */
  onManageTenant: (tenant: TenantRow) => void;
  /** Open the Edit tenant dialog. */
  onEditTenant: (tenant: TenantRow) => void;
  /** Open the Create tenant flow, from the empty state. */
  onCreateTenant: () => void;
}

/** One item of a row's overflow menu. */
const MENU_ITEM_CLASS = 'tnt-menu__item';

/**
 * The tenants list, its toolbar and its row menus.
 *
 * @param props See {@link TenantsTableProps}.
 * @returns The table card.
 */
export default function TenantsTable({
  rows,
  loading = false,
  error = null,
  onRetry,
  onSelectTenant,
  onManageTenant,
  onEditTenant,
  onCreateTenant,
}: TenantsTableProps) {
  const [query, setQuery] = React.useState('');
  const [facet, setFacet] = React.useState<TenantFacet>('all');
  const [sort, setSort] = React.useState<DataTableSortState | null>({
    column: 'name',
    direction: 'asc',
  });

  const searched = React.useMemo(() => searchTenantRows(rows, query), [rows, query]);
  const counts = React.useMemo(() => tenantFacetCounts(searched), [searched]);
  const visible = React.useMemo(
    () => sortTenantRows(searched.filter((row) => matchesTenantFacet(row, facet)), sort),
    [searched, facet, sort]
  );
  const summary = React.useMemo(() => summariseTenantRows(rows), [rows]);
  const narrowed = query.trim().length > 0 || facet !== 'all';

  const columns = React.useMemo<DataTableColumn<TenantRow>[]>(
    () => [
      {
        id: 'name',
        header: 'Tenant',
        sortable: true,
        cell: (tenant) => (
          <div className="flex items-center gap-3">
            <Avatar
              name={tenant.name}
              seed={tenant.id}
              size="sm"
              shape="hex"
              tone={tenant.isCurrent ? 'brand' : 'auto'}
            />
            <div className="min-w-0">
              <DataTableCellPrimary className="flex items-center gap-2">
                {tenant.isCurrent ? (
                  <span className="truncate">{tenant.name}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSelectTenant(tenant)}
                    title="Select tenant"
                    className="truncate rounded-sm text-left transition-colors hover:text-accent-fg"
                  >
                    {tenant.name}
                  </button>
                )}
                {tenant.isCurrent && (
                  <Badge variant="accent">
                    <Check aria-hidden />
                    Current
                  </Badge>
                )}
              </DataTableCellPrimary>
              <DataTableCellSub className="truncate font-mono">{tenant.slug}</DataTableCellSub>
            </div>
          </div>
        ),
        skeletonWidth: '11rem',
      },
      {
        id: 'description',
        header: 'Description',
        cell: (tenant) =>
          tenant.description ? (
            <span className="line-clamp-1 max-w-[22rem] text-sm text-fg-muted">
              {tenant.description}
            </span>
          ) : (
            <span className="text-sm text-fg-muted">—</span>
          ),
        skeletonWidth: '14rem',
      },
      {
        id: 'role',
        header: 'Your role',
        cell: (tenant) =>
          tenant.isAdmin ? (
            <Badge variant="violet">
              <Shield aria-hidden />
              Admin
            </Badge>
          ) : (
            <Badge variant="outline">
              <Users aria-hidden />
              Member
            </Badge>
          ),
        skeletonWidth: '4.5rem',
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (tenant) => (
          <Badge status={tenantStatus(tenant)} dot>
            {tenantStatusLabel(tenant)}
          </Badge>
        ),
        skeletonWidth: '4.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        cell: (tenant) => (
          <div className="flex items-center justify-end gap-1">
            {tenant.isAdmin && (
              <Button variant="outline" size="sm" onClick={() => onManageTenant(tenant)}>
                <SlidersHorizontal aria-hidden />
                Manage
              </Button>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-1.5"
                  aria-label={`Actions for ${tenant.name}`}
                >
                  <Ellipsis aria-hidden />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
                  {tenant.isAdmin ? (
                    <>
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => onEditTenant(tenant)}
                      >
                        <Pencil aria-hidden />
                        Edit
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => onManageTenant(tenant)}
                      >
                        <SlidersHorizontal aria-hidden />
                        Manage
                      </DropdownMenu.Item>
                    </>
                  ) : (
                    <span className={`${MENU_ITEM_CLASS} tnt-menu__item--note`}>
                      <Lock aria-hidden />
                      Manage — admins only
                    </span>
                  )}
                  {tenant.isCurrent ? (
                    <>
                      <DropdownMenu.Separator className="tnt-menu__sep" />
                      <span className={`${MENU_ITEM_CLASS} tnt-menu__item--note`}>
                        <Check aria-hidden />
                        Current tenant
                      </span>
                    </>
                  ) : (
                    <>
                      <DropdownMenu.Separator className="tnt-menu__sep" />
                      <DropdownMenu.Item
                        className={MENU_ITEM_CLASS}
                        onSelect={() => onSelectTenant(tenant)}
                      >
                        <LogIn aria-hidden />
                        Select
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ),
        skeletonWidth: '5rem',
      },
    ],
    [onEditTenant, onManageTenant, onSelectTenant]
  );

  return (
    <DataTable
      columns={columns}
      rows={visible}
      getRowId={(tenant) => tenant.id}
      getRowLabel={(tenant) => tenant.name}
      caption="Tenants you belong to"
      scrollX
      loading={loading}
      loadingLabel="Loading tenants…"
      error={error}
      onRetry={onRetry}
      sort={sort}
      onSortChange={setSort}
      // The current row is tinted; a disabled one is *not* faded. HIVE-4.8 measured that
      // rule: there is no opacity at which quiet text on a light surface survives AA, and
      // `--fg-muted` at 11 px drops to 3.99:1 behind an `opacity: .8` row. The Disabled
      // badge is what says a tenant is off, and it says it without dimming anything.
      rowClassName={(tenant) => (tenant.isCurrent ? 'tnt-row--current bg-accent-soft' : undefined)}
      data-testid="tenants-table"
      toolbar={
        <DataTableToolbar>
          <DataTableSearch
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name or slug…"
            aria-label="Filter tenants"
          />
          {TENANT_FACETS.map((entry) => (
            <DataTableFilterChip
              key={entry}
              active={facet === entry}
              count={counts[entry]}
              onClick={() => setFacet(entry)}
            >
              {entry === 'administered' && <Shield aria-hidden />}
              {TENANT_FACET_LABELS[entry]}
            </DataTableFilterChip>
          ))}
        </DataTableToolbar>
      }
      empty={
        narrowed ? (
          <EmptyState
            variant="compact"
            icon={<Building2 aria-hidden />}
            title="No tenants match these filters"
            description="Clear the search box or pick a different facet."
            action={
              <Button
                variant="outline"
                size="sm"
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
            icon={<Building2 aria-hidden />}
            title="No tenants yet"
            description="You are not a member of any tenants yet. Create your own workspace, or ask an administrator to invite you."
            action={
              <Button onClick={onCreateTenant}>
                <Building2 aria-hidden />
                Create a tenant
              </Button>
            }
            secondaryAction={
              onRetry ? (
                <Button variant="outline" onClick={onRetry}>
                  <RefreshCw aria-hidden />
                  Check again
                </Button>
              ) : undefined
            }
          />
        )
      }
      footer={
        <DataTableFoot>
          <span>
            {summary.total} {summary.total === 1 ? 'tenant' : 'tenants'} · you administer{' '}
            {summary.administered}
          </span>
        </DataTableFoot>
      }
    />
  );
}
