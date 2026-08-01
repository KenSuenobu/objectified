'use client';

import type {
  BrowseFacetAxis,
  BrowseFacetOption,
  BrowseFacetSelection,
} from '../../../lib/browseFacets';
import { formatLabel, hasFacetSelection, protocolLabel } from '../../../lib/browseFacets';

/**
 * The read-only protocol/format chips for one directory row (MFI-6.1).
 *
 * Purely descriptive — unlike {@link FacetFilter}'s chips these are not clickable; they say what an
 * organization or project is, so a listing stays readable once a facet has narrowed it.
 *
 * @param protocols The row's distinct protocols.
 * @param formats The row's distinct source formats.
 */
export function FacetValueChips({
  protocols,
  formats,
}: {
  protocols?: string[] | null;
  formats?: string[] | null;
}) {
  const chips = [
    ...(protocols ?? []).map(protocolLabel),
    ...(formats ?? []).map(formatLabel),
  ].filter(Boolean);

  if (chips.length === 0) {
    return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
  }

  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {chip}
        </span>
      ))}
    </span>
  );
}

interface FacetGroupProps {
  /** Group heading ("Protocol" / "Format"). */
  title: string;
  /** The axis this group toggles. */
  axis: BrowseFacetAxis;
  /** The chips to render, already ordered and counted. */
  options: BrowseFacetOption[];
  /** The currently selected value on this axis, or null. */
  selected: string | null;
  /** Called with the clicked value; the caller decides whether that selects or clears. */
  onToggle: (axis: BrowseFacetAxis, value: string) => void;
}

/**
 * One row of facet chips — a single-select group where clicking the active chip clears it.
 *
 * Rendered as a `radiogroup` because exactly one value can be active per axis; the "any" state is
 * simply no chip pressed, which the group's own clear affordance (in {@link FacetFilter}) resets.
 */
function FacetGroup({ title, axis, options, selected, onToggle }: FacetGroupProps) {
  if (options.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        {title}
      </span>
      <div role="radiogroup" aria-label={title} className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => {
          const active = selected === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onToggle(axis, option.value)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                active
                  ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-soft-text)]'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100'
              }`}
            >
              {option.label}
              <span
                className={`tabular-nums ${
                  active ? 'opacity-80' : 'text-zinc-400 dark:text-zinc-500'
                }`}
              >
                {option.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface FacetFilterProps {
  /** Protocol chips, in canonical paradigm order. */
  protocolOptions: BrowseFacetOption[];
  /** Format chips, most common first. */
  formatOptions: BrowseFacetOption[];
  /** The current selection. */
  selection: BrowseFacetSelection;
  /** Called with the clicked axis/value. */
  onToggle: (axis: BrowseFacetAxis, value: string) => void;
  /** Called when the visitor clears every axis. */
  onClear: () => void;
  /** What the facets narrow, for the group's accessible name (e.g. "projects"). */
  entityLabel: string;
}

/**
 * The protocol + format facet bar for a browse listing (MFI-6.1).
 *
 * Renders nothing at all when neither axis has a value — a directory of only-OpenAPI specs, or one
 * whose revisions predate the format/protocol columns, should not grow an empty filter bar.
 */
export function FacetFilter({
  protocolOptions,
  formatOptions,
  selection,
  onToggle,
  onClear,
  entityLabel,
}: FacetFilterProps) {
  if (protocolOptions.length === 0 && formatOptions.length === 0) return null;

  return (
    <div
      aria-label={`Filter ${entityLabel} by protocol and format`}
      className="flex flex-col gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <FacetGroup
        title="Protocol"
        axis="protocol"
        options={protocolOptions}
        selected={selection.protocol}
        onToggle={onToggle}
      />
      <FacetGroup
        title="Format"
        axis="format"
        options={formatOptions}
        selected={selection.format}
        onToggle={onToggle}
      />
      {hasFacetSelection(selection) && (
        <div>
          <button
            type="button"
            onClick={onClear}
            className="text-[12px] font-medium text-[var(--brand)] transition-colors hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
