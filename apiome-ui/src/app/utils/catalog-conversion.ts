/**
 * Types and presentation helpers for a catalog item's convert-to-OpenAPI back-link (MFI-23.11, #4020).
 *
 * Once a catalog item has been converted (the MFI-EPIC-22 fidelity-preview → convert flow), the REST
 * catalog list/detail responses carry a `conversion` object projected from the conversion-provenance
 * ledger (MFI-22.5): the publishable Project it produced, that Project's name/slug (or a `projectDeleted`
 * flag if it was since removed), the produced revision, whether the latest conversion was a re-convert,
 * and the fidelity grade/tier. The Catalog card and detail render this as **"Converted → {project}"**
 * with a link, and the convert action relabels to **"Re-convert to OpenAPI Project"** (or
 * **"Re-convert to Project"** when the source is already OpenAPI or Arazzo).
 *
 * These helpers are pure (no React, no fetch) so they can be unit-tested and reused by the card, the
 * table row, and the detail view.
 */

import { resolveCatalogFormat } from './catalog-format-registry';

/** The convert-to-OpenAPI back-link for a catalog item (mirrors the REST `CatalogConversionRef`). */
export interface CatalogConversion {
  /** Id of the publishable Project the item was converted into. */
  projectId: string;
  /** Name of the converted Project (null once it has been deleted). */
  projectName?: string | null;
  /** Slug of the converted Project (null once it has been deleted). */
  projectSlug?: string | null;
  /** True when the converted Project has since been deleted (its link is no longer live). */
  projectDeleted?: boolean;
  /** Semantic version label of the produced revision (e.g. `1.0.1`). */
  versionId?: string | null;
  /** Row id of the produced revision. */
  versionRecordId?: string | null;
  /** True when the latest conversion superseded a prior one (the source changed and was re-converted). */
  reconverted?: boolean;
  /** When the latest conversion was committed (ISO timestamp). */
  convertedAt?: string | null;
  /** A-F fidelity grade the conversion achieved (MFI-22.3). */
  fidelityGrade?: string | null;
  /** Coarse fidelity tier (high/medium/low) of the conversion. */
  fidelityTier?: string | null;
  /** Id of the latest conversion_provenance row — the evidence history anchor (CPDO-3.3). */
  provenanceId?: string | null;
  /** Content-addressed snapshot hash of the latest conversion; null on pre-manifest rows. */
  manifestHash?: string | null;
}

/**
 * Href to the converted publishable Project. A catalog item's conversion produces a normal Project, so
 * we link to its versions screen (where it can be inspected and published) — the same destination the
 * catalog "View" action uses for an item's own project id.
 */
export function convertedProjectHref(conversion: CatalogConversion): string {
  return `/ade/dashboard/versions?projectId=${encodeURIComponent(conversion.projectId)}`;
}

/**
 * A friendly label for the converted Project: its name, else its slug, else a shortened id. Used as the
 * link text in the "Converted → {project}" badge.
 */
export function convertedProjectLabel(conversion: CatalogConversion): string {
  const name = conversion.projectName?.trim();
  if (name) return name;
  const slug = conversion.projectSlug?.trim();
  if (slug) return slug;
  return `project ${conversion.projectId.slice(0, 8)}`;
}

/**
 * Whether the converted Project link is still live — true unless the target Project has been deleted.
 * A deleted target still shows the converted state (so the history is visible) but as plain text, not a
 * link.
 */
export function isConvertedLinkLive(conversion: CatalogConversion | null | undefined): boolean {
  return Boolean(conversion) && !conversion!.projectDeleted;
}

/**
 * True when the catalog item's source is already OpenAPI or Arazzo — the convert action can say
 * "Convert to Project" because no cross-format OpenAPI projection needs to be spelled out.
 */
export function isDirectProjectConvertFormat(sourceFormat?: string | null): boolean {
  const id = resolveCatalogFormat(sourceFormat)?.id;
  return id === 'openapi' || id === 'arazzo';
}

/**
 * The convert action's label. Non-OpenAPI/Arazzo sources read "Convert to OpenAPI Project" on first
 * convert (the catalog item becomes a publishable Project via OpenAPI projection). OpenAPI and Arazzo
 * items read the shorter "Convert to Project". Once converted, the action becomes "Re-convert …"
 * (re-convert is always allowed — a changed source appends a new version rather than duplicating the
 * Project, MFI-22.5).
 */
export function convertActionLabel(
  conversion: CatalogConversion | null | undefined,
  sourceFormat?: string | null,
): string {
  const short = isDirectProjectConvertFormat(sourceFormat);
  if (conversion) {
    return short ? 'Re-convert to Project' : 'Re-convert to OpenAPI Project';
  }
  return short ? 'Convert to Project' : 'Convert to OpenAPI Project';
}

/**
 * Title for the conversion preview dialog — mirrors {@link convertActionLabel} without the
 * Re-convert variant.
 */
export function convertPreviewDialogTitle(
  itemName: string,
  sourceFormat?: string | null,
): string {
  const prefix = isDirectProjectConvertFormat(sourceFormat)
    ? 'Convert to Project'
    : 'Convert to OpenAPI Project';
  return `${prefix} — ${itemName}`;
}

/**
 * Copy stating the Export-vs-Convert distinction on catalog surfaces (MFX-41.2, #4349): Export
 * emits a document in another format and never mutates the catalog item or mints a Project;
 * Convert is the one action that turns the item into an OpenAPI Project. Shown wherever both
 * actions sit side by side (catalog list actions, detail CTAs).
 */
export const CATALOG_EXPORT_VS_CONVERT_COPY =
  'Produce a document in another API format. Unlike Convert, this never turns the item into a project.';
