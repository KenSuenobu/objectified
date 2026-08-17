'use client';

import * as React from 'react';
import { ArrowUpRight, Search } from 'lucide-react';

import { Input } from '@/app/components/ui/Input';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import {
  GUIDE_QUERY_MIN_LENGTH,
  GUIDE_SECTION_LABELS,
  guideHref,
  searchGuides,
  type GuideEntry,
} from './helpCatalog';

/**
 * Search over the written guide set (HIVE-4.9, #5303).
 *
 * Authority: `docs/mockups/foundations/help.html` — one wide field, above the cards, whose
 * placeholder names three example searches rather than describing itself.
 *
 * ### Why this is a filtered list and not a combobox
 *
 * A combobox is for choosing a *value* for a field. This chooses a *destination*: the rows
 * are links that leave for GitHub, the field keeps whatever was typed, and there is nothing
 * to commit. Spelling it as a combobox would promise `aria-activedescendant` behaviour that
 * a list of links does not have, so it is what it looks like — a text field and a list that
 * narrows underneath it, with the count announced politely as it changes.
 *
 * ### Where a result goes
 *
 * The guides are markdown in the repository, so every row leaves the app for GitHub and says
 * so with the ↗ glyph the launcher's external rows use. That is the honest affordance until
 * the guide set is served from a route of its own, and it is the reason the rows are `<a>`
 * with `target="_blank"` rather than `next/link`.
 */

/** The field's accessible name, which its placeholder is too illustrative to serve as. */
const SEARCH_LABEL = 'Search the guide';

/** The placeholder, verbatim from the mockup. */
const SEARCH_PLACEHOLDER = 'Search the guide… e.g. publish a version, import RAML, MCP trust posture';

/**
 * What the live region says about a result set.
 *
 * @param query The current query.
 * @param count How many guides matched.
 * @returns A sentence, or `null` while the query is too short to have searched.
 */
function resultSummary(query: string, count: number): string | null {
  if (query.trim().length < GUIDE_QUERY_MIN_LENGTH) return null;
  if (count === 0) return `No guides match “${query.trim()}”.`;
  return `${count} ${count === 1 ? 'guide matches' : 'guides match'} “${query.trim()}”.`;
}

/**
 * One result row.
 *
 * @param props.entry The guide to link to.
 * @returns An external link with the guide's title, section and summary.
 */
function GuideResult({ entry }: { entry: GuideEntry }) {
  return (
    <li>
      <a
        href={guideHref(entry)}
        target="_blank"
        rel="noopener noreferrer"
        className="help-result"
        data-testid={`help-guide-${entry.id}`}
      >
        <span className="help-result__body">
          <span className="help-result__title">
            {entry.title}
            <ArrowUpRight
              size={ICON_SIZE.dense}
              strokeWidth={ICON_STROKE_WIDTH}
              aria-hidden
              className="help-result__out"
            />
          </span>
          <span className="help-result__sub">{entry.summary}</span>
        </span>
        <span className="help-result__section">{GUIDE_SECTION_LABELS[entry.section]}</span>
      </a>
    </li>
  );
}

/**
 * The guide search.
 *
 * @returns The field, and the results underneath it once there is a query to search with.
 */
export default function HelpGuideSearch() {
  const [query, setQuery] = React.useState('');
  const inputId = React.useId();

  // Re-run only when the query changes: the catalog is a module constant, so the same query
  // always produces the same list and there is nothing else to depend on.
  const results = React.useMemo(() => searchGuides(query), [query]);
  const summary = resultSummary(query, results.length);

  return (
    <section className="help-search" aria-labelledby={`${inputId}-label`}>
      <label id={`${inputId}-label`} htmlFor={inputId} className="sr-only">
        {SEARCH_LABEL}
      </label>

      <div className="help-search__field">
        <Search
          size={ICON_SIZE.dense}
          strokeWidth={ICON_STROKE_WIDTH}
          aria-hidden
          className="help-search__icon"
        />
        <Input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={SEARCH_PLACEHOLDER}
          data-testid="help-guide-search"
          className="help-search__input"
        />
      </div>

      {/* Always in the DOM, empty or not: a live region that is inserted *with* its text is
          not announced, so the element has to be there before the count changes. Polite
          rather than assertive, because the reader is still typing. */}
      <p role="status" aria-live="polite" className="help-search__status">
        {summary}
      </p>

      {results.length > 0 && (
        <ul className="help-results" data-testid="help-guide-results">
          {results.map((entry) => (
            <GuideResult key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}
