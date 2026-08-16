'use client';

/**
 * `<FormatPill>` (MFI-23.5, #4014; re-hued HIVE-2.4, #5283) — the pill showing a catalog item's
 * imported file format.
 *
 * Resolves the raw `sourceFormat` (e.g. `openapi-3.1`, `grpc`) through the catalog format registry
 * to an icon + hue + label. Per the acceptance criteria, an **unknown but present** format degrades
 * to a neutral pill that shows the raw token (so nothing is ever silently dropped), and an
 * **absent** format renders nothing.
 *
 * The hue is a **fixed** one — the `.fmt--*` classes of `globals.css`, not a token — because a
 * format's colour is an identity rather than a state: OpenAPI is the same blue on the catalog
 * table, on the detail header and in the format facet, whichever theme is on. See the "Fixed
 * identity hues" block in `globals.css` for why, and `ui/statusVocabulary.ts` for the vocabulary
 * that *does* follow the theme.
 *
 * Which hue a format gets is still the registry's decision — its `tone` — so a new format names
 * a tone and needs no CSS. The hues are the ones the catalog already showed on a light theme,
 * frozen rather than re-chosen: this ticket is about a format's colour holding still, and
 * re-assigning 45 formats is a separate decision.
 *
 * Used on the Catalog card (MFI-23.4) and the detail view (MFI-23.9).
 */

import * as React from 'react';
import { FileCode2, type LucideIcon } from 'lucide-react';
import { cn } from '../../../../../lib/utils';
import { resolveCatalogFormat, catalogFormatHueClass } from '../../../utils/catalog-format-registry';

export interface FormatPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The raw `sourceFormat` string off the catalog item. */
  format: string | null | undefined;
}

/**
 * Render the format pill, or `null` when no format is present. A recognised format gets its
 * registry icon/hue/label; an unrecognised non-empty format gets a neutral pill showing the
 * raw string verbatim.
 */
export const FormatPill = React.forwardRef<HTMLSpanElement, FormatPillProps>(
  ({ format, className, ...props }, ref) => {
    if (!format || !format.trim()) return null;

    const entry = resolveCatalogFormat(format);
    const Icon: LucideIcon = entry?.icon ?? FileCode2;
    const label = entry?.label ?? format.trim();

    return (
      <span
        ref={ref}
        data-format={entry?.id ?? format.trim().toLowerCase()}
        className={cn('fmt', catalogFormatHueClass(entry?.tone), className)}
        title={`Format: ${label}`}
        data-testid="format-pill"
        {...props}
      >
        <Icon className="h-3 w-3" aria-hidden />
        {label}
      </span>
    );
  },
);
FormatPill.displayName = 'FormatPill';
