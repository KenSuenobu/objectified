'use client';

/**
 * `<CatalogSupportedFormats>` (MFI-23.12) — the catalog's supported-formats gallery.
 *
 * Renders the *alternative* import formats (every registered format except native OpenAPI/Swagger,
 * which belong to Projects) as a data-driven grid of chips, straight from
 * {@link ALTERNATIVE_CATALOG_FORMATS}. This is the "which formats can I bring into the catalog?"
 * reference that used to be implicit in the Projects importer; it now lives on the Catalog surface.
 *
 * A collapsible panel so it stays out of the way of the item list, with an optional `onImport`
 * callback that surfaces an inline "Import" button (the catalog page wires it to the ImportDialog).
 */

import * as React from 'react';
import { ChevronDown, Layers, Upload } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '@/app/components/ui/Button';
import {
  IMPORTABLE_ALTERNATIVE_FORMATS,
  RECOGNIZED_ALTERNATIVE_FORMATS,
  catalogFormatHueClass,
  type CatalogFormat,
} from '@/app/utils/catalog-format-registry';
import { catalogAdapterForFormat } from '@/app/utils/catalog-import-formats';
import { catalogFormatDocumentationUrl } from '@/app/utils/catalog-format-documentation';
import { useCatalogImportAvailability } from './useCatalogImportAvailability';

export interface CatalogSupportedFormatsProps {
  /** When provided, an "Import" button is shown in the panel header. */
  onImport?: () => void;
  /** Whether the gallery starts expanded. Defaults to collapsed to keep the list uncluttered. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * One format chip. `muted` dims the recognized-but-not-yet-importable entries; `unavailableNote`
 * flags an importable format whose toolchain is missing in this runtime (e.g. gRPC without `buf`).
 */
function FormatChip({
  fmt,
  muted,
  unavailableNote,
  documentationUrl,
}: {
  fmt: CatalogFormat;
  muted?: boolean;
  unavailableNote?: string;
  /** When set, the chip opens this URL in a new tab (importable formats only). */
  documentationUrl?: string;
}) {
  const Icon = fmt.icon;
  const dimmed = muted || Boolean(unavailableNote);
  const chipClassName = cn(
    'flex items-start gap-2.5 rounded-md border p-2.5',
    dimmed
      ? 'border-dashed border-gray-200 bg-gray-50/40 dark:border-gray-700/60 dark:bg-gray-900/20'
      : 'border-gray-100 bg-gray-50/60 dark:border-gray-700/60 dark:bg-gray-900/30',
    documentationUrl &&
      'cursor-pointer transition-colors hover:border-indigo-200 hover:bg-indigo-50/40 dark:hover:border-indigo-700/60 dark:hover:bg-indigo-950/20',
  );
  const body = (
    <>
      <span
        className={cn(
          // The same fixed hue the format's pill carries (HIVE-2.4, #5283), so the gallery
          // teaches the colour the catalog table then uses.
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          catalogFormatHueClass(fmt.tone),
          dimmed && 'opacity-60',
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate text-xs font-semibold',
            dimmed ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100',
          )}
        >
          {fmt.label}
        </span>
        {unavailableNote ? (
          <span className="block text-2xs font-medium leading-snug text-amber-600 dark:text-amber-400">
            {unavailableNote}
          </span>
        ) : fmt.description ? (
          <span className="block text-2xs leading-snug text-gray-500 dark:text-gray-400">
            {fmt.description}
          </span>
        ) : null}
      </span>
    </>
  );

  if (documentationUrl) {
    return (
      <a
        href={documentationUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={chipClassName}
        aria-label={`${fmt.label} technical documentation (opens in new tab)`}
      >
        {body}
      </a>
    );
  }

  return <div className={chipClassName}>{body}</div>;
}

const GRID_CLASS =
  'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';

/**
 * The supported-formats gallery. Presentational and honest — it splits the alternative formats into
 * those that can be **imported today** (converted to OpenAPI on the way in) and those the registry
 * only **recognizes** but cannot import yet. Both lists are the single registry source of truth, so
 * flipping a format's `importable` flag moves it between the two sections with no change here.
 */
export function CatalogSupportedFormats({
  onImport,
  defaultOpen = false,
  className,
}: CatalogSupportedFormatsProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  // Fetch availability eagerly (not just when expanded) so the always-visible header count is honest.
  const availability = useCatalogImportAvailability(true);
  const recognizedCount = RECOGNIZED_ALTERNATIVE_FORMATS.length;

  /** The runtime-unavailable note for an importable format (its adapter's toolchain is missing). */
  const unavailableNoteFor = (fmt: CatalogFormat): string | undefined => {
    const adapter = catalogAdapterForFormat(fmt.id);
    if (!adapter || availability.isAvailable(adapter.sourceKind)) return undefined;
    return 'Unavailable in this runtime';
  };

  // Once availability has loaded, "importable now" counts only formats whose toolchain can run here.
  const availableImportableCount = IMPORTABLE_ALTERNATIVE_FORMATS.filter(
    (f) => !unavailableNoteFor(f),
  ).length;

  return (
    <section
      className={cn(
        'rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
        className,
      )}
      aria-label="Supported import formats"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          aria-controls="catalog-supported-formats-grid"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <Layers className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">
              Supported import formats
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {availableImportableCount} alternative formats importable now
              {recognizedCount > 0 ? ` · ${recognizedCount} more recognized` : null}
            </span>
          </span>
          <ChevronDown
            className={cn(
              'ml-1 h-4 w-4 shrink-0 text-gray-400 transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
        {onImport ? (
          <Button size="sm" onClick={onImport} className="shrink-0">
            <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Import
          </Button>
        ) : null}
      </div>

      {open ? (
        <div
          id="catalog-supported-formats-grid"
          className="border-t border-gray-100 px-4 py-4 dark:border-gray-700/60"
        >
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-2xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                Importable now
              </span>
              <span className="text-2xs text-gray-500 dark:text-gray-400">
                Stored as-is; convert to OpenAPI later
              </span>
            </div>
            <div className={GRID_CLASS}>
              {IMPORTABLE_ALTERNATIVE_FORMATS.map((fmt) => (
                <FormatChip
                  key={fmt.id}
                  fmt={fmt}
                  unavailableNote={unavailableNoteFor(fmt)}
                  documentationUrl={catalogFormatDocumentationUrl(fmt.id)}
                />
              ))}
            </div>
          </div>

          {recognizedCount > 0 ? (
            <div className="border-t border-gray-100 pt-6 dark:border-gray-700/60">
              <div className="mb-2 flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-semibold text-gray-600 dark:bg-gray-700/60 dark:text-gray-300">
                  Recognized — not yet importable
                </span>
                <span className="text-2xs text-gray-500 dark:text-gray-400">
                  Detected and labelled; import support is on the roadmap
                </span>
              </div>
              <div className={GRID_CLASS}>
                {RECOGNIZED_ALTERNATIVE_FORMATS.map((fmt) => (
                  <FormatChip key={fmt.id} fmt={fmt} muted />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default CatalogSupportedFormats;
