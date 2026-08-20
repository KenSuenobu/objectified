/**
 * What the visual-parity harness measures, and what it deliberately does not
 * (HIVE-10.1, #5337).
 *
 * ### The app side
 *
 * A parity test needs the app to render the page. Driving the real route would need a
 * session, a tenant and a database seeded to match what a designer typed into the mockup —
 * so every Hive page epic since HIVE-7.1 has instead had its jsdom suite **dump what it
 * rendered** into `e2e/fixtures/hive-<page>/`, and its browser suite mount that. Those dumps are
 * the real components' real output, kept honest by the jsdom suite that writes them, and
 * they are the same thing this harness mounts. See `e2e/visual/README.md`.
 *
 * ### Coverage is a ledger, not a sample
 *
 * {@link PARITY_ROUTES} names every mockup that *is* compared and
 * {@link UNCOVERED_MOCKUPS} names every mockup that is not, with the reason. Together they
 * must account for every page mockup in `docs/mockups/` — `tests/visual-parity-routes.test.ts`
 * fails if one is missing from both, so a new mockup cannot quietly slip past the harness.
 */

/** Where the app side of a comparison comes from. */
export type ParitySubject =
  /** A committed fixture dump, mounted into a page that compiles the real `globals.css`. */
  | { kind: 'fixture'; dir: string; file: string }
  /** A live route on the dev server, for pages that need neither a session nor data. */
  | { kind: 'route'; path: string };

/** One mockup to app pairing the harness gates on. */
export interface ParityRoute {
  /** Short, stable id — used for the test title and the report file name. */
  id: string;
  /** The mockup, relative to `docs/mockups/`. It is read-only input. */
  mockup: string;
  /** The production route this pairing stands for, for the report. */
  route: string;
  /** Where the app side comes from. */
  subject: ParitySubject;
  /** The roadmap ticket that redesigned the route. */
  roadmapRef: string;
}

/** Why a mockup is not compared. */
export type UncoveredReason =
  /** Its redesign ticket has not landed, so there is no redesigned page to measure. */
  | 'awaiting-redesign'
  /** The surface is a dialog, drawer or wizard, not a page shell with page chrome. */
  | 'overlay-not-page'
  /** The surface uses the auth, launcher or foundations shell, not the app page shell. */
  | 'other-shell'
  /** The route is redesigned, but its suite mounts markup built in the spec, not a dump. */
  | 'no-page-fixture';

/** What each reason means, for the report and the README. */
export const UNCOVERED_REASONS: Record<UncoveredReason, string> = {
  'awaiting-redesign':
    'the redesign ticket for this route has not landed, so there is no redesigned page to measure yet',
  'overlay-not-page':
    'the surface is a dialog, drawer or wizard rather than a page shell, so the page-chrome landmarks do not apply',
  'other-shell':
    'the surface uses the auth, launcher or foundations shell rather than the app page shell',
  'no-page-fixture':
    'the route is redesigned, but its browser suite builds its markup inline instead of dumping a fixture, so there is nothing committed to mount',
};

/** A mockup the harness does not compare, and why. */
export interface UncoveredMockup {
  /** The mockup, relative to `docs/mockups/`. */
  mockup: string;
  /** Why it is not compared. */
  reason: UncoveredReason;
}

/**
 * Every mockup to app pairing the harness gates on.
 *
 * All eighteen are app-shell pages: a `.page` region with the HIVE-3.5 page chrome, which is
 * what the landmark table in `landmarks.ts` describes. Where a route has several committed
 * states, the pairing uses the state the mockup draws — the populated one — because an empty
 * state and a full table are different designs and comparing one to the other would measure
 * the fixture choice rather than the page.
 */
