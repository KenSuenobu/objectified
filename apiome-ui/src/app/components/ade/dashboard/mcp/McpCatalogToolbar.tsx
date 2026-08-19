'use client';

/**
 * The MCP catalog's controls strip (V2-MCP-24.8; redesigned HIVE-7.7, #5324).
 *
 * Authority: `docs/mockups/sources/mcp-servers.html` — the toolbar card and the facet panel that
 * drops out of it, whose **Notes → Keeps (1:1)** list fixes the contents: search over
 * name/slug/host/URL/category, a Filters button with an active-value bubble, Sort (Grade default ·
 * Name · Last discovered · Capabilities · Health), the Grid / Dense list density pair, and the ten
 * facets in the order Host · Grade · Transport · Safety · Complexity · Protocol · Health ·
 * Visibility · Auth · Category.
 *
 * ### What the redesign changed
 *
 * 1. **The strip was a bar, not a card.** `border-b border-gray-200 bg-white dark:border-gray-700
 *    dark:bg-gray-800` drew a full-bleed band across the page; the mockup's toolbar is a `ui/Card`
 *    like every other panel on the page, so the controls sit on the same surface as the content
 *    they filter.
 * 2. **The density pair was a hand-built segmented control** — two buttons in a
 *    `border-gray-300` box with `bg-indigo-600 text-white` for the pressed one. It is
 *    `ui/Segmented`, whose options are `role="radio"` in a real radiogroup, so the pair is one
 *    choice to a screen reader and one arrow-key stop to a keyboard.
 * 3. **The facet chips were six palette classes each**, indigo when on and grey when off. They
 *    are `.mcp-facet__chip`, an accent hairline over the surface when on — the same mark
 *    `DataTableFilterChip` and `.spec-filters__facet[data-active]` use for a facet that is
 *    narrowing a list.
 * 4. **The active-filter bubble was `bg-indigo-600 text-white`.** It is `Badge variant="ink"`,
 *    the vocabulary's "out-rank every coloured chip around me" tone, which is what the mockup's
 *    `.badge--ink` is.
 * 5. **The panel never said what it was doing.** The mockup prints the rule under the chips —
 *    facets AND, values OR, counts from the full catalog — so a reader who selects two grades and
 *    sees the count stay at 6 knows why.
 *
 * The health facet's chips carry a status dot, as the mockup's do. It is drawn from the shared
 * vocabulary and never travels alone: the value's own word sits beside it.
 */

import * as React from 'react';
import { LayoutGrid, List, Search, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@lib/utils';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Input } from '../../../ui/Input';
import { Segmented, SegmentedItem } from '../../../ui/Segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/Select';
import { STATUS_TONE_DOT_CLASS, statusTone } from '../../../ui/statusVocabulary';
import {
  MCP_CATALOG_EMPTY_FILTERS,
  MCP_CATALOG_FACET_NOTE,
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

/** One facet's value chips: a labelled group of toggle buttons with per-value counts. */
function FacetGroup({
  facet,
  selected,
  onToggle,
}: {
  facet: McpCatalogFacet;
  selected: string[];
  onToggle: (value: string) => void;
}): React.ReactElement {
  // Only the health facet's values are vocabulary states, so only it earns dots. Everywhere else
  // a dot would be decoration standing in for nothing.
  const showsDots = facet.key === 'healths';
  return (
    <div className="mcp-facet">
      <p className="mcp-facet__label">{facet.label}</p>
      <div className="mcp-facet__chips">
        {facet.values.map((fv) => {
          const isOn = selected.includes(fv.value);
          return (
            <button
              key={fv.value}
              type="button"
              aria-pressed={isOn}
              onClick={() => onToggle(fv.value)}
              className="mcp-facet__chip"
              data-active={isOn ? '' : undefined}
            >
              {showsDots ? (
                <span
                  className={cn('mcp-facet__dot', STATUS_TONE_DOT_CLASS[statusTone(fv.value)])}
                  aria-hidden
                />
              ) : null}
              <span className="mcp-facet__value">{fv.label ?? fv.value}</span>
              <span className="mcp-facet__count">{fv.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * `<McpCatalogToolbar>` — search, filters, sort and density for the catalog.
 *
 * Faceting is data-driven: only facets and values present in the catalog render. All state is
 * controlled by the parent so it can persist density and reflect filters in one place.
 *
 * @param props See {@link McpCatalogToolbarProps}.
 * @returns The toolbar card, with the facet panel when it is open.
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
    <Card data-testid="mcp-catalog-toolbar">
      <div className="mcp-toolbar">
        <div className="input-wrap mcp-toolbar__search">
          <Search aria-hidden />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by name, host, URL, or category…"
            aria-label="Search the catalog"
          />
        </div>

        <div className="mcp-toolbar__controls">
          {hasFacets ? (
            <Button
              type="button"
              variant={activeFilters > 0 ? 'soft' : 'outline'}
              size="sm"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
              data-testid="mcp-catalog-filters-toggle"
            >
              <SlidersHorizontal aria-hidden />
              Filters
              {activeFilters > 0 ? <Badge variant="ink">{activeFilters}</Badge> : null}
            </Button>
          ) : null}

          <label className="mcp-toolbar__sort" htmlFor="mcp-catalog-sort">
            Sort
            <Select value={sort} onValueChange={(v) => onSortChange(v as McpCatalogSortKey)}>
              <SelectTrigger id="mcp-catalog-sort" className="mcp-toolbar__sort-control">
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
          </label>

          <Segmented
            size="sm"
            value={density}
            onValueChange={(next) => onDensityChange(next as McpCatalogDensity)}
            aria-label="Layout density"
          >
            <SegmentedItem value="grid">
              <LayoutGrid aria-hidden />
              Grid
              <span className="sr-only"> view</span>
            </SegmentedItem>
            <SegmentedItem value="list">
              <List aria-hidden />
              Dense list
              <span className="sr-only"> view</span>
            </SegmentedItem>
          </Segmented>
        </div>
      </div>

      {filtersOpen && hasFacets ? (
        <div className="mcp-facet-panel" data-testid="mcp-catalog-facets">
          <div className="mcp-facets">
            {facets.map((facet) => (
              <FacetGroup
                key={facet.key}
                facet={facet}
                selected={filters[facet.key]}
                onToggle={(value) => onFiltersChange(toggleFacetValue(filters, facet.key, value))}
              />
            ))}
          </div>
          <div className="mcp-facet-panel__foot">
            <p className="mcp-facet-panel__note">{MCP_CATALOG_FACET_NOTE}</p>
            {activeFilters > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onFiltersChange({ ...MCP_CATALOG_EMPTY_FILTERS })}
              >
                <X aria-hidden />
                Clear all filters
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
