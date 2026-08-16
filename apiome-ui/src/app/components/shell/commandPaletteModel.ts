import {
  PLATFORM_USER_MENU_ITEMS,
  platformNavGatedReason,
  type ResolvedPlatformNavGroup,
} from '@lib/platform-nav';
import { openPreferences } from '@/app/components/ade/preferences/preferencesDrawerBus';
import { OPEN_ACTIONS, openActionHref } from './openActions';
import type { CommandPaletteRecent } from './commandPaletteRecents';

/**
 * What the command palette can offer, as data (HIVE-3.6, #5292; `DESIGN.md` §5.4).
 *
 * `CommandPalette.tsx` draws a dialog; this decides what is in it. The split is the same
 * one `lib/platform-nav.ts` makes for the rail, and for the same reason: the interesting
 * questions — which destination is gated and why, what `>` means, what "Recent" contains —
 * are answerable without a DOM, so they are tested without one.
 *
 * ### The three groups
 *
 * | Group | Source | Gated by |
 * | --- | --- | --- |
 * | **Jump to** | the HIVE-3.2 nav model, already resolved for the session | the model |
 * | **Actions** | {@link PALETTE_ACTIONS}, declared here | `requiresTenant` |
 * | **Recent** | `commandPaletteRecents.ts`, per workspace | nothing — it is history |
 *
 * Nothing in Jump to is written down twice: the palette is handed the *same*
 * `ResolvedPlatformNavGroup[]` the rail draws, so a destination that arrives from a
 * commercial host (or leaves) is in both surfaces at once, and a workspace-gated row is
 * disabled in the palette for exactly the reason the rail says it is.
 */

/** Which group a command belongs to. */
export type PaletteCommandGroupId = 'jump' | 'action' | 'recent';

/** A single row of the palette. */
export interface PaletteCommand {
  /** Stable id — the React key, the cmdk value and the recents key. Unique across groups. */
  id: string;
  /** Which group draws it. */
  group: PaletteCommandGroupId;
  /** The row's own words. */
  label: string;
  /** The quiet second line: the section a destination lives in, or a version and state. */
  meta?: string;
  /** Lucide icon name, resolved by `lib/platform-nav-icons.ts`. */
  icon: string;
  /** Where the row goes. Exactly one of `href` and `run` is set. */
  href?: string;
  /** What the row does in place — opening another overlay, say. */
  run?: () => void;
  /** A shortcut chip for the row, when the chord exists elsewhere in the app. */
  keys?: readonly string[];
  /** True when the row must render non-interactive. */
  disabled: boolean;
  /** Why it is disabled — shown in place of the meta line, so the reason is never hidden. */
  disabledReason?: string;
  /** Extra words the fuzzy filter scores against: the title *and* the section. */
  keywords: readonly string[];
}

/** A headed run of commands. */
export interface PaletteCommandGroup {
  id: PaletteCommandGroupId;
  /** The heading, in the sentence case `DESIGN.md` §10 asks for. */
  heading: string;
  commands: readonly PaletteCommand[];
}

/** Headings, in the order `DESIGN.md` §5.4 lists the groups. */
export const PALETTE_GROUP_HEADINGS: Readonly<Record<PaletteCommandGroupId, string>> = {
  jump: 'Jump to',
  action: 'Actions',
  recent: 'Recent',
};

/** The section a user-menu destination is filed under in the palette. */
const ACCOUNT_SECTION = 'Account';

/** The section the unlabelled leading nav group (Home) is filed under. */
const HOME_SECTION = 'Home';

/* -------------------------------------------------------------------------
   Actions
   ------------------------------------------------------------------------- */

/**
 * An action before the session has decided whether it is available.
 *
 * `href` and `run` are the two kinds of action there are: one goes somewhere and completes
 * there, the other happens where the reader already is. "Change theme…" is the second kind
 * — it opens the preferences pane over whatever page is behind the palette, which is why
 * the palette does not need a theme picker of its own.
 */
interface PaletteActionDefinition {
  id: string;
  label: string;
  icon: string;
  href?: string;
  run?: () => void;
  keys?: readonly string[];
  /** True when the action is meaningless without a selected workspace. */
  requiresTenant?: boolean;
}

/** The dashboard routes the actions land on. */
const PROJECTS_ROUTE = '/ade/dashboard/projects';
const API_KEYS_ROUTE = '/ade/dashboard/api-keys';

