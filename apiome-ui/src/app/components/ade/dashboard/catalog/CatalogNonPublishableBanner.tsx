'use client';

/**
 * Persistent "catalog items are non-publishable" info banner (MFI-24.3, #4083).
 *
 * The mockup keeps a prominent info note on the Catalog list — on both the populated and empty
 * screens — that explains why catalog items differ from Projects: they come from formats that don't
 * map 1:1 to OpenAPI, and the only route to a publishable spec is "Convert to OpenAPI". The
 * implementation previously carried this messaging only in the empty state; this component surfaces
 * it above the toolbar in every state.
 *
 * Copy and structure mirror `note.info` in
 * `docs/planning/mockups/multi-format-import/index.html:389-396`. It is a static, always-on banner
 * (the ticket's "dismissible-per-session" is explicitly optional), and carries `role="note"` so
 * assistive tech announces it as an aside rather than as generic body text.
 */

import { Info } from 'lucide-react';

/**
 * Renders the non-publishable info banner.
 *
 * Purely presentational and self-contained — no props, no state — so it can be dropped at the top of
 * the Catalog content stack regardless of whether the list is empty or populated.
 */
export function CatalogNonPublishableBanner() {
  return (
    <div
      role="note"
      data-testid="catalog-nonpublishable-banner"
      className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50 p-3.5 text-xs leading-relaxed text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <strong className="font-semibold">Catalog items are non-publishable.</strong> They come from
        formats that don&apos;t map 1:1 to OpenAPI (gRPC, GraphQL, AsyncAPI, OData, WSDL, Avro, RAML,
        Smithy, TypeSpec, API&nbsp;Blueprint…). They are cataloged, versioned, diffed &amp; linted like
        Projects — but the only path to a publishable spec is{' '}
        <strong className="font-semibold">Convert&nbsp;to&nbsp;OpenAPI</strong> (with a fidelity
        preview). OpenAPI/Swagger imports still land in{' '}
        <strong className="font-semibold">Projects</strong>.
      </div>
    </div>
  );
}

export default CatalogNonPublishableBanner;
