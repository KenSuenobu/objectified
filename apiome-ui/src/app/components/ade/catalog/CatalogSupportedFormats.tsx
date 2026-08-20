'use client';

/**
 * The supported-import-formats gallery (MFI-23.12; re-skinned HIVE-7.1, #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html` §Supported import formats — a collapsed card
 * whose header states the two counts and previews a few format pills, and whose body splits
 * the registry into **Importable now** and **Recognized — not yet importable**, with an
 * adapter whose toolchain is missing in this runtime dimmed and labelled.
 *
 * The data is the **server** registry (FMT-1.2, #5413): the two sections are partitioned by which
 * adapters `GET /api/import/sources` actually reports, so registering an adapter moves its format to
 * "Importable now" with no edit here and retiring one moves it back. The local format registry keeps
 * only what it is good at — the icon, the fixed identity hue and the one-line description. An
 * importable format whose adapter cannot run (gRPC without `buf`, say) is dimmed rather than
 * dropped: a reader who cannot import Protobuf today should be told why, not left to conclude the
 * product has never heard of it.
 *
 * ### What the re-skin changed
 *
 * The chips were `border-gray-100 bg-gray-50/60 … hover:bg-indigo-50/40` with a second
 * `dark:` spelling of each; the header tile was `bg-indigo-500/10 text-indigo-600`. All of it
 * is tokens now. The **hue on a format's tile is deliberately not** — `catalogFormatHueClass`
 * is the fixed identity block (HIVE-2.4), the same hue the pill in the table below carries,
 * which is the point of showing the gallery at all: it teaches the colour the list then uses.
 *
 * The header is one `<button>` again rather than a button wrapping a heading and a chevron,
 * and `aria-expanded`/`aria-controls` name the region it opens.
 */

import * as React from 'react';
import { ChevronDown, Layers } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card } from '@/app/components/ui/Card';
import { catalogFormatHueClass, type CatalogFormat } from '@/app/utils/catalog-format-registry';
import { partitionCatalogFormats } from '@/app/utils/catalog-format-support';
import { catalogAdapterForFormat } from '@/app/utils/catalog-import-formats';
import { catalogFormatDocumentationUrl } from '@/app/utils/catalog-format-documentation';
import { cn } from '@lib/utils';

import { useCatalogImportAvailability } from '../dashboard/catalog/useCatalogImportAvailability';

/** How many format names the collapsed header previews before eliding the rest. */
const PREVIEW_LIMIT = 5;

/** The sentence an importable format gets when its adapter cannot run in this deployment. */
export const CATALOG_FORMAT_UNAVAILABLE_NOTE = 'Unavailable in this runtime';

export interface CatalogSupportedFormatsProps {
  /** Whether the gallery starts expanded. Defaults to collapsed to keep the list uncluttered. */
  defaultOpen?: boolean;
  className?: string;
}

/** Props for {@link FormatChip}. */
interface FormatChipProps {
  /** The registry entry. */
  fmt: CatalogFormat;
  /** Dim it — a format the registry recognises but cannot import yet. */
  muted?: boolean;
  /** Why an importable format is nonetheless unavailable here. */
  unavailableNote?: string;
  /** When set, the chip opens this URL in a new tab (importable formats only). */
  documentationUrl?: string;
}

/**
 * One format in the gallery: its tinted tile, its name, and one line about it.
 *
 * A chip with documentation is an `<a target="_blank">` and says so in its accessible name,
 * because a link that leaves the app without warning is the one thing DESIGN.md §9 asks a
 * link to announce. A chip without is a plain `<div>` — not a disabled link.
 *
 * @param props See {@link FormatChipProps}.
 * @returns The chip.
 */
