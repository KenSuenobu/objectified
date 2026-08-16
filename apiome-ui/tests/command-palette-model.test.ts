/**
 * What the command palette offers (HIVE-3.6, #5292).
 *
 * `commandPaletteModel.ts` is the half of the palette that has no DOM in it: which
 * destinations exist, which are gated and why, what `>` means, and where an action's deep
 * link points. Pinning those here — rather than only through a render — is what lets the
 * component suite be about behaviour and this one about the contract with
 * `lib/platform-nav.ts` and `openActions.ts`.
 *
 * Every expectation about *destinations* is derived from the navigation model rather than
 * written out, so a palette that stops reading the model fails here rather than silently
 * offering a stale list.
 */

import {
  COMMANDS_ONLY_PREFIX,
  PALETTE_ACTIONS,
  PALETTE_GROUP_HEADINGS,
  buildActionCommands,
  buildCommandGroups,
  buildJumpCommands,
  buildRecentCommands,
  parseCommandQuery,
} from '../src/app/components/shell/commandPaletteModel';
import {
  OPEN_ACTION_IDS,
  OPEN_ACTION_PARAM,
  openActionHref,
} from '../src/app/components/shell/openActions';
import {
  PLATFORM_NAV_GROUPS,
  PLATFORM_USER_MENU_ITEMS,
  getPlatformNavGroups,
  platformNavGatedReason,
} from '../lib/platform-nav';
import { PLATFORM_NAV_ICONS } from '../lib/platform-nav-icons';
import type { CommandPaletteRecent } from '../src/app/components/shell/commandPaletteRecents';

/** A session with a workspace. */
const TENANT = 't-1';

/** Every first-party destination the model describes, flattened. */
const MODEL_ITEMS = [
  ...PLATFORM_NAV_GROUPS.flatMap((group) => group.items),
  ...PLATFORM_USER_MENU_ITEMS,
];

/** Two recents, oldest last, as the store hands them over. */
const RECENTS: CommandPaletteRecent[] = [
  {
    id: 'proj-1',
    label: 'Payments API',
    href: '/ade/dashboard/projects/1',
    meta: 'v2.4.0 · draft',
    icon: 'file-json-2',
    at: 2,
  },
  { id: 'proj-2', label: 'Orders Service', href: '/ade/dashboard/projects/2', at: 1 },
];

describe('Jump to — the navigation model, and only it', () => {
  it('offers every destination the model describes, rail groups and user menu alike', () => {
    const commands = buildJumpCommands(getPlatformNavGroups({ currentTenantId: TENANT }), TENANT);

    expect(commands.map((command) => command.label).sort()).toEqual(
      MODEL_ITEMS.map((item) => item.label).sort()
    );
    for (const command of commands) {
      expect(command.group).toBe('jump');
      expect(command.href).toBeTruthy();
    }
  });

  it('files each destination under the section it lives in, so the section is searchable', () => {
    const commands = buildJumpCommands(getPlatformNavGroups({ currentTenantId: TENANT }), TENANT);

    // A labelled group's items carry its heading; the unlabelled leading group reads "Home".
    const catalog = commands.find((command) => command.label === 'Catalog')!;
    expect(catalog.meta).toBe('Bring in');
    expect(catalog.keywords).toEqual(['Catalog', 'Bring in']);

    const home = commands.find((command) => command.label === 'Home')!;
    expect(home.meta).toBe('Home');

    // Account destinations are user-menu rows in the rail; in the palette they are just
    // destinations, because a reader typing "profile" does not know which menu owns it.
    const profile = commands.find((command) => command.label === 'Profile')!;
    expect(profile.meta).toBe('Account');
  });

  it('names an icon the shared resolver knows, for every row it draws', () => {
    const commands = [
      ...buildJumpCommands(getPlatformNavGroups({ currentTenantId: TENANT }), TENANT),
      ...buildActionCommands(TENANT),
      ...buildRecentCommands(RECENTS),
    ];

    for (const command of commands) {
      expect(PLATFORM_NAV_ICONS[command.icon]).toBeDefined();
    }
  });

  it('disables exactly the destinations the rail disables, in the rail\u2019s words', () => {
    const commands = buildJumpCommands(getPlatformNavGroups({ currentTenantId: null }), null);
    const gated = MODEL_ITEMS.filter((item) => item.requiresTenant);

    expect(gated.length).toBeGreaterThan(0);
    for (const item of gated) {
      const command = commands.find((entry) => entry.label === item.label)!;
      expect(command.disabled).toBe(true);
      expect(command.disabledReason).toBe(platformNavGatedReason(item.label));
      // The reason takes the meta line's place, so it is read rather than hidden in a title.
      expect(command.meta).toBe(command.disabledReason);
    }

    for (const item of MODEL_ITEMS.filter((entry) => !entry.requiresTenant)) {
      expect(commands.find((entry) => entry.label === item.label)!.disabled).toBe(false);
    }
  });

  it('carries a contributed commercial destination through, gating and all', () => {
    const groups = getPlatformNavGroups({
      currentTenantId: TENANT,
      injected: [
        {
          group: 'build',
          item: { id: 'suite', label: 'Designer', href: 'https://suite.example/x', icon: 'box' },
        },
      ],
    });

    const designer = buildJumpCommands(groups, TENANT).find(
      (command) => command.label === 'Designer'
    )!;
    expect(designer.href).toBe('https://suite.example/x');
    expect(designer.meta).toBe('Build');
  });
});

