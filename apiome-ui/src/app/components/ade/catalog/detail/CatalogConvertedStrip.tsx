'use client';

/**
 * The Catalog item detail's **converted strip** (HIVE-7.2, #5319).
 *
 * Authority: `docs/mockups/sources/catalog-item.html` §Converted strip — the ok-tinted banner
 * that sits above the panes, beside Related artifacts, once an item has been converted:
 * "Re-converted to OpenAPI project · `ver_5c0d21`: Claims 837P (OpenAPI) ↗ — 2 conversions on
 * record", with "View conversion history" pinned to its trailing edge.
 *
 * Two things it does that the pre-Hive strip did not. It is an `Alert`, so its tint, its glyph
 * and its action slot are the ones every other banner in the product uses rather than a
 * hand-written `border-emerald-200 bg-emerald-50/60 dark:border-emerald-800
 * dark:bg-emerald-950/30`. And a **deleted target project** is struck through with the
 * mockup's verbatim hint rather than silently rendering a dead link — the acceptance
 * criterion that says deleted-source states keep their struck-through, read-only treatment.
 *
 * @see `./catalogItemView.ts` — `catalogConvertedStrip`, which decides every part of it.
 */

import * as React from 'react';
import Link from 'next/link';
import { GitMerge } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import type { CatalogConversion } from '@/app/utils/catalog-conversion';

import { catalogConvertedStrip } from './catalogItemView';

export interface CatalogConvertedStripProps {
  /** The item's recorded conversion back-link; `null`/absent draws nothing at all. */
  conversion: CatalogConversion | null | undefined;
  /** How many conversions the history holds, once it has loaded. */
  conversionCount?: number;
  /** Open the Conversions pane. */
  onOpenHistory: () => void;
}

/**
 * Render the converted strip. See {@link CatalogConvertedStripProps}.
 *
 * @returns The banner, or `null` when the item has never been converted.
 */
export function CatalogConvertedStrip({
  conversion,
  conversionCount = 0,
  onOpenHistory,
}: CatalogConvertedStripProps) {
  const view = catalogConvertedStrip(conversion, conversionCount);
  if (!view) return null;

  return (
    <Alert
      variant="ok"
      icon={<GitMerge aria-hidden className="mt-px size-4 shrink-0" />}
      data-testid="catalog-detail-converted"
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenHistory}
          data-testid="catalog-detail-converted-history-link"
        >
          View conversion history
        </Button>
      }
    >
      <span className="cid-converted__title">{view.title}</span>{' '}
      <span className="cid-converted__body">
        {view.versionId ? (
          <>
            · <span className="mono">{view.versionId}</span>:{' '}
          </>
        ) : (
          <>: </>
        )}
        {view.projectHref ? (
          <Link href={view.projectHref} className="cid-converted__link">
            {view.projectLabel}
          </Link>
        ) : (
          <span className="cid-converted__deleted" title={view.deletedHint ?? undefined}>
            {view.projectLabel}
          </span>
        )}
        {view.deletedHint ? (
          <span className="cid-quiet"> — “{view.deletedHint}”.</span>
        ) : null}
        {view.countLine ? <span className="cid-quiet"> — {view.countLine}.</span> : null}
      </span>
    </Alert>
  );
}
