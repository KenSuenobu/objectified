'use client';

/**
 * Bring in → MCP servers → Capabilities (V2-MCP-35.4 / MCAT-21.4, #4663; redesigned HIVE-7.9,
 * #5326).
 *
 * Authority: `docs/mockups/sources/mcp-capabilities.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria; DESIGN.md §5.3 (page header) and §8 (list page: header →
 * toolbar → table → foot).
 *
 * ### What this screen is
 *
 * A "what can be done" index: every tool, resource, resource template and prompt on every current
 * MCP snapshot in the workspace, with a link back to the server that exposes each. One thing about
 * it was true before this redesign and had to stay true, because it is the whole reason the screen
 * scales — **the filtering, the sorting and the paging all happen on the server**. A catalog can
 * hold tens of thousands of capability items, so `GET /api/mcp/capabilities` takes `name`, `type`,
 * `host`, `visibility`, `sort`, `direction`, `limit` and `offset`, and this screen holds exactly
 * one page of fifty rows at a time.
 *
 * ### What the redesign changed
 *
 * 1. **The screen drew its own header and its own `<main>`.** A `border-b border-gray-200 bg-white
 *    dark:bg-gray-800` bar with an `h2` and an indigo `Layers` glyph beside it, over the
 *    `dashboardMainClass` landmark the shell already draws. It is `Page` + `PageHeader` +
 *    `PageBody`, with the section tabs in the header's own tab slot and the mockup's **Add MCP
 *    server** shortcut as the one primary action.
 * 2. **The table was hand-built** — a `<table className="min-w-full divide-y divide-gray-200">`
 *    with a bespoke `CapabilitySortHeader` that re-implemented `aria-sort`, the chevron swap and
 *    the "sort by X (descending)" title from scratch. It is `ui/DataTable`, which already owns all
 *    of that plus the sticky caps header, the hover tint, the skeleton rows and the three states
 *    the body can be in. The one thing the shared table does *not* fit is its third sort state:
 *    `nextSortState` cycles asc → desc → unsorted, and this list has no unsorted order to return
 *    to, so {@link mcpCapabilityDirectorySortFromTable} resolves it back to `server ascending`.
 * 3. **The five filters were a `flex-wrap` band of bare labels and inputs** in a `rounded-lg
 *    border border-gray-200 bg-white` box above the table. They are the table's own toolbar now,
 *    inside the same card as the rows they filter, and each control is a `FormField` so the label
 *    actually names it.
 * 4. **The pager sat above the table in a grey row** and repeated nothing underneath. The count
 *    and the pager are the table's foot, and the foot states the whole query in one sentence —
 *    what matched, the page size, and how it is ordered — which is the mockup's own line.
 * 5. **There were no presets.** The mockup adds a row of one-click views;
 *    {@link MCP_CAPABILITY_DIRECTORY_PRESETS} says why these four rather than the mockup's four,
 *    and each tile's count is a real `COUNT(*)` from the same endpoint the table reads.
 * 6. **The server column was a bare indigo link with "Grade B" beside it in grey.** It leads with
 *    the `GradeGlyph` every other MCP surface leads with, which is the mockup's own change.
 * 7. **The no-tenant case rendered an empty table.** It is `GatedState`.
 */