export const PARITY_ROUTES: readonly ParityRoute[] = [
  {
    id: 'versions',
    mockup: 'build/versions.html',
    route: '/ade/dashboard/versions',
    subject: { kind: 'fixture', dir: 'hive-versions', file: 'timeline.html' },
    roadmapRef: 'HIVE-6.2',
  },
  {
    id: 'primitives',
    mockup: 'build/primitives.html',
    route: '/ade/dashboard/primitives',
    subject: { kind: 'fixture', dir: 'hive-primitives', file: 'registry.html' },
    roadmapRef: 'HIVE-6.5',
  },
  {
    id: 'primitive-detail',
    mockup: 'build/primitive-detail.html',
    route: '/ade/dashboard/primitives/[id]',
    subject: { kind: 'fixture', dir: 'hive-primitive-detail', file: 'detail.html' },
    roadmapRef: 'HIVE-6.5',
  },
  {
    id: 'catalog',
    mockup: 'sources/catalog.html',
    route: '/ade/dashboard/catalog',
    subject: { kind: 'fixture', dir: 'hive-catalog', file: 'table.html' },
    roadmapRef: 'HIVE-7.1',
  },
  {
    id: 'catalog-item',
    mockup: 'sources/catalog-item.html',
    route: '/ade/dashboard/catalog/[id]',
    subject: { kind: 'fixture', dir: 'hive-catalog-item', file: 'overview.html' },
    roadmapRef: 'HIVE-7.2',
  },
  {
    id: 'repositories',
    mockup: 'sources/repositories.html',
    route: '/ade/dashboard/repositories',
    subject: { kind: 'fixture', dir: 'hive-repositories', file: 'table.html' },
    roadmapRef: 'HIVE-7.3',
  },
  {
    id: 'repository-detail',
    mockup: 'sources/repository-detail.html',
    route: '/ade/dashboard/repositories/[id]',
    subject: { kind: 'fixture', dir: 'hive-repository-detail', file: 'files.html' },
    roadmapRef: 'HIVE-7.5',
  },
  {
    id: 'repository-catalog',
    mockup: 'sources/repository-catalog.html',
    route: '/ade/dashboard/repositories/[id]/catalog',
    subject: { kind: 'fixture', dir: 'hive-repository-bring-in', file: 'catalog.html' },
    roadmapRef: 'HIVE-7.6',
  },
  {
    id: 'repository-telemetry',
    mockup: 'sources/repository-telemetry.html',
    route: '/ade/dashboard/repositories/[id]/telemetry',
    subject: { kind: 'fixture', dir: 'hive-repository-bring-in', file: 'telemetry.html' },
    roadmapRef: 'HIVE-7.6',
  },
  {
    id: 'webhook-allowlist',
    mockup: 'sources/webhook-allowlist.html',
    route: '/ade/dashboard/repositories/webhook-ip-allowlist',
    subject: { kind: 'fixture', dir: 'hive-repository-bring-in', file: 'allowlist.html' },
    roadmapRef: 'HIVE-7.6',
  },
  {
    id: 'mcp-servers',
    mockup: 'sources/mcp-servers.html',
    route: '/ade/dashboard/mcp',
    subject: { kind: 'fixture', dir: 'hive-mcp-catalog', file: 'catalog-list.html' },
    roadmapRef: 'HIVE-7.7',
  },
  {
    id: 'mcp-endpoint',
    mockup: 'sources/mcp-endpoint.html',
    route: '/ade/dashboard/mcp/[endpointId]',
    subject: { kind: 'fixture', dir: 'hive-mcp-endpoint', file: 'versions.html' },
    roadmapRef: 'HIVE-7.8',
  },
  {
    id: 'mcp-capabilities',
    mockup: 'sources/mcp-capabilities.html',
    route: '/ade/dashboard/mcp/capabilities',
    subject: { kind: 'fixture', dir: 'hive-mcp-analytics', file: 'capabilities.html' },
    roadmapRef: 'HIVE-7.9',
  },
  {
    id: 'mcp-analytics',
    mockup: 'sources/mcp-analytics.html',
    route: '/ade/dashboard/mcp/analytics',
    subject: { kind: 'fixture', dir: 'hive-mcp-analytics', file: 'dashboard.html' },
    roadmapRef: 'HIVE-7.9',
  },
  {
    id: 'mcp-compare',
    mockup: 'sources/mcp-compare.html',
    route: '/ade/dashboard/mcp/compare',
    subject: { kind: 'fixture', dir: 'hive-mcp-analytics', file: 'compare.html' },
    roadmapRef: 'HIVE-7.9',
  },
  {
    id: 'published',
    mockup: 'ship/published.html',
    route: '/ade/dashboard/published',
    subject: { kind: 'fixture', dir: 'hive-published', file: 'table.html' },
    roadmapRef: 'HIVE-8.1',
  },
  {
    id: 'sunset-timeline',
    mockup: 'ship/sunset-timeline.html',
    route: '/ade/dashboard/versions/sunset-timeline',
    subject: { kind: 'fixture', dir: 'hive-sunset-timeline', file: 'timeline.html' },
    roadmapRef: 'HIVE-8.2',
  },
  {
    id: 'export-studio',
    mockup: 'ship/export-studio.html',
    route: '/ade/dashboard/export/studio',
    subject: { kind: 'fixture', dir: 'hive-export-studio', file: 'source.html' },
    roadmapRef: 'HIVE-8.3',
  },
];

