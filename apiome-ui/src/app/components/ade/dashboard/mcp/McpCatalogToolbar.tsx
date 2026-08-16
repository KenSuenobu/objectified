'use client';

import * as React from 'react';
import { LayoutGrid, List, Search, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/Select';
import {
  MCP_CATALOG_EMPTY_FILTERS,
  MCP_CATALOG_SORTS,
  mcpCatalogActiveFilterCount,
  type McpCatalogDensity,
  type McpCatalogFacet,
  type McpCatalogFacetKey,
  type McpCatalogFilters,
  type McpCatalogSortKey,
} from './mcpCatalogUi';

export interface McpCatalogToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  sort: McpCatalogSortKey;
  onSortChange: (sort: McpCatalogSortKey) => void;
  density: McpCatalogDensity;
  onDensityChange: (density: McpCatalogDensity) => void;
  facets: McpCatalogFacet[];
  filters: McpCatalogFilters;
  onFiltersChange: (filters: McpCatalogFilters) => void;
}

/** Toggle one value within a facet's selection array, returning a new filters object. */
function toggleFacetValue(
  filters: McpCatalogFilters,
  key: McpCatalogFacetKey,
  value: string,
): McpCatalogFilters {
  const current = filters[key];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  return { ...filters, [key]: next };
}

/** The grid ↔ dense-list density segmented control. */
function DensityToggle({
  density,
  onDensityChange,
}: {
  density: McpCatalogDensity;
  onDensityChange: (density: McpCatalogDensity) => void;
}): React.ReactElement {
  const base =
    'inline-flex size-control items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500';
  const active = 'bg-indigo-600 text-white';
  const idle =
    'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700';
  return (
    <div
      className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600"
      role="group"
      aria-label="Layout density"
    >
      <button
        type="button"
        className={cn(base, density === 'grid' ? active : idle)}
        aria-pressed={density === 'grid'}
        title="Grid"
        onClick={() => onDensityChange('grid')}
      >
        <LayoutGrid className="h-4 w-4" aria-hidden />
        <span className="sr-only">Grid view</span>
      </button>
      <button
        type="button"
        className={cn(
          base,
          'border-l border-gray-300 dark:border-gray-600',
          density === 'list' ? active : idle,
        )}
        aria-pressed={density === 'list'}
        title="Dense list"
        onClick={() => onDensityChange('list')}
      >
        <List className="h-4 w-4" aria-hidden />
        <span className="sr-only">Dense list view</span>
      </button>
    </div>
  );
}

/** One facet's value chips: a labeled group of toggle buttons with per-value counts. */
function FacetGroup({
  facet,
  selected,
  onToggle,
}: {
  facet: McpCatalogFacet;
  selected: string[];
  onToggle: (value: string) => void;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {facet.label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {facet.values.map((fv) => {
          const isOn = selected.includes(fv.value);
          return (
            <button
              key={fv.value}
              type="button"
              aria-pressed={isOn}
              onClick={() => onToggle(fv.value)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                isOn
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
              )}
            >
              <span className="truncate">{fv.label ?? fv.value}</span>
              <span className="tabular-nums text-gray-400 dark:text-gray-500">{fv.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * `<McpCatalogToolbar>` — the catalog controls strip: a search box (wired to the private search),
 * a sort `<select>` (default `Grade ▾`), a grid ↔ dense-list density toggle, and a collapsible
 * filter panel whose facet chips compose (host / grade / transport / safety / complexity /
 * protocol / health / visibility / auth / category).
 * Faceting is data-driven — only facets and values present in the catalog render. All state is
 * controlled by the parent so it can persist density and reflect filters in one place.
 */
export function McpCatalogToolbar({
  search,
  onSearchChange,
  sort,
  onSortChange,
  density,
  onDensityChange,
  facets,
  filters,
  onFiltersChange,
}: McpCatalogToolbarProps): React.ReactElement {
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const activeFilters = mcpCatalogActiveFilterCount(filters);
  const hasFacets = facets.length > 0;

  return (
    <div className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center gap-3 px-6 py-4">
        <div className="relative min-w-[260px] max-w-md flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by name, host, URL, or category…"
            className="bg-gray-50 pl-9 dark:bg-gray-900/50"
            aria-label="Search the catalog"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {hasFacets ? (
            <Button
              type="button"
              variant={filtersOpen || activeFilters > 0 ? 'secondary' : 'outline'}
              size="sm"
              className="h-control"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
              Filters
              {activeFilters > 0 ? (
                <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1 text-xs font-semibold text-white">
                  {activeFilters}
                </span>
              ) : null}
            </Button>
          ) : null}

          <div className="flex items-center gap-1.5">
            <label
              htmlFor="mcp-catalog-sort"
              className="text-xs font-medium text-gray-500 dark:text-gray-400"
            >
              Sort
            </label>
            <Select value={sort} onValueChange={(v) => onSortChange(v as McpCatalogSortKey)}>
              <SelectTrigger id="mcp-catalog-sort" className="h-control w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MCP_CATALOG_SORTS.map((opt) => (
                  <SelectItem key={opt.key} value={opt.key}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DensityToggle density={density} onDensityChange={onDensityChange} />
        </div>
      </div>

      {filtersOpen && hasFacets ? (
        <div className="border-t border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/40">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {facets.map((facet) => (
              <FacetGroup
                key={facet.key}
                facet={facet}
                selected={filters[facet.key]}
                onToggle={(value) => onFiltersChange(toggleFacetValue(filters, facet.key, value))}
              />
            ))}
          </div>
          {activeFilters > 0 ? (
            <div className="mt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-gray-500"
                onClick={() => onFiltersChange({ ...MCP_CATALOG_EMPTY_FILTERS })}
              >
                <X className="h-4 w-4" aria-hidden />
                Clear all filters
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
