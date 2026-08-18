'use client';

/**
 * The timeline filter bar (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Timeline filter bar — a caps *Timeline*
 * label, the search box (*Message, changelog, commit…*), the author select, From / To dates
 * and Reset, on one wrapping row inside a card.
 *
 * These are the client-side history filters (#2579): they narrow the loaded list and match
 * the REST list's `q` / creator / date-range semantics. Nothing here fetches — the values are
 * the screen's, and `revisionMatchesHistoryFilters` in the page applies them.
 */

import * as React from 'react';
import { RotateCcw, Search } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { Input } from '@/app/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';

/** Radix `Select` cannot use the empty string as a value; this stands in for "all authors". */
const ALL_AUTHORS = '__all__';

/** One author the filter offers. */
export interface VersionAuthorOption {
  /** The creator id the filter matches on. */
  id: string;
  /** The label — name, else email, else the id. */
  label: string;
}

export interface VersionsTimelineFiltersProps {
  /** The search text. */
  query: string;
  onQueryChange: (next: string) => void;
  /** The selected creator id, `''` for all. */
  authorId: string;
  onAuthorChange: (next: string) => void;
  /** The authors present in the loaded list. */
  authorOptions: readonly VersionAuthorOption[];
  /** `YYYY-MM-DD`, or `''`. */
  dateFrom: string;
  onDateFromChange: (next: string) => void;
  /** `YYYY-MM-DD`, or `''`. */
  dateTo: string;
  onDateToChange: (next: string) => void;
  /** Whether any of the four is set. */
  active: boolean;
  /** Clear all four. */
  onReset: () => void;
}

/**
 * Render the filter bar. See {@link VersionsTimelineFiltersProps}.
 *
 * @returns The card.
 */
export default function VersionsTimelineFilters({
  query,
  onQueryChange,
  authorId,
  onAuthorChange,
  authorOptions,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  active,
  onReset,
}: VersionsTimelineFiltersProps) {
  return (
    <Card className="ver-filters" data-testid="versions-timeline-filters">
      <div className="ver-filters__row">
        <span className="ver-filters__label" id="versions-timeline-filters-label">
          Timeline
        </span>
        <span className="input-wrap ver-filters__search">
          <Search aria-hidden />
          <Input
            id="history-timeline-search"
            type="search"
            placeholder="Message, changelog, commit…"
            aria-label="Search revisions"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            autoComplete="off"
          />
        </span>
        <Select
          value={authorId || ALL_AUTHORS}
          onValueChange={(value) => onAuthorChange(value === ALL_AUTHORS ? '' : value)}
        >
          <SelectTrigger className="ver-filters__author" aria-label="Author">
            <SelectValue placeholder="All authors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AUTHORS}>All authors</SelectItem>
            {authorOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="ver-filters__date">
          From
          <Input
            id="history-date-from"
            type="date"
            aria-label="From date"
            value={dateFrom}
            onChange={(event) => onDateFromChange(event.target.value)}
          />
        </label>
        <label className="ver-filters__date">
          To
          <Input
            id="history-date-to"
            type="date"
            aria-label="To date"
            value={dateTo}
            onChange={(event) => onDateToChange(event.target.value)}
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!active}
          onClick={onReset}
          data-testid="versions-timeline-reset"
        >
          <RotateCcw aria-hidden />
          Reset
        </Button>
      </div>
    </Card>
  );
}