/**
 * Every page mockup the harness does not compare, and why.
 *
 * This list exists so that "not covered" is a decision on the record rather than an omission.
 * When a redesign ticket lands, its entry moves from here into {@link PARITY_ROUTES}; when a
 * new mockup is drawn, it has to appear in one of the two lists or the routes test fails.
 */
export const UNCOVERED_MOCKUPS: readonly UncoveredMockup[] = [
  { mockup: 'account/linked-accounts.html', reason: 'awaiting-redesign' },
  { mockup: 'account/profile.html', reason: 'awaiting-redesign' },
  { mockup: 'admin/feature-flags.html', reason: 'awaiting-redesign' },
  { mockup: 'admin/licenses.html', reason: 'awaiting-redesign' },
  { mockup: 'admin/login.html', reason: 'other-shell' },
  { mockup: 'admin/overview.html', reason: 'awaiting-redesign' },
  { mockup: 'admin/settings.html', reason: 'awaiting-redesign' },
  { mockup: 'admin/templates.html', reason: 'awaiting-redesign' },
  { mockup: 'admin/tenants.html', reason: 'awaiting-redesign' },
  { mockup: 'admin/users.html', reason: 'awaiting-redesign' },
  { mockup: 'auth/login.html', reason: 'other-shell' },
  { mockup: 'auth/onboarding.html', reason: 'other-shell' },
  { mockup: 'auth/signup-oauth.html', reason: 'other-shell' },
  { mockup: 'auth/two-factor.html', reason: 'other-shell' },
  { mockup: 'build/import-wizard.html', reason: 'overlay-not-page' },
  { mockup: 'build/projects.html', reason: 'awaiting-redesign' },
  { mockup: 'build/version-dialogs.html', reason: 'overlay-not-page' },
  { mockup: 'foundations/design-system.html', reason: 'other-shell' },
  { mockup: 'foundations/help.html', reason: 'no-page-fixture' },
  { mockup: 'foundations/settings-pane.html', reason: 'overlay-not-page' },
  { mockup: 'foundations/shell.html', reason: 'other-shell' },
  { mockup: 'govern/lint-posture.html', reason: 'no-page-fixture' },
  { mockup: 'govern/style-guide-detail.html', reason: 'no-page-fixture' },
  { mockup: 'govern/style-guides.html', reason: 'no-page-fixture' },
  { mockup: 'home/launcher.html', reason: 'other-shell' },
  { mockup: 'home/overview.html', reason: 'no-page-fixture' },
  { mockup: 'sources/repository-new.html', reason: 'overlay-not-page' },
  { mockup: 'tools/database.html', reason: 'awaiting-redesign' },
  { mockup: 'tools/migration.html', reason: 'awaiting-redesign' },
  { mockup: 'workspace/api-keys.html', reason: 'no-page-fixture' },
  { mockup: 'workspace/audit.html', reason: 'no-page-fixture' },
  { mockup: 'workspace/members.html', reason: 'no-page-fixture' },
  { mockup: 'workspace/roles.html', reason: 'no-page-fixture' },
  { mockup: 'workspace/tenants.html', reason: 'no-page-fixture' },
];

/**
 * The route map entry with a given id.
 *
 * @param id The entry's id.
 * @returns The entry.
 * @throws When no entry has that id, which is a typo in a spec rather than a parity failure.
 */
export function parityRoute(id: string): ParityRoute {
  const found = PARITY_ROUTES.find((route) => route.id === id);
  if (!found) throw new Error(`visual-parity: no route map entry with id "${id}"`);
  return found;
}
