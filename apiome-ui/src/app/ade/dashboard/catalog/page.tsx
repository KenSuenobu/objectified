import CatalogClient from './CatalogClient';

/**
 * Bring in → Catalog (HIVE-7.1, #5318).
 *
 * Thin server component: all state lives in the client component, matching the other
 * dashboard screens (see `projects/page.tsx`).
 */
export default function CatalogPage() {
  return <CatalogClient />;
}
