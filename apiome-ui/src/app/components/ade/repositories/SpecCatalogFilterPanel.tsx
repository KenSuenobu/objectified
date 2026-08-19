'use client';

/**
 * The discovered-specs filter panel (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-catalog.html` — the `card` above the table
 * holding a search field, five facet selects, two checkboxes and *Clear filters*.
 *
 * ### Why this is a panel and not a `DataTableToolbar`
 *
 * A toolbar is a strip inside a table's card, sized for two or three controls. This screen
 * narrows on eight axes at once, and the mockup draws them as a card of their own above the
 * table — which is also what stops the second row (the two checkboxes and the note about the
 * address bar) from having to live inside the table's chrome.
 *
 * ### What it owns
 *
 * The paint, and nothing else. Every value is a controlled prop and every change is reported
 * up; the debounce, the request and the address bar all belong to the screen. That is what
 * lets `specCatalogModel` hold the rules and this file hold no strings at all beyond the
 * labels of its own controls.
 */

import * as React from 'react';
import { Search, X } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { Input } from '@/app/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';

import {
  SPEC_CATALOG_SORT_OPTIONS,
  SPEC_CATALOG_URL_NOTE,
  type SpecCatalogFacetOption,
  type SpecCatalogFacets,
  type SpecCatalogFilters as SpecCatalogFilterState,
} from './specCatalogModel';

/** One facet dropdown's configuration. */
interface FacetConfig {
  /** The `data-testid` suffix and React key. */
  id: string;
  /** The control's accessible name. */
  label: string;
  /** What "not narrowing on this axis" is called — `All formats`. */
  allLabel: string;
  /** The currently chosen value, or `all`. */
  value: string;
  /** The catalog-wide options, or an empty array before the facets have arrived. */
  options: readonly SpecCatalogFacetOption[];
  /** Report a change. */
  onChange: (next: string) => void;
}

/**
 * A labelled facet dropdown.
 *
 * The count is printed inside the option rather than beside the trigger, because the trigger
 * has to fit five of these on one line: a facet's own figure is what an operator wants while
 * they are choosing, not afterwards.
 *
 * @param facet - See {@link FacetConfig}.
 * @returns The select.
 */
function FacetSelect({ facet }: { facet: FacetConfig }) {
  return (
    <Select value={facet.value} onValueChange={facet.onChange}>
      <SelectTrigger
        className="spec-filters__facet"
        aria-label={facet.label}
        data-testid={`spec-catalog-filter-${facet.id}`}
        // The accent hairline `repo-filter[data-active]` draws: a facet that is narrowing the
        // list must not look like one that is not.
        data-active={facet.value !== 'all' ? '' : undefined}
      >
        <SelectValue placeholder={facet.allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{facet.allLabel}</SelectItem>
        {facet.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label} ({option.count.toLocaleString()})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface SpecCatalogFilterPanelProps {
  /** The current view, as the screen holds it. */
  filters: SpecCatalogFilterState;
  /** What the search box shows — the undebounced draft, not the committed term. */
  searchDraft: string;
  /** The catalog-wide facet options, or null before the first response. */
  facets: SpecCatalogFacets | null;
  /** True when the view differs from the default one, which is what shows *Clear filters*. */
  active: boolean;
  /** A keystroke in the search box. */
  onSearch: (next: string) => void;
  /** A change to anything but the search term. */
  onChange: (patch: Partial<Omit<SpecCatalogFilterState, 'q'>>) => void;
  /** *Clear filters* — the search term included. */
  onClear: () => void;
}

/**
 * Render the filter panel. See {@link SpecCatalogFilterPanelProps}.
 *
 * @returns The card holding both filter rows.
 */
export function SpecCatalogFilterPanel({
  filters,
  searchDraft,
  facets,
  active,
  onSearch,
  onChange,
  onClear,
}: SpecCatalogFilterPanelProps) {
  const facetConfigs: FacetConfig[] = [
    {
      id: 'format',
      label: 'Format',
      allLabel: 'All formats',
      value: filters.format,
      options: facets?.formats ?? [],
      onChange: (format) => onChange({ format }),
    },
    {
      id: 'repository',
      label: 'Repository',
      allLabel: 'All repositories',
      value: filters.repositoryId,
      options: facets?.repositories ?? [],
      onChange: (repositoryId) => onChange({ repositoryId }),
    },
    {
      id: 'project',
      label: 'Project',
      allLabel: 'All projects',
      value: filters.projectId,
      options: facets?.projects ?? [],
      onChange: (projectId) => onChange({ projectId }),
    },
    {
      id: 'status',
      label: 'Status',
      allLabel: 'All statuses',
      value: filters.status,
      options: facets?.statuses ?? [],
      onChange: (status) => onChange({ status }),
    },
  ];

  return (
    <Card className="spec-filters" aria-label="Catalog filters" data-testid="spec-catalog-filters">
      <div className="spec-filters__row">
        <div className="input-wrap spec-filters__search">
          <Search aria-hidden />
          <Input
            type="search"
            value={searchDraft}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search path, format, repository or project…"
            aria-label="Search discovered specs"
            data-testid="spec-catalog-search"
          />
        </div>

        {facetConfigs.map((facet) => (
          <FacetSelect key={facet.id} facet={facet} />
        ))}

        <Select value={filters.sort} onValueChange={(sort) => onChange({ sort })}>
          <SelectTrigger
            className="spec-filters__facet spec-filters__facet--sort"
            aria-label="Sort by"
            data-testid="spec-catalog-sort"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEC_CATALOG_SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                Sort: {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="spec-filters__row spec-filters__row--flags">
        <label className="spec-filters__flag">
          <Checkbox
            checked={filters.importableOnly}
            onCheckedChange={(checked) => onChange({ importableOnly: checked === true })}
            data-testid="spec-catalog-importable-only"
          />
          Only importable spec types
        </label>
        <label className="spec-filters__flag">
          <Checkbox
            checked={filters.allBranches}
            onCheckedChange={(checked) => onChange({ allBranches: checked === true })}
            data-testid="spec-catalog-all-branches"
          />
          Include non-default branches
        </label>

        {active ? (
          <Button
            variant="ghost"
            size="sm"
            className="spec-filters__clear"
            onClick={onClear}
            data-testid="spec-catalog-clear-filters"
          >
            <X aria-hidden />
            Clear filters
          </Button>
        ) : null}

        <p className="spec-filters__note">{SPEC_CATALOG_URL_NOTE}</p>
      </div>
    </Card>
  );
}

export default SpecCatalogFilterPanel;
