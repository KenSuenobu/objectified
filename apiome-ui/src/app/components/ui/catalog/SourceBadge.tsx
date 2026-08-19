'use client';

/**
 * `<SourceBadge>` (MFI-23.5, #4014) — the source-material badge for a catalog item.
 *
 * Shows where the item was imported from — an uploaded **file name**, a **source URL**, pasted
 * content, or a **live-discovery** endpoint — with an icon for the input kind. The badge can be
 * driven two ways:
 *  - pass a resolved {@link CatalogSource} via `source` (e.g. from `resolveCatalogSource`), or
 *  - pass an explicit `kind` (+ optional `label`) directly.
 *
 * It renders `null` when there is nothing to show. Used on the Catalog card (MFI-23.4) and the
 * detail view (MFI-23.9).
 */

import * as React from 'react';
import { cn } from '../../../../../lib/utils';
import {
  CATALOG_SOURCE_KIND_META,
  type CatalogSource,
  type CatalogSourceKind,
} from '../../../utils/catalog-format-registry';

export interface SourceBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** A pre-resolved source descriptor (wins over `kind`/`label` when provided). */
  source?: CatalogSource | null;
  /** The input kind, when not passing a resolved `source`. */
  kind?: CatalogSourceKind | null;
  /** The label to show; falls back to the kind's default label when omitted. */
  label?: string | null;
}

/**
 * The badge's chrome.
 *
 * Where a format's colour is an identity (`.fmt--*`, HIVE-2.4) and a status's is a state,
 * *where a file came from* is neither — so this is the neutral inset surface, in tokens, and
 * it follows all nine themes. HIVE-7.1 replaced the `bg-gray-100 … dark:bg-gray-700/60` pair
 * this carried, which was the last palette literal left in the catalog pill set.
 */
const BADGE_BASE =
  'inline-flex max-w-[14rem] items-center gap-1 rounded-md bg-inset px-2 py-0.5 text-xs font-medium text-fg-muted';

/**
 * Render the source-material badge, or `null` when neither a resolved `source` nor a `kind` is
 * supplied. The label is truncated; the full source value is exposed as the title tooltip.
 */
export const SourceBadge = React.forwardRef<HTMLSpanElement, SourceBadgeProps>(
  ({ source, kind, label, className, ...props }, ref) => {
    const resolvedKind: CatalogSourceKind | undefined = source?.kind ?? kind ?? undefined;
    if (!resolvedKind) return null;

    const meta = CATALOG_SOURCE_KIND_META[resolvedKind];
    const Icon = meta.icon;
    const text = source?.label ?? (label && label.trim() ? label.trim() : meta.fallbackLabel);
    const title = source?.title ?? text;

    return (
      <span
        ref={ref}
        className={cn(BADGE_BASE, className)}
        title={`Source: ${title}`}
        data-testid="source-badge"
        {...props}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{text}</span>
      </span>
    );
  },
);
SourceBadge.displayName = 'SourceBadge';
