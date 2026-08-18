import ProjectsClient from './ProjectsClient';

/**
 * Build → Projects (HIVE-6.1, #5312).
 *
 * Thin server component: all state lives in the client component, matching the other
 * dashboard screens (see `style-guides/page.tsx`).
 */
export default function ProjectsPage() {
  return <ProjectsClient />;
}