/**
 * The Actions group, as `DESIGN.md` §5.4 and the mockup's palette list it.
 *
 * The first three are deep links rather than dialogs the palette owns: the create and
 * import flows are three long forms that belong to their pages, and a palette that carried
 * copies of them would be a second place for them to drift. `openActions.ts` is the seam —
 * the page opens its own dialog when it sees the parameter, so "New project…" from the
 * palette and "New project" from the toolbar are the same dialog with the same validation.
 *
 * The chips repeat the list shortcuts of `DESIGN.md` §8 (`N` new, `I` import), which
 * HIVE-3.7 (#5293) binds. They are printed here because the palette is where a reader goes
 * looking for what they can do — a chip beside the row is how the chord is discovered — and
 * `Kbd` renders them decoratively, so a chip for a chord that is not yet live promises
 * nothing an assistive technology will read out.
 */
export const PALETTE_ACTIONS: readonly PaletteActionDefinition[] = [
  {
    id: 'action-new-project',
    label: 'New project…',
    icon: 'plus',
    href: openActionHref(PROJECTS_ROUTE, OPEN_ACTIONS.newProject),
    keys: ['N'],
    requiresTenant: true,
  },
  {
    id: 'action-import-spec',
    label: 'Import a spec…',
    icon: 'upload',
    href: openActionHref(PROJECTS_ROUTE, OPEN_ACTIONS.importSpec),
    keys: ['I'],
    requiresTenant: true,
  },
  {
    id: 'action-new-api-key',
    label: 'Create API key…',
    icon: 'key-round',
    href: openActionHref(API_KEYS_ROUTE, OPEN_ACTIONS.newApiKey),
    requiresTenant: true,
  },
  {
    id: 'action-change-theme',
    label: 'Change theme…',
    icon: 'palette',
    // Not workspace-gated: the theme is the reader's, not the workspace's.
    run: () => openPreferences('appearance'),
    keys: ['⌘', ','],
  },
];

/* -------------------------------------------------------------------------
   Builders
   ------------------------------------------------------------------------- */

/**
 * The words the fuzzy filter scores a row against.
 *
 * `DESIGN.md` §5.4 asks for a match on **title + section**, so both are keywords and the
 * row's `value` — its id — carries neither. Typing `gov` finds Lint posture through its
 * section; typing `lint` finds it through its title.
 *
 * @param label The row's own words.
 * @param meta The section or subtitle, when it has one.
 * @returns Keywords, with empties dropped.
 */
function keywordsFor(label: string, meta?: string): string[] {
  return [label, meta].filter((word): word is string => Boolean(word && word.trim()));
}

/**
 * **Jump to** — every destination the session can reach.
 *
 * The rail's groups first, in rail order, then the account destinations the rail keeps in
 * its user menu (`PLATFORM_USER_MENU_ITEMS`): the palette is the one surface where those
 * two lists are the same kind of thing, because a reader typing "profile" does not know
 * which menu it lives in.
 *
 * @param groups Nav groups from `getPlatformNavGroups()`, gating already resolved.
 * @param currentTenantId The active workspace, for gating the account destinations.
 * @returns Jump-to commands, in model order.
 */
export function buildJumpCommands(
  groups: readonly ResolvedPlatformNavGroup[],
  currentTenantId?: string | null
): PaletteCommand[] {
  const fromRail = groups.flatMap((group) => {
    const section = group.label ?? HOME_SECTION;
    return group.items.map<PaletteCommand>((item) => ({
      id: `jump-${item.id}`,
      group: 'jump',
      label: item.label,
      meta: item.disabled ? item.disabledReason : section,
      icon: item.icon,
      href: item.href,
      disabled: item.disabled,
      disabledReason: item.disabledReason,
      keywords: keywordsFor(item.label, section),
    }));
  });

  const fromUserMenu = PLATFORM_USER_MENU_ITEMS.map<PaletteCommand>((item) => {
    const disabled = Boolean(item.requiresTenant) && !currentTenantId;
    return {
      id: `jump-${item.id}`,
      group: 'jump',
      label: item.label,
      meta: disabled ? platformNavGatedReason(item.label) : ACCOUNT_SECTION,
      icon: item.icon,
      href: item.href,
      disabled,
      disabledReason: disabled ? platformNavGatedReason(item.label) : undefined,
      keywords: keywordsFor(item.label, ACCOUNT_SECTION),
    };
  });

  return [...fromRail, ...fromUserMenu];
}

/**
 * **Actions** — the things a reader can start from anywhere.
 *
 * Gating is the rail's gating, word for word: an action that needs a workspace is disabled
 * with `platformNavGatedReason()`, so "Select a workspace to use New project…" is the same
 * sentence the rail would have shown for the page the action lands on. Disabled rather than
 * hidden, because a palette that silently omits what you searched for reads as broken.
 *
 * @param currentTenantId `current_tenant_id` from the session, if any.
 * @returns Action commands, in declaration order.
 */