function FormatChip({ fmt, muted, unavailableNote, documentationUrl }: FormatChipProps) {
  const Icon = fmt.icon;
  const unavailable = Boolean(unavailableNote);
  const dimmed = muted || unavailable;
  const className = cn(
    'cat-fmt-chip',
    dimmed && 'cat-fmt-chip--dim',
    unavailable && 'cat-fmt-chip--unavailable'
  );

  const body = (
    <>
      <span className={cn('cat-fmt-chip__tile', catalogFormatHueClass(fmt.tone))} aria-hidden>
        <Icon />
      </span>
      <span className="cat-fmt-chip__text">
        <span className="cat-fmt-chip__name">{fmt.label}</span>
        {unavailableNote ? (
          <span className="cat-fmt-chip__note">{unavailableNote}</span>
        ) : fmt.description ? (
          <span className="cat-fmt-chip__desc">{fmt.description}</span>
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
        className={className}
        aria-label={`${fmt.label} technical documentation (opens in new tab)`}
      >
        {body}
      </a>
    );
  }

  return <div className={className}>{body}</div>;
}

/**
 * Render the gallery. See {@link CatalogSupportedFormatsProps}.
 *
 * @returns The collapsible card.
 */
export function CatalogSupportedFormats({
  defaultOpen = false,
  className,
}: CatalogSupportedFormatsProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  // Availability is fetched eagerly rather than on expand, so the always-visible header count
  // is honest before anyone opens the panel.
  const availability = useCatalogImportAvailability(true);
  // Membership comes from the registry response; the local `importable` flag is only the fallback
  // used before it resolves (or if it is unreachable), so the gallery is never blank.
  const { importable: registryImportable, recognized } = React.useMemo(
    () => partitionCatalogFormats(availability.registeredKeys),
    [availability.registeredKeys]
  );
  const recognizedCount = recognized.length;

  /** The runtime-unavailable note for an importable format, or `undefined` when it can run. */
  const unavailableNoteFor = React.useCallback(
    (fmt: CatalogFormat): string | undefined => {
      const adapter = catalogAdapterForFormat(fmt.id);
      if (!adapter || availability.isAvailable(adapter.sourceKind)) return undefined;
      return CATALOG_FORMAT_UNAVAILABLE_NOTE;
    },
    [availability]
  );

  // The header count states what can be imported *here* — an adapter whose toolchain is missing is
  // still listed below (dimmed, with the reason) but must not be counted as available.
  const importable = React.useMemo(
    () => registryImportable.filter((fmt) => !unavailableNoteFor(fmt)),
    [registryImportable, unavailableNoteFor]
  );
  const preview = importable.slice(0, PREVIEW_LIMIT);
  const overflow = importable.length - preview.length;

  return (
    <Card className={cn('cat-formats', className)} data-testid="catalog-supported-formats">
      <button
        type="button"
        className="cat-formats__head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="catalog-supported-formats-panel"
        data-testid="catalog-supported-formats-toggle"
      >
        <span className="cat-formats__tile" aria-hidden>
          <Layers />
        </span>
        <span className="cat-formats__heading">
          <span className="cat-formats__title">Supported import formats</span>
          <span className="cat-formats__counts">
            {importable.length} alternative formats importable now
            {recognizedCount > 0 ? ` · ${recognizedCount} more recognized` : ''}
          </span>
        </span>
        <span className="cat-formats__preview" aria-hidden>
          {preview.map((fmt) => (
            <span key={fmt.id} className={cn('fmt', catalogFormatHueClass(fmt.tone))}>
              {fmt.label}
            </span>
          ))}
          {overflow > 0 ? <span className="fmt cat-formats__more">+{overflow}</span> : null}
        </span>
        <ChevronDown className="cat-formats__chevron" aria-hidden />
      </button>

      {open ? (
        <div id="catalog-supported-formats-panel" className="cat-formats__panel">
          <div>
            <div className="cat-formats__legend">
              <Badge status="ok">Importable now</Badge>
              <span className="cat-quiet">Stored as-is; convert to OpenAPI later</span>
            </div>
            <div className="cat-formats__grid">
              {registryImportable.map((fmt) => (
                <FormatChip
                  key={fmt.id}
                  fmt={fmt}
                  unavailableNote={unavailableNoteFor(fmt)}
                  documentationUrl={catalogFormatDocumentationUrl(fmt.id)}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="cat-formats__legend">
              <Badge variant="outline">Recognized — not yet importable</Badge>
              <span className="cat-quiet">
                Detected and labelled; import support is on the roadmap
              </span>
            </div>
            {recognizedCount > 0 ? (
              <div className="cat-formats__grid">
                {recognized.map((fmt) => (
                  <FormatChip key={fmt.id} fmt={fmt} muted />
                ))}
              </div>
            ) : (
              /* The mockup states the happy case rather than hiding the section: "every
                 recognized format is importable in this build" is the answer to the question
                 the heading above just raised. */
              <p className="cat-formats__none" data-testid="catalog-formats-none-pending">
                Every recognized format is importable in this build — nothing is waiting on the
                roadmap.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default CatalogSupportedFormats;
