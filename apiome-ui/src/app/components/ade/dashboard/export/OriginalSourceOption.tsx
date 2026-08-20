'use client';

import { FileDown } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';

export interface OriginalSourceOptionProps {
  /** The catalog item id whose stored source is served at `/api/catalog/{artifact}/source`. */
  artifact: string;
  /** The source's original import format (e.g. `graphql`), shown in the copy. */
  sourceFormat: string;
  className?: string;
}

/** The download URL for a catalog item's stored original source material (MFI-23.9). */
export function originalSourceHref(artifact: string): string {
  return `/api/catalog/${encodeURIComponent(artifact)}/source`;
}

/**
 * OriginalSourceOption — the "Original source" export choice (MFX-41.1, #4348).
 *
 * A source imported in one format has no reason to be *converted back* to that same format:
 * re-emitting a GraphQL source to GraphQL is a lossy round-trip when the original bytes are
 * already stored. So the export drops the same-format target (see `filterSameFormatTargets`) and
 * offers this instead — a one-click, lossless download of the item's captured source material,
 * straight from the catalog source endpoint. Shown by both the ExportDialog and the Export Studio
 * whenever the source's original format is known (catalog sources).
 */
export function OriginalSourceOption({ artifact, sourceFormat, className }: OriginalSourceOptionProps) {
  return (
    <div
      data-testid="export-original-source"
      className={cn(
        'xstd-original',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <FileDown aria-hidden />
        <div>
          <div className="xstd-original__title">
            Original source
            <span className="xstd-rule-chip">
              {sourceFormat}
            </span>
          </div>
          <p className="xstd-original__why">
            This item was imported as {sourceFormat}. Download it unchanged — lossless, no
            conversion. (Re-exporting to {sourceFormat} is offered as the original, not a round-trip.)
          </p>
        </div>
      </div>
      <Button asChild variant="outline" className="shrink-0">
        {/* A plain anchor: the endpoint streams the file (or redirects a URL-sourced item), so the
            browser's own download/navigation handles both — opened in a new tab to keep the export
            open. */}
        <a
          href={originalSourceHref(artifact)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="export-original-source-download"
        >
          <FileDown className="h-4 w-4" aria-hidden />
          Download original
        </a>
      </Button>
    </div>
  );
}

export default OriginalSourceOption;
