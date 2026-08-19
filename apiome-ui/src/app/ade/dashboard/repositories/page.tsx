import RepositoriesClient from './RepositoriesClient';

/**
 * Bring in → Repositories (HIVE-7.3, #5320).
 *
 * Thin server component: all state lives in the client component, matching the other
 * dashboard screens (see `catalog/page.tsx`).
 */
export default function RepositoriesPage() {
  return <RepositoriesClient />;
}
