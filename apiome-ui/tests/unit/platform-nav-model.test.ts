/**
 * The Hive navigation model (HIVE-3.2, #5288).
 *
 * These tests are the contract `lib/platform-nav.ts` owes every surface that
 * renders navigation — the sidebar today, the `AppShell` rail (HIVE-3.1), the
 * command palette (HIVE-3.6) — so the four acceptance criteria are pinned here
 * rather than in any one component:
 *
 *   1. the model *is* the navigation (shape, grouping, labels, icons);
 *   2. active-state resolution is unchanged from the pre-Hive sidebar, route by
 *      route, for every destination the model carries;
 *   3. workspace gating produces exactly the disabled set it produced before;
 *   4. no Tools route and no commercial-product route is hard-coded anywhere.
 */
import {
  DEFAULT_PLATFORM_NAV_ICON,
  PLATFORM_NAV_GROUPS,
  PLATFORM_NAV_GROUP_IDS,
  PLATFORM_NAV_SUNSET_TIMELINE_HREF,
  PLATFORM_NAV_VERSIONS_HREF,
  PLATFORM_USER_MENU_ITEMS,
  findPlatformNavItem,
  getPlatformNavGroups,
  getPlatformUserMenuItems,
  isPlatformNavHrefActive,
  isPlatformNavItemActive,
  platformNavGatedReason,
  toPlatformNavInjections,
  type PlatformNavItem,
} from '../../lib/platform-nav';
import { PLATFORM_NAV_ICONS, resolvePlatformNavIcon } from '../../lib/platform-nav-icons';

/** Every modelled destination — rail groups plus the user menu. */
const ALL_ITEMS: PlatformNavItem[] = [
  ...PLATFORM_NAV_GROUPS.flatMap((group) => group.items),
  ...PLATFORM_USER_MENU_ITEMS,
];

/** Look a destination up by id, failing loudly rather than returning undefined. */
function item(id: string): PlatformNavItem {
  const found = findPlatformNavItem(id);
  if (!found) throw new Error(`No nav item with id "${id}"`);
  return found;
}

const TENANT = 't-1';