import * as React from 'react';
import Link from 'next/link';
import { Layers, MessageSquareText, Plus, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';

import { useAuthSession } from '@lib/auth/session-client';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFoot,
  DataTablePager,
  DataTableToolbar,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { GradeGlyph } from '@/app/components/ui/mcp/GradeGlyph';
import { McpSectionTabs } from '@/app/components/ade/dashboard/mcp/McpSectionTabs';
import {
  MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
  MCP_CAPABILITY_DIRECTORY_DESCRIPTION,
  MCP_CAPABILITY_DIRECTORY_EMPTY_DESC,
  MCP_CAPABILITY_DIRECTORY_EMPTY_TITLE,
  MCP_CAPABILITY_DIRECTORY_ERROR_FALLBACK,
  MCP_CAPABILITY_DIRECTORY_ERROR_TITLE,
  MCP_CAPABILITY_DIRECTORY_KINDS,
  MCP_CAPABILITY_DIRECTORY_LOADING,
  MCP_CAPABILITY_DIRECTORY_NO_TENANT,
  MCP_CAPABILITY_DIRECTORY_PAGE_SIZE,
  MCP_CAPABILITY_DIRECTORY_PRESETS,
  MCP_CAPABILITY_DIRECTORY_SORTS,
  MCP_CAPABILITY_DIRECTORY_TITLE,
  mcpCapabilityDirectoryApplyPreset,
  mcpCapabilityDirectoryDisplayName,
  mcpCapabilityDirectoryEndpointHref,
  mcpCapabilityDirectoryFootLine,
  mcpCapabilityDirectoryFromPayload,
  mcpCapabilityDirectoryKindBadge,
  mcpCapabilityDirectoryPresetCountParams,
  mcpCapabilityDirectoryPresetIsActive,
  mcpCapabilityDirectoryQueryParams,
  mcpCapabilityDirectoryRange,
  mcpCapabilityDirectorySortFromTable,
  type McpCapabilityDirectoryEntry,
  type McpCapabilityDirectoryFilters,
  type McpCapabilityDirectoryPreset,
  type McpCapabilityDirectorySort,
  type McpCapabilityDirectorySortDirection,
} from '@/app/components/ade/dashboard/mcp/mcpCapabilityDirectoryUi';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** The catalog the trail passes through, and where "Add MCP server" leads. */
const CATALOG_ROUTE = '/ade/dashboard/mcp';

/** The glyph each preset tile leads with, by preset id. */
const PRESET_ICON: Readonly<Record<string, React.ComponentType<{ 'aria-hidden'?: boolean }>>> = {
  tools: Wrench,
  resources: Layers,
  prompts: MessageSquareText,
  public: ShieldCheck,
};

export default function McpCapabilityDirectoryClient() {
  const { data: session } = useAuthSession();
  const sessionUser = session?.user as { current_tenant_id?: string } | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;

  const [items, setItems] = React.useState<McpCapabilityDirectoryEntry[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState<McpCapabilityDirectoryFilters>(
    MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
  );
  const [sort, setSort] = React.useState<McpCapabilityDirectorySort>('server');
  const [direction, setDirection] = React.useState<McpCapabilityDirectorySortDirection>('asc');
  const [nameDraft, setNameDraft] = React.useState('');
  const [presetCounts, setPresetCounts] = React.useState<Record<string, number>>({});

  const pageCount = Math.max(1, Math.ceil(total / MCP_CAPABILITY_DIRECTORY_PAGE_SIZE));
  const page = Math.floor(offset / MCP_CAPABILITY_DIRECTORY_PAGE_SIZE) + 1;

  const load = React.useCallback(async () => {
    if (!currentTenantId) {
      setItems([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = mcpCapabilityDirectoryQueryParams(
        filters,
        sort,
        direction,
        offset,
        MCP_CAPABILITY_DIRECTORY_PAGE_SIZE,
      );
      const res = await fetch(`/api/mcp/capabilities?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      const result = mcpCapabilityDirectoryFromPayload(data);
      setItems(result.items);
      setTotal(result.total);
    } catch (e) {
      setItems([]);
      setTotal(0);
      setError(e instanceof Error ? e.message : MCP_CAPABILITY_DIRECTORY_ERROR_FALLBACK);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, filters, offset, sort, direction]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Count each preset's rows.
   *
   * Four `limit=1` reads whose only interesting field is `total`, run in parallel and refreshed by
   * Refresh. A count that fails is *dropped* rather than shown as zero — "none" and "not counted"
   * are different facts, and the tile draws no chip for the second, which is the rule
   * `McpSectionTabs` set for its own counts.
   */
  const loadPresetCounts = React.useCallback(async () => {
    if (!currentTenantId) {
      setPresetCounts({});
      return;
    }
    const entries = await Promise.all(
      MCP_CAPABILITY_DIRECTORY_PRESETS.map(async (preset) => {
        try {
          const params = mcpCapabilityDirectoryPresetCountParams(preset);
          const res = await fetch(`/api/mcp/capabilities?${params.toString()}`, {
            credentials: 'include',
            cache: 'no-store',
          });
          if (!res.ok) return null;
          const data = await res.json().catch(() => ({}));
          return [preset.id, mcpCapabilityDirectoryFromPayload(data).total] as const;
        } catch {
          return null;
        }
      }),
    );
    setPresetCounts(Object.fromEntries(entries.filter((entry) => entry !== null)));
  }, [currentTenantId]);

  React.useEffect(() => {
    void loadPresetCounts();
  }, [loadPresetCounts]);

  const refresh = React.useCallback(() => {
    void load();
    void loadPresetCounts();
  }, [load, loadPresetCounts]);

  /** Any filter change starts the reader at the first page of the new result set. */
  const changeFilters = React.useCallback(
    (next: McpCapabilityDirectoryFilters) => {
      setOffset(0);
      setFilters(next);
      setNameDraft(next.name);
    },
    [],
  );

  const applyNameFilter = React.useCallback(() => {
    changeFilters({ ...filters, name: nameDraft.trim() });
  }, [changeFilters, filters, nameDraft]);

  const applyPreset = React.useCallback(
    (preset: McpCapabilityDirectoryPreset) => {
      changeFilters(mcpCapabilityDirectoryApplyPreset(preset, filters));
    },
    [changeFilters, filters],
  );

  const tableSort: DataTableSortState = { column: sort, direction };

  const handleSortChange = React.useCallback((next: DataTableSortState | null) => {
    const resolved = mcpCapabilityDirectorySortFromTable(next);
    setOffset(0);
    setSort(resolved.sort);
    setDirection(resolved.direction);
  }, []);

  const columns: ReadonlyArray<DataTableColumn<McpCapabilityDirectoryEntry>> = React.useMemo(
    () => [
      {
        id: 'name',
        header: 'Capability',
        sortable: true,
        skeletonWidth: '60%',
        cell: (entry) => (
          <div className="min-w-0">
            <DataTableCellPrimary className="mcpc-name">
              {mcpCapabilityDirectoryDisplayName(entry)}
            </DataTableCellPrimary>
            {entry.description ? (
              <DataTableCellSub className="mcpc-desc">{entry.description}</DataTableCellSub>
            ) : null}
            <DataTableCellSub className="mcpc-desc mono">{entry.itemName}</DataTableCellSub>
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        sortable: true,
        skeletonWidth: '4rem',
        cell: (entry) => {
          const badge = mcpCapabilityDirectoryKindBadge(entry.kind);
          return <Badge variant={badge.variant}>{badge.label}</Badge>;
        },
      },
      {
        id: 'server',
        header: 'Server',
        sortable: true,
        skeletonWidth: '9rem',
        cell: (entry) => (
          <Link
            href={mcpCapabilityDirectoryEndpointHref(entry.endpointId)}
            className="mcpc-server"
          >
            <GradeGlyph grade={entry.grade} score={entry.score} size="sm" showScore={false} />
            <span className="mcpc-server__name">{entry.endpointName}</span>
          </Link>
        ),
      },
      {
        id: 'host',
        header: 'Host',
        skeletonWidth: '8rem',
        cell: (entry) => <span className="mcpc-host mono">{entry.host}</span>,
      },
    ],
    [],
  );

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'MCP servers', href: CATALOG_ROUTE },
          { label: 'Capabilities' },
        ]}
        title={MCP_CAPABILITY_DIRECTORY_TITLE}
        description={MCP_CAPABILITY_DIRECTORY_DESCRIPTION}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={refresh}
              disabled={!currentTenantId}
              title="Reload capability directory"
              data-testid="mcp-capabilities-refresh"
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
            <Button asChild data-testid="mcp-capabilities-add">
              <Link href={CATALOG_ROUTE} title="Add an MCP server to the catalog">
                <Plus aria-hidden />
                Add MCP server
              </Link>
            </Button>
          </>
        }
        tabs={<McpSectionTabs counts={total > 0 ? { capabilities: total } : undefined} />}
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={MCP_CAPABILITY_DIRECTORY_NO_TENANT} />
        ) : (
          <>
            <section aria-labelledby="mcp-capability-presets" data-testid="mcp-capability-presets">
              <div className="mcpc-section-title">
                <h2 id="mcp-capability-presets">Presets</h2>
                <span>One-click views over the directory</span>
              </div>
              <div className="mcpc-presets">
                {MCP_CAPABILITY_DIRECTORY_PRESETS.map((preset) => {
                  const Icon = PRESET_ICON[preset.id] ?? Layers;
                  const active = mcpCapabilityDirectoryPresetIsActive(preset, filters);
                  const count = presetCounts[preset.id];
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => applyPreset(preset)}
                      className="mcpc-preset"
                      data-testid={`mcp-capability-preset-${preset.id}`}
                    >
                      <span className="tnt-icon-tile" data-tone={preset.tone} aria-hidden>
                        <Icon />
                      </span>
                      <span className="mcpc-preset__body">
                        <span className="mcpc-preset__label">{preset.label}</span>
                        <span className="mcpc-preset__desc">
                          {preset.description}
                          {typeof count === 'number' ? ` · ${count.toLocaleString()}` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <DataTable
              caption={MCP_CAPABILITY_DIRECTORY_TITLE}
              columns={columns}
              rows={items}
              getRowId={(entry) => `${entry.endpointId}:${entry.itemId}`}
              getRowLabel={(entry) => mcpCapabilityDirectoryDisplayName(entry)}
              scrollX
              sort={tableSort}
              onSortChange={handleSortChange}
              loading={loading}
              loadingLabel={MCP_CAPABILITY_DIRECTORY_LOADING}
              error={error}
              errorTitle={MCP_CAPABILITY_DIRECTORY_ERROR_TITLE}
              onRetry={refresh}
              empty={
                <EmptyState
                  variant="compact"
                  tone="neutral"
                  icon={<Layers aria-hidden />}
                  title={MCP_CAPABILITY_DIRECTORY_EMPTY_TITLE}
                  description={MCP_CAPABILITY_DIRECTORY_EMPTY_DESC}
                  surface={false}
                />
              }
              toolbar={
                <DataTableToolbar className="mcpc-toolbar">
                  <FormField label="Name" htmlFor="capability-directory-name">
                    <div className="mcpc-toolbar__pair">
                      <Input
                        id="capability-directory-name"
                        value={nameDraft}
                        onChange={(event) => setNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') applyNameFilter();
                        }}
                        placeholder="Filter by name or title…"
                      />
                      <Button type="button" variant="outline" onClick={applyNameFilter}>
                        Apply
                      </Button>
                    </div>
                  </FormField>

                  <FormField label="Type" htmlFor="capability-directory-type">
                    <Select
                      value={filters.type || 'all'}
                      onValueChange={(value) =>
                        changeFilters({
                          ...filters,
                          type:
                            value === 'all'
                              ? ''
                              : (value as McpCapabilityDirectoryFilters['type']),
                        })
                      }
                    >
                      <SelectTrigger id="capability-directory-type">
                        <SelectValue placeholder="All types" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All types</SelectItem>
                        {MCP_CAPABILITY_DIRECTORY_KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {mcpCapabilityDirectoryKindBadge(kind).label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>

                  <FormField label="Host" htmlFor="capability-directory-host">
                    <Input
                      id="capability-directory-host"
                      value={filters.host}
                      onChange={(event) =>
                        changeFilters({ ...filters, host: event.target.value })
                      }
                      placeholder="e.g. mcp.example.com"
                    />
                  </FormField>

                  <FormField label="Visibility" htmlFor="capability-directory-visibility">
                    <Select
                      value={filters.visibility || 'all'}
                      onValueChange={(value) =>
                        changeFilters({
                          ...filters,
                          visibility:
                            value === 'all'
                              ? ''
                              : (value as McpCapabilityDirectoryFilters['visibility']),
                        })
                      }
                    >
                      <SelectTrigger id="capability-directory-visibility">
                        <SelectValue placeholder="All" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="private">Private</SelectItem>
                        <SelectItem value="public">Public</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>

                  <FormField label="Sort" htmlFor="capability-directory-sort">
                    <Select
                      value={sort}
                      onValueChange={(value) =>
                        handleSortChange({
                          column: value as McpCapabilityDirectorySort,
                          direction: 'asc',
                        })
                      }
                    >
                      <SelectTrigger id="capability-directory-sort">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MCP_CAPABILITY_DIRECTORY_SORTS.map((option) => (
                          <SelectItem key={option.key} value={option.key}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>

                  <span className="mcpc-toolbar__range" data-testid="mcp-capabilities-range">
                    {mcpCapabilityDirectoryRange(offset, items.length, total)}
                  </span>
                </DataTableToolbar>
              }
              footer={
                <DataTableFoot>
                  <span data-testid="mcp-capabilities-foot">
                    {mcpCapabilityDirectoryFootLine(total, filters, sort, direction)}
                  </span>
                  <DataTablePager
                    page={page}
                    pageCount={pageCount}
                    onPageChange={(next) =>
                      setOffset((next - 1) * MCP_CAPABILITY_DIRECTORY_PAGE_SIZE)
                    }
                  />
                </DataTableFoot>
              }
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}
