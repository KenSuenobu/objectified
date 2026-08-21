'use client';

/**
 * `<FormatTraitPills>` (CATP-1.1) — the pair of quiet pills that say what a format *is* and where
 * APIs in it typically *come from*.
 *
 * The catalog's supported-formats gallery lists forty-five formats, and a reader who does not
 * already know Cap'n Proto from a COBOL copybook cannot tell from the names which of them belong to
 * the corner of the estate they are actually holding. These two pills answer that in the width of a
 * chip: the first is the **data type** (a REST contract, an RPC interface, a bare schema, an
 * industry message set, captured requests…), the second the **typical source** (web, cloud,
 * enterprise, mainframe, healthcare, finance…). Both come from the format registry, so a newly
 * registered format is classified where it is declared and needs no edit here.
 *
 * ### Why these are not tinted
 *
 * The chip already carries a colour: `catalogFormatHueClass` paints the format's tile in its
 * **fixed identity hue** (HIVE-2.4), which is the whole reason the gallery exists — it teaches the
 * hue the catalog table then reuses. A second and third saturated pill beside it would compete with
 * the one colour that means something. So the traits take the neutral surface pair the panel
 * already uses for its `+39` pill (`--bg-inset` under `--fg-muted`) and separate themselves by
 * **icon and outline** instead: the data type is filled, the typical source is outlined. That also
 * keeps them clear of the trap `apiome-ui`'s tone pills fell into — a `-fg` ink on a plain surface
 * measures below AA in several of the nine themes, and these two pairs are ones the catalog panel
 * has already been measured with.
 */

import * as React from 'react';

import {
  catalogFormatTraits,
  type CatalogFormat,
  type CatalogFormatTraitMeta,
} from '@/app/utils/catalog-format-registry';
import { cn } from '@lib/utils';

export interface FormatTraitPillsProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The registry entry whose traits to show. */
  format: CatalogFormat;
}

/** Props for {@link TraitPill}. */
interface TraitPillProps {
  /** Which half of the pair this is — drives the fill/outline treatment and the tooltip's noun. */
  kind: 'data-type' | 'origin';
  /** The raw registry value, exposed as `data-value` so tests and the fixtures can assert on it. */
  value: string;
  /** The label, icon and sentence to render. */
  meta: CatalogFormatTraitMeta;
}

/** The tooltip prefix for each half: the pills are short, so the title says which question they answer. */
const TRAIT_NOUN: Readonly<Record<TraitPillProps['kind'], string>> = {
  'data-type': 'Data type',
  origin: 'Typical source',
};

/**
 * One trait pill: its icon, its short label, and a title naming the question it answers.
 *
 * @param props See {@link TraitPillProps}.
 * @returns The pill.
 */
function TraitPill({ kind, value, meta }: TraitPillProps) {
  const Icon = meta.icon;
  return (
    <span
      className={cn('fmt-trait', kind === 'origin' && 'fmt-trait--origin')}
      data-trait={kind}
      data-value={value}
      title={`${TRAIT_NOUN[kind]}: ${meta.label} — ${meta.description}`}
    >
      <Icon aria-hidden />
      {meta.label}
    </span>
  );
}

/**
 * Render both trait pills for a format, or `null` when the registry cannot classify it.
 *
 * @param props See {@link FormatTraitPillsProps}.
 * @returns The pill pair.
 */
export const FormatTraitPills = React.forwardRef<HTMLSpanElement, FormatTraitPillsProps>(
  ({ format, className, ...props }, ref) => {
    const traits = catalogFormatTraits(format);
    if (!traits) return null;

    return (
      <span
        ref={ref}
        className={cn('fmt-traits', className)}
        data-testid="format-traits"
        {...props}
      >
        <TraitPill kind="data-type" value={format.dataType} meta={traits.dataType} />
        <TraitPill kind="origin" value={format.origin} meta={traits.origin} />
      </span>
    );
  },
);
FormatTraitPills.displayName = 'FormatTraitPills';

export default FormatTraitPills;