export function buildActionCommands(currentTenantId?: string | null): PaletteCommand[] {
  return PALETTE_ACTIONS.map<PaletteCommand>((action) => {
    const disabled = Boolean(action.requiresTenant) && !currentTenantId;
    const reason = disabled ? platformNavGatedReason(action.label) : undefined;

    return {
      id: action.id,
      group: 'action',
      label: action.label,
      meta: reason,
      icon: action.icon,
      href: action.href,
      run: action.run,
      keys: action.keys,
      disabled,
      disabledReason: reason,
      keywords: keywordsFor(action.label, PALETTE_GROUP_HEADINGS.action),
    };
  });
}

/**
 * **Recent** — what this workspace last opened.
 *
 * Never gated: an entry is only ever recorded against the workspace it belongs to, so if it
 * is in the list the reader can reach it.
 *
 * @param recents Entries from `readCommandPaletteRecents()`, newest first.
 * @returns Recent commands, in the order they were given.
 */
export function buildRecentCommands(
  recents: readonly CommandPaletteRecent[]
): PaletteCommand[] {
  return recents.map<PaletteCommand>((recent) => ({
    id: `recent-${recent.id}`,
    group: 'recent',
    label: recent.label,
    meta: recent.meta,
    icon: recent.icon ?? 'clock',
    href: recent.href,
    disabled: false,
    keywords: keywordsFor(recent.label, recent.meta),
  }));
}

/** What {@link buildCommandGroups} needs to describe the palette for this session. */
export interface CommandGroupsOptions {
  /** Nav groups from `getPlatformNavGroups()`, gating already resolved. */
  navGroups: readonly ResolvedPlatformNavGroup[];
  /** This workspace's recent destinations, newest first. */
  recents?: readonly CommandPaletteRecent[];
  /** `current_tenant_id` from the session, if any. */
  currentTenantId?: string | null;
  /** True when only the Actions group should be offered — the reader typed `>`. */
  commandsOnly?: boolean;
}

/**
 * The palette's whole contents for one session.
 *
 * Recent comes first when there is one: the most likely reason to open a palette is to go
 * back to what you were just doing, and the mockup's own ordering (Jump to · Actions ·
 * Recent) describes a *first* visit, when there is no history to put above them.
 *
 * A group with no commands is omitted rather than drawn empty — an empty "Recent" heading
 * is a promise the palette cannot keep on a first visit.
 *
 * @param options See {@link CommandGroupsOptions}.
 * @returns The groups to render, in render order.
 */
export function buildCommandGroups({
  navGroups,
  recents = [],
  currentTenantId,
  commandsOnly = false,
}: CommandGroupsOptions): PaletteCommandGroup[] {
  const actions: PaletteCommandGroup = {
    id: 'action',
    heading: PALETTE_GROUP_HEADINGS.action,
    commands: buildActionCommands(currentTenantId),
  };

  // `>` means "commands only" (`DESIGN.md` §5.4): destinations and history are not
  // commands, so they are not narrowed — they are gone.
  if (commandsOnly) return [actions].filter((group) => group.commands.length > 0);

  const groups: PaletteCommandGroup[] = [
    {
      id: 'recent',
      heading: PALETTE_GROUP_HEADINGS.recent,
      commands: buildRecentCommands(recents),
    },
    {
      id: 'jump',
      heading: PALETTE_GROUP_HEADINGS.jump,
      commands: buildJumpCommands(navGroups, currentTenantId),
    },
    actions,
  ];

  return groups.filter((group) => group.commands.length > 0);
}

/* -------------------------------------------------------------------------
   The query
   ------------------------------------------------------------------------- */

/** The prefix that narrows the palette to commands (`DESIGN.md` §5.4). */
export const COMMANDS_ONLY_PREFIX = '>';

/** What the reader's typing means. */
export interface ParsedCommandQuery {
  /** True when the input begins with `>`. */
  commandsOnly: boolean;
  /** What is left to match on, with the prefix and the surrounding space removed. */
  search: string;
}

/**
 * Split a raw input value into its mode and its search term.
 *
 * A bare `>` is "show me the commands" with nothing to filter by, which is why the search
 * comes back empty rather than as `>` — otherwise the first keystroke of the mode would
 * filter every command away.
 *
 * @param raw The `Command.Input` value, as typed.
 * @returns The mode and the term — see {@link ParsedCommandQuery}.
 */
export function parseCommandQuery(raw: string): ParsedCommandQuery {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith(COMMANDS_ONLY_PREFIX)) {
    return { commandsOnly: false, search: raw.trim() };
  }
  return {
    commandsOnly: true,
    search: trimmed.slice(COMMANDS_ONLY_PREFIX.length).trim(),
  };
}
