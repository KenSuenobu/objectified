'use client';

/**
 * `/ade/dashboard/repositories/catalog` — the tenant-wide discovered-specs catalog
 * (REPO-6.4, #2797; redesigned HIVE-7.6, #5323).
 *
 * `catalog` is a static sibling of `[id]`; Next.js matches static segments first, so this
 * route is never shadowed by the repository detail page.
 *
 * The Suspense boundary is required, not decorative: {@link DiscoveredSpecsClient} reads
 * `useSearchParams` to seed its filters from the URL, which opts the subtree into client-side
 * rendering.
 */

import { Suspense } from 'react';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { SPEC_CATALOG_LOADING } from '@/app/components/ade/repositories';
import { DiscoveredSpecsClient } from './DiscoveredSpecsClient';

export default function RepositorySpecCatalogPage() {
  return (
    <Suspense fallback={<LoadingState message={SPEC_CATALOG_LOADING} />}>
      <DiscoveredSpecsClient />
    </Suspense>
  );
}
