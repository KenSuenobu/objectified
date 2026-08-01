'use client';

/**
 * `/ade/dashboard/repositories/catalog` — the tenant-wide discovered-specs catalog (REPO-6.4).
 *
 * `catalog` is a static sibling of `[id]`; Next.js matches static segments first, so this
 * route is never shadowed by the repository detail page.
 *
 * The Suspense boundary is required, not decorative: {@link RepositorySpecCatalog} reads
 * `useSearchParams` to seed its filters from the URL, which opts the subtree into client-side
 * rendering.
 */

import { Suspense } from 'react';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { RepositorySpecCatalog } from '@/app/components/ade/dashboard/repositories/RepositorySpecCatalog';

export default function RepositorySpecCatalogPage() {
  return (
    <Suspense
      fallback={<LoadingState className="min-h-[40vh]" message="Loading discovered specs…" />}
    >
      <RepositorySpecCatalog />
    </Suspense>
  );
}