describe('Actions — what a reader can start from anywhere', () => {
  it('offers the four DESIGN.md §5.4 actions, each with somewhere to go or something to do', () => {
    const commands = buildActionCommands(TENANT);

    expect(commands.map((command) => command.label)).toEqual([
      'New project…',
      'Import a spec…',
      'Create API key…',
      'Change theme…',
    ]);
    for (const command of commands) {
      expect(command.group).toBe('action');
      // Exactly one of the two: a row that neither goes anywhere nor does anything is dead.
      expect(Boolean(command.href) !== Boolean(command.run)).toBe(true);
    }
  });

  it('deep-links to the page that owns each dialog, naming an action that page answers', () => {
    const withHrefs = PALETTE_ACTIONS.filter((action) => action.href);
    expect(withHrefs.length).toBe(3);

    for (const action of withHrefs) {
      const url = new URL(action.href!, 'https://apiome.test');
      const requested = url.searchParams.get(OPEN_ACTION_PARAM);
      expect(OPEN_ACTION_IDS).toContain(requested);
      expect(url.pathname.startsWith('/ade/dashboard/')).toBe(true);
    }
  });

  it('gates a workspace-scoped action exactly as the rail gates a destination', () => {
    const gated = buildActionCommands(null);
    const themes = gated.find((command) => command.label === 'Change theme…')!;

    expect(themes.disabled).toBe(false); // the theme is the reader's, not the workspace's
    for (const command of gated.filter((entry) => entry !== themes)) {
      expect(command.disabled).toBe(true);
      expect(command.disabledReason).toBe(platformNavGatedReason(command.label));
    }
  });
});

describe('Recent \u2014 this workspace\u2019s history', () => {
  it('draws what the store holds, in the order it hands it over', () => {
    const commands = buildRecentCommands(RECENTS);

    expect(commands.map((command) => command.label)).toEqual(['Payments API', 'Orders Service']);
    expect(commands[0].meta).toBe('v2.4.0 · draft');
    expect(commands[0].icon).toBe('file-json-2');
    // A recent with no icon of its own still draws something.
    expect(commands[1].icon).toBe('clock');
    expect(commands.every((command) => command.disabled)).toBe(false);
  });
});

describe('the groups, assembled', () => {
  it('puts history first, then destinations, then actions', () => {
    const groups = buildCommandGroups({
      navGroups: getPlatformNavGroups({ currentTenantId: TENANT }),
      recents: RECENTS,
      currentTenantId: TENANT,
    });

    expect(groups.map((group) => group.heading)).toEqual([
      PALETTE_GROUP_HEADINGS.recent,
      PALETTE_GROUP_HEADINGS.jump,
      PALETTE_GROUP_HEADINGS.action,
    ]);
  });

  it('omits a group with nothing in it rather than drawing an empty heading', () => {
    const groups = buildCommandGroups({
      navGroups: getPlatformNavGroups({ currentTenantId: TENANT }),
      currentTenantId: TENANT,
    });

    expect(groups.map((group) => group.id)).toEqual(['jump', 'action']);
  });

  it('shows commands only, not commands first, when the reader types >', () => {
    const groups = buildCommandGroups({
      navGroups: getPlatformNavGroups({ currentTenantId: TENANT }),
      recents: RECENTS,
      currentTenantId: TENANT,
      commandsOnly: true,
    });

    expect(groups.map((group) => group.id)).toEqual(['action']);
  });

  it('gives every row an id unique across the whole palette', () => {
    const ids = buildCommandGroups({
      navGroups: getPlatformNavGroups({ currentTenantId: TENANT }),
      recents: RECENTS,
      currentTenantId: TENANT,
    }).flatMap((group) => group.commands.map((command) => command.id));

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the query', () => {
  it.each([
    ['projects', false, 'projects'],
    ['  projects  ', false, 'projects'],
    ['', false, ''],
  ])('reads %j as a plain search', (raw, commandsOnly, search) => {
    expect(parseCommandQuery(raw)).toEqual({ commandsOnly, search });
  });

  it.each([
    [COMMANDS_ONLY_PREFIX, ''],
    ['>theme', 'theme'],
    ['> theme', 'theme'],
    ['  >  theme  ', 'theme'],
  ])('reads %j as commands only', (raw, search) => {
    expect(parseCommandQuery(raw)).toEqual({ commandsOnly: true, search });
  });

  it('leaves a bare prefix with nothing to filter by, so the commands stay visible', () => {
    // Were the `>` kept as the search term, every command would score zero against it and
    // the mode would reveal an empty list.
    expect(parseCommandQuery('>').search).toBe('');
  });
});

describe('openActionHref', () => {
  it('appends the request to a clean route', () => {
    expect(openActionHref('/ade/dashboard/projects', 'new-project')).toBe(
      '/ade/dashboard/projects?open=new-project'
    );
  });
});
