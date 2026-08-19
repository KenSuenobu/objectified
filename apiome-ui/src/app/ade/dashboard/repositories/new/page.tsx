import AddRepositoryClient from './AddRepositoryClient';

/**
 * Bring in → Repositories → Add a repository (HIVE-7.4, #5321).
 *
 * Thin server component: all state lives in the client component, matching the other dashboard
 * screens (see `repositories/page.tsx`).
 */
export default function AddRepositoryPage() {
  return <AddRepositoryClient />;
}
