'use client';

/**
 * The two marks a catalog item carries in both views (HIVE-7.1, #5318).
 *
 * `docs/mockups/sources/catalog.html` draws them on the card's `fmt-slot` and again in the
 * table's Artifact cell, so they live here rather than in either view: a format's pill and a
 * conversion's back-link have to be the same thing in both places, and they were not — the
 * card built the pill row inline while the table split it across three columns, and the
 * converted badge was a 30-line block of `emerald-50`/`emerald-700` literals repeated twice.
 *
 * Neither component decides a colour. `FormatPill` and `ProtocolPill` take their hue from the
 * fixed identity block (HIVE-2.4) because a format's colour is an *identity*; the converted
 * badge is `Badge status="ok"`, from the shared status vocabulary, because "this has been
 * promoted" is a *state*.
 */

import * as React from 'react';
import Link from 'next/link';

import { Badge } from '@/app/components/ui/Badge';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { ProtocolPill } from '@/app/components/ui/catalog/ProtocolPill';
import { SourceBadge } from '@/app/components/ui/catalog/SourceBadge';
import {
  convertedProjectHref,
  convertedProjectLabel,
  isConvertedLinkLive,
  type CatalogConversion,
} from '@/app/utils/catalog-conversion';

import { catalogItemSource, type CatalogItem } from './catalogModel';

export interface ConvertedBadgeProps {
  /** The item's conversion record, or `null`/absent when it has never been converted. */
  conversion?: CatalogConversion | null;
}

/**
 * "Converted → {project}" (MFI-23.11) — the promotion back-link.
 *
 * The one path off this screen that produces something publishable, so the mockup keeps it
 * visible on the card rather than behind the overflow menu. When the project it produced has
 * since been deleted the name is struck through and is no longer a link: the conversion still
 * happened, and saying so is more honest than dropping the badge and implying it did not.
 *
 * @param props See {@link ConvertedBadgeProps}.
 * @returns The badge, or `null` for an unconverted item.
 */
export function ConvertedBadge({ conversion }: ConvertedBadgeProps) {
  if (!conversion) return null;
  const label = convertedProjectLabel(conversion);
  const live = isConvertedLinkLive(conversion);
  const verb = conversion.reconverted ? 'Re-converted →' : 'Converted →';

  return (
    <span
      className="cat-converted"
      data-testid="catalog-converted-badge"
      title={
        conversion.reconverted
          ? 'Re-converted to an OpenAPI project'
          : 'Converted to an OpenAPI project'
      }
    >
      <Badge status="ok">{verb}</Badge>
      {live ? (
        <Link
          href={convertedProjectHref(conversion)}
          className="cat-converted__link"
          onClick={(event) => event.stopPropagation()}
        >
          {label}
        </Link>
      ) : (
        <span className="cat-converted__gone" title="The converted project was deleted">
          {label}
        </span>
      )}
    </span>
  );
}

export interface CatalogFormatRowProps {
  /** The item whose provenance is being drawn. */
  item: CatalogItem;
}

/**
 * The format · protocol · source row under a card's summary.
 *
 * All three are optional in the data — an item whose latest revision predates the format
 * registry has none of them — and the row says so once, as *Format pending*, rather than
 * drawing three em dashes. The table splits the same three values across its own columns,
 * where a per-cell dash is the right answer instead.
 *
 * @param props See {@link CatalogFormatRowProps}.
 * @returns The pill row.
 */
export function CatalogFormatRow({ item }: CatalogFormatRowProps) {
  const source = catalogItemSource(item);
  if (!item.sourceFormat && !item.protocol && !source) {
    return <span className="cat-quiet">Format pending</span>;
  }
  return (
    <>
      <FormatPill format={item.sourceFormat} />
      <ProtocolPill protocol={item.protocol} />
      {source ? <SourceBadge source={source} /> : null}
    </>
  );
}
