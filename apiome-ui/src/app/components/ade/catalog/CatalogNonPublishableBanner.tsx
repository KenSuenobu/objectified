'use client';

/**
 * The persistent "catalog items are non-publishable" note (MFI-24.3; re-skinned HIVE-7.1,
 * #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html` §Non-publishable note — a `role="note"`
 * banner that is always visible and never dismissible, whose **copy is verbatim** in the
 * mockup's Keeps (1:1) list. It is the one sentence that explains why this screen exists
 * beside Projects at all, so it sits above the stats rather than inside an empty state.
 *
 * Two things about the markup:
 *
 * - It is `role="note"`, not `role="alert"`. Nothing here is a change or a failure; an alert
 *   role would interrupt a screen-reader user on every visit to the list to tell them a fact
 *   that has been true since the feature shipped. {@link Alert} defaults to `alert` and is
 *   overridden here.
 * - The tone is `info`, not `neutral`. `neutral` is `--fg-muted` on `--bg-subtle`, which
 *   measures 4.35:1 in Solarized — a serious axe `color-contrast` finding at this size, the
 *   same one HIVE-5.4 and HIVE-5.6 measured. `info` is the calibrated accent-soft/accent-fg
 *   pair and clears AA in all nine themes.
 */

import * as React from 'react';
import Link from 'next/link';

import { Alert } from '@/app/components/ui/Alert';

/**
 * Render the banner.
 *
 * Purely presentational and self-contained — no props, no state — so it can be dropped at the
 * top of the catalog content stack whether the list is empty or populated.
 *
 * @returns The note.
 */
export function CatalogNonPublishableBanner() {
  return (
    <Alert variant="info" role="note" data-testid="catalog-nonpublishable-banner">
      <strong>Catalog items are non-publishable.</strong> They come from formats that don&apos;t
      map 1:1 to OpenAPI (gRPC, GraphQL, AsyncAPI, OData, WSDL, Avro, RAML, Smithy, TypeSpec,
      API&nbsp;Blueprint…). They are cataloged, versioned, diffed &amp; linted like Projects — but
      the only path to a publishable spec is <strong>Convert&nbsp;to&nbsp;OpenAPI</strong> (with a
      fidelity preview). OpenAPI/Swagger imports still land in{' '}
      <Link href="/ade/dashboard/projects" className="cat-note__link">
        Projects
      </Link>
      .
    </Alert>
  );
}

export default CatalogNonPublishableBanner;