describe('platform-nav model — shape', () => {
  it('groups destinations by job to be done, in DESIGN.md §6 order', () => {
    expect(PLATFORM_NAV_GROUPS.map((group) => group.id)).toEqual([
      'home',
      'build',
      'bring-in',
      'ship',
      'govern',
      'workspace',
    ]);
    expect(PLATFORM_NAV_GROUPS.map((group) => group.label)).toEqual([
      undefined,
      'Build',
      'Bring in',
      'Ship',
      'Govern',
      'Workspace',
    ]);
    // Every declared group id is actually used, and vice versa.
    expect([...PLATFORM_NAV_GROUP_IDS].sort()).toEqual(
      PLATFORM_NAV_GROUPS.map((group) => group.id).sort()
    );
  });

  it('carries every destination §6 lists, in its group', () => {
    const byGroup = Object.fromEntries(
      PLATFORM_NAV_GROUPS.map((group) => [group.id, group.items.map((navItem) => navItem.id)])
    );

    expect(byGroup).toEqual({
      home: ['home'],
      build: ['projects', 'primitives'],
      'bring-in': ['catalog', 'repositories', 'mcp'],
      ship: ['published', 'sunset-timeline', 'export-studio'],
      govern: ['style-guides', 'lint-workspace', 'audit'],
      workspace: ['members', 'roles', 'api-keys', 'tenants'],
    });
    expect(PLATFORM_USER_MENU_ITEMS.map((navItem) => navItem.id)).toEqual([
      'profile',
      'linked-accounts',
    ]);
  });

  it('labels every destination the way the mockup does', () => {
    expect(ALL_ITEMS.map((navItem) => navItem.label)).toEqual([
      'Home',
      'Projects',
      'Primitives & types',
      'Catalog',
      'Repositories',
      'MCP servers',
      'Published',
      'Sunset timeline',
      'Export studio',
      'Style guides',
      'Lint posture',
      'Access audit',
      'Members',
      'Roles',
      'API keys',
      'Tenants',
      'Profile',
      'Linked accounts',
    ]);
  });

  it('gives ids and hrefs that are unique', () => {
    const ids = ALL_ITEMS.map((navItem) => navItem.id);
    const hrefs = ALL_ITEMS.map((navItem) => navItem.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('marks only Lint posture as a preview', () => {
    expect(ALL_ITEMS.filter((navItem) => navItem.pill).map((navItem) => [navItem.id, navItem.pill]))
      .toEqual([['lint-workspace', 'Preview']]);
  });

  it('names only icons the icon map can resolve', () => {
    for (const navItem of ALL_ITEMS) {
      expect(PLATFORM_NAV_ICONS[navItem.icon]).toBeDefined();
      expect(resolvePlatformNavIcon(navItem.icon)).toBe(PLATFORM_NAV_ICONS[navItem.icon]);
    }
  });

  it('falls back to the generic icon for a name it does not know', () => {
    expect(resolvePlatformNavIcon('no-such-glyph')).toBe(
      PLATFORM_NAV_ICONS[DEFAULT_PLATFORM_NAV_ICON]
    );
  });

  it('finds a destination by id, and reports an unknown id as undefined', () => {
    expect(item('catalog').href).toBe('/ade/dashboard/catalog');
    expect(findPlatformNavItem('nope')).toBeUndefined();
  });
});

describe('platform-nav model — nothing deferred or commercial is hard-coded', () => {
  const forbidden = ['/ade/studio', '/ade/database', '/ade/migration'];

  it('contains no Tools route and no studio route', () => {
    for (const navItem of ALL_ITEMS) {
      for (const prefix of forbidden) {
        expect(navItem.href.startsWith(prefix)).toBe(false);
      }
    }
  });

  it('routes every destination through /ade/dashboard', () => {
    for (const navItem of ALL_ITEMS) {
      expect(navItem.href.startsWith('/ade/dashboard')).toBe(true);
      expect(navItem.external).toBeUndefined();
    }
  });
});

describe('platform-nav model — active-state resolution', () => {
  /**
   * Every route the model can be asked about, and the one destination that owns
   * it. Transcribed from the pre-Hive `DashboardSideNav.isActive`, so a change
   * to the resolver that changes behaviour fails here.
   */
  const ROUTES: ReadonlyArray<[pathname: string, ownerId: string]> = [
    ['/ade/dashboard', 'home'],
    ['/ade/dashboard/projects', 'projects'],
    [PLATFORM_NAV_VERSIONS_HREF, 'projects'],
    [`${PLATFORM_NAV_VERSIONS_HREF}/v-1`, 'projects'],
    [PLATFORM_NAV_SUNSET_TIMELINE_HREF, 'sunset-timeline'],
    ['/ade/dashboard/primitives', 'primitives'],
    ['/ade/dashboard/primitives/p-1', 'primitives'],
    ['/ade/dashboard/catalog', 'catalog'],
    ['/ade/dashboard/catalog/c-1', 'catalog'],
    ['/ade/dashboard/repositories', 'repositories'],
    ['/ade/dashboard/repositories/new', 'repositories'],
    ['/ade/dashboard/repositories/r-1/preview', 'repositories'],
    ['/ade/dashboard/mcp', 'mcp'],
    ['/ade/dashboard/mcp/capabilities', 'mcp'],
    ['/ade/dashboard/mcp/e-1', 'mcp'],
    ['/ade/dashboard/published', 'published'],
    ['/ade/dashboard/export/studio', 'export-studio'],
    ['/ade/dashboard/style-guides', 'style-guides'],
    ['/ade/dashboard/lint-workspace', 'lint-workspace'],
    ['/ade/dashboard/lint-workspace/findings', 'lint-workspace'],
    ['/ade/dashboard/audit', 'audit'],
    ['/ade/dashboard/members', 'members'],
    ['/ade/dashboard/roles', 'roles'],
    ['/ade/dashboard/api-keys', 'api-keys'],
    ['/ade/dashboard/tenants', 'tenants'],
    ['/ade/dashboard/profile', 'profile'],
    ['/ade/dashboard/linked-accounts', 'linked-accounts'],
  ];

  it.each(ROUTES)('%s activates exactly one destination', (pathname, ownerId) => {
    const active = ALL_ITEMS.filter((navItem) => isPlatformNavItemActive(navItem, pathname));
    expect(active.map((navItem) => navItem.id)).toEqual([ownerId]);
    expect(isPlatformNavHrefActive(item(ownerId).href, pathname)).toBe(true);
  });

  it('keeps Projects and Sunset timeline from claiming each other', () => {
    expect(isPlatformNavHrefActive(item('projects').href, PLATFORM_NAV_SUNSET_TIMELINE_HREF)).toBe(
      false
    );
    expect(
      isPlatformNavHrefActive(item('sunset-timeline').href, `${PLATFORM_NAV_VERSIONS_HREF}/v-1`)
    ).toBe(false);
  });

  it('matches leaf destinations exactly, never by prefix', () => {
    // `published` has no children today; a lookalike route must not light it up.
    expect(isPlatformNavHrefActive(item('published').href, '/ade/dashboard/published/x')).toBe(
      false
    );
    // `/export` is a page of its own; only `/export/studio` is the nav entry.
    expect(isPlatformNavHrefActive(item('export-studio').href, '/ade/dashboard/export')).toBe(false);
    // Carried over verbatim from the pre-Hive sidebar: a style-guide detail page
    // highlights nothing. DESIGN.md §6 lists `/[guideId]` under Style guides, so
    // this is a candidate for the ticket that owns that page — but changing it
    // here would break "active-state rules preserved exactly".
    expect(isPlatformNavHrefActive(item('style-guides').href, '/ade/dashboard/style-guides/g-1')).toBe(
      false
    );
  });

  it('never matches a sibling route that merely shares a prefix', () => {
    expect(isPlatformNavHrefActive(item('catalog').href, '/ade/dashboard/catalog-archive')).toBe(
      false
    );
    expect(isPlatformNavHrefActive(item('mcp').href, '/ade/dashboard/mcpx')).toBe(false);
  });

  it('is inactive before hydration, when the pathname is not known yet', () => {
    expect(isPlatformNavHrefActive(item('home').href, null)).toBe(false);
    expect(isPlatformNavHrefActive(item('home').href, undefined)).toBe(false);
    expect(isPlatformNavItemActive(item('home'), null)).toBe(false);
  });

  it('matches an unmodelled href exactly unless it declares its own rule', () => {
    const contributed = { href: '/ade/dashboard/anything' };
    expect(isPlatformNavHrefActive(contributed.href, contributed.href)).toBe(true);
    expect(isPlatformNavHrefActive(contributed.href, `${contributed.href}/child`)).toBe(false);

    const subtree = { href: '/ade/dashboard/anything', match: 'subtree' as const };
    expect(isPlatformNavItemActive(subtree, `${subtree.href}/child`)).toBe(true);
  });
});

describe('platform-nav model — workspace gating', () => {
  /** Exactly the entries the pre-Hive sidebar greyed out with no tenant. */
  const GATED = [
    'projects',
    'primitives',
    'catalog',
    'repositories',
    'mcp',
    'published',
    'sunset-timeline',
    'export-studio',
    'style-guides',
    'lint-workspace',
    'audit',
    'members',
    'roles',
    'api-keys',
  ];

  it('disables exactly the workspace-scoped destinations when there is no tenant', () => {
    const disabled = getPlatformNavGroups({ currentTenantId: null })
      .flatMap((group) => group.items)
      .filter((navItem) => navItem.disabled)
      .map((navItem) => navItem.id);

    expect(disabled.sort()).toEqual([...GATED].sort());
  });

  it('leaves Home, Tenants and the account destinations reachable without a tenant', () => {
    const enabled = getPlatformNavGroups({ currentTenantId: undefined })
      .flatMap((group) => group.items)
      .filter((navItem) => !navItem.disabled)
      .map((navItem) => navItem.id);

    expect(enabled).toEqual(['home', 'tenants']);
    expect(
      getPlatformUserMenuItems({ currentTenantId: undefined }).every((navItem) => !navItem.disabled)
    ).toBe(true);
  });

  it('enables everything once a workspace is selected', () => {
    const groups = getPlatformNavGroups({ currentTenantId: TENANT });
    for (const group of groups) {
      for (const navItem of group.items) {
        expect(navItem.disabled).toBe(false);
        expect(navItem.disabledReason).toBeUndefined();
      }
    }
  });

  it('explains each gated destination by name', () => {
    const projects = getPlatformNavGroups({ currentTenantId: null })
      .flatMap((group) => group.items)
      .find((navItem) => navItem.id === 'projects');

    expect(projects?.disabledReason).toBe('Select a workspace to use Projects.');
    expect(platformNavGatedReason('Catalog')).toBe('Select a workspace to use Catalog.');
  });

  it('treats an empty tenant id as no tenant', () => {
    const projects = getPlatformNavGroups({ currentTenantId: '' })
      .flatMap((group) => group.items)
      .find((navItem) => navItem.id === 'projects');

    expect(projects?.disabled).toBe(true);
  });

  it('does not mutate the model when resolving', () => {
    getPlatformNavGroups({ currentTenantId: null });
    expect(
      PLATFORM_NAV_GROUPS.flatMap((group) => group.items).every(
        (navItem) => !('disabled' in navItem)
      )
    ).toBe(true);
  });
});

describe('platform-nav model — runtime injection', () => {
  const contributed = {
    id: 'suite-designer',
    label: 'Designer',
    href: 'https://suite.example.com/editor',
    external: true,
  };

  it('appends a contributed destination after the group it was addressed to', () => {
    const [injection] = toPlatformNavInjections([contributed], 'build');
    const build = getPlatformNavGroups({ currentTenantId: TENANT, injected: [injection] }).find(
      (group) => group.id === 'build'
    );

    expect(build?.items.map((navItem) => navItem.id)).toEqual([
      'projects',
      'primitives',
      'suite-designer',
    ]);
    expect(build?.items.at(-1)).toMatchObject({
      href: contributed.href,
      external: true,
      icon: DEFAULT_PLATFORM_NAV_ICON,
      disabled: false,
    });
  });

  it('defaults contributions to Build and honours an explicit icon', () => {
    const [injection] = toPlatformNavInjections([{ ...contributed, icon: 'shapes' }]);
    expect(injection.group).toBe('build');
    expect(injection.item.icon).toBe('shapes');
  });

  it('places contributions in Bring in or Ship when the host asks', () => {
    const injected = [
      ...toPlatformNavInjections([contributed], 'bring-in'),
      ...toPlatformNavInjections([{ ...contributed, id: 'suite-paths' }], 'ship'),
    ];
    const groups = getPlatformNavGroups({ currentTenantId: TENANT, injected });

    expect(groups.find((group) => group.id === 'bring-in')?.items.at(-1)?.id).toBe('suite-designer');
    expect(groups.find((group) => group.id === 'ship')?.items.at(-1)?.id).toBe('suite-paths');
  });

  it('drops a contribution addressed to a group that does not exist', () => {
    const groups = getPlatformNavGroups({
      currentTenantId: TENANT,
      injected: [
        // A host built against a later model, naming a group this build lacks.
        { group: 'tools' as never, item: { ...contributed, icon: 'box' } },
      ],
    });

    expect(groups.flatMap((group) => group.items).map((navItem) => navItem.id)).not.toContain(
      'suite-designer'
    );
  });

  it('renders the first-party model unchanged when nothing is contributed', () => {
    expect(
      getPlatformNavGroups({ currentTenantId: TENANT }).flatMap((group) =>
        group.items.map((navItem) => navItem.id)
      )
    ).toEqual(PLATFORM_NAV_GROUPS.flatMap((group) => group.items.map((navItem) => navItem.id)));
  });
});
