'use client';

/**
 * Format facet dropdown for the Catalog toolbar (MFI-28.4, #4120).
 *
 * Format is the Catalog's defining facet, yet the list had no way to filter by it. This is a
 * compact multi-select dropdown: it lists exactly the formats present in the current catalog (fed
 * by the page, which resolves each item's `sourceFormat` through the format registry), lets the
 * user tick any combination, and reports the selection back up. An empty selection means "all
 * formats" — the neutral, unfiltered state.
 *
 * The component is presentational and fully controlled: it owns only its open/closed state. The
 * selected set and the available options live in the page so the facet composes with search, the
 * view filter chips, grouping and sort.
 */

import { useEffect, useRef, useState } from 'react';
import { Filter, Check, X } from 'lucide-react';
import { cn } from '@lib/utils';

/** One selectable format: a registry id and its human label (e.g. `grpc` → "gRPC"). */
export interface CatalogFormatOption {
  id: string;
  label: string;
}

export interface CatalogFormatFacetProps {
  /** The formats present in the current catalog, already de-duplicated and sorted by the page. */
  options: readonly CatalogFormatOption[];
  /** The currently selected format ids. Empty means "all formats" (no filtering). */
  selected: readonly string[];
  /** Report the next selection (the full next set of ids) to the page. */
  onChange: (next: string[]) => void;
}

/**
 * A dropdown that filters the catalog by one or more formats.
 *
 * @param options   The formats available to pick from (only those present in the list).
 * @param selected  The ids currently selected; an empty array is the unfiltered "all" state.
 * @param onChange  Called with the next selected-id array whenever the user toggles/clears.
 */
export function CatalogFormatFacet({ options, selected, onChange }: CatalogFormatFacetProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape so the facet behaves like a normal menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const selectedSet = new Set(selected);
  const activeCount = selectedSet.size;
  const hasOptions = options.length > 0;

  const toggle = (id: string) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        data-testid="catalog-format-facet"
        disabled={!hasOptions}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => hasOptions && setOpen((o) => !o)}
        title={hasOptions ? 'Filter by format' : 'No formats to filter yet'}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
          activeCount > 0
            ? 'border-indigo-300 bg-indigo-500/10 text-indigo-600 dark:border-indigo-600 dark:text-indigo-400'
            : 'border-gray-200 text-gray-600 hover:border-indigo-300 dark:border-gray-700 dark:text-gray-300 dark:hover:border-indigo-600',
          !hasOptions && 'cursor-not-allowed opacity-40 hover:border-gray-200 dark:hover:border-gray-700',
        )}
      >
        <Filter className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Format
        {activeCount > 0 ? (
          <span className="ml-0.5 rounded-full bg-indigo-500 px-1.5 text-2xs font-semibold leading-4 text-white">
            {activeCount}
          </span>
        ) : null}
      </button>

      {open && hasOptions ? (
        <div
          role="listbox"
          aria-label="Filter catalog by format"
          data-testid="catalog-format-facet-menu"
          className="absolute right-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Formats
            </span>
            {activeCount > 0 ? (
              <button
                type="button"
                data-testid="catalog-format-clear"
                onClick={() => onChange([])}
                className="inline-flex items-center gap-1 text-2xs font-medium text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400"
              >
                <X className="h-3 w-3" aria-hidden />
                Clear
              </button>
            ) : null}
          </div>
          {options.map((opt) => {
            const checked = selectedSet.has(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={checked}
                data-testid={`catalog-format-option-${opt.id}`}
                onClick={() => toggle(opt.id)}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <span
                  className={cn(
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    checked
                      ? 'border-indigo-500 bg-indigo-500 text-white'
                      : 'border-gray-300 dark:border-gray-600',
                  )}
                  aria-hidden
                >
                  {checked ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default CatalogFormatFacet;
