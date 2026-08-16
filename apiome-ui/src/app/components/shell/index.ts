/**
 * The Hive application shell (HIVE-3.1, #5287).
 *
 * `AdeAppShell` is what a route group mounts; `AppShell` is the shell itself, for a surface
 * with its own session plumbing (the admin console, a commercial host). Every rail region
 * is filled: HIVE-3.3's `WorkspaceSwitcher`, HIVE-3.6's `RailSearchTrigger` and HIVE-3.4's
 * `RailFooter`.
 *
 * `Page` / `PageHeader` / `PageBody` (HIVE-3.5) are what a *page* inside that shell is made
 * of, rather than parts of the shell itself: the page epics (5–9) compose the three instead
 * of hand-rolling a header bar each.
 */
export { default as AppShell } from './AppShell';
export type { AppShellProps, RailRegion, RailRegionContext } from './AppShell';
export { default as AdeAppShell } from './AdeAppShell';
export type { AdeAppShellProps } from './AdeAppShell';
export { default as PageHeader } from './PageHeader';
export type { PageBreadcrumbItem, PageHeaderProps } from './PageHeader';
export { Page, PageBody } from './pageChrome';
export type { PageBodyProps, PageProps, PageWidth } from './pageChrome';
export { default as RailNav } from './RailNav';
export type { RailNavProps } from './RailNav';
export { default as RailFooter } from './RailFooter';
export type { RailFooterProps } from './RailFooter';
export { default as RailSearchTrigger } from './RailSearchTrigger';
export type { RailSearchTriggerProps } from './RailSearchTrigger';
export { default as CommandPalette } from './CommandPalette';
export type { CommandPaletteProps } from './CommandPalette';
export { default as CommandPaletteHost } from './CommandPaletteHost';
export type { CommandPaletteHostProps } from './CommandPaletteHost';
export {
  isCommandPaletteMounted,
  openCommandPalette,
  registerCommandPaletteHost,
  subscribeCommandPalette,
} from './commandPaletteBus';
export type { CommandPaletteRequest } from './commandPaletteBus';
export {
  COMMANDS_ONLY_PREFIX,
  PALETTE_ACTIONS,
  PALETTE_GROUP_HEADINGS,
  buildActionCommands,
  buildCommandGroups,
  buildJumpCommands,
  buildRecentCommands,
  parseCommandQuery,
} from './commandPaletteModel';
export type {
  CommandGroupsOptions,
  PaletteCommand,
  PaletteCommandGroup,
  PaletteCommandGroupId,
  ParsedCommandQuery,
} from './commandPaletteModel';
export {
  PALETTE_RECENTS_LIMIT,
  PALETTE_RECENTS_STORAGE_KEY,
  clearCommandPaletteRecents,
  readCommandPaletteRecents,
  recordCommandPaletteRecent,
  useCommandPaletteRecents,
} from './commandPaletteRecents';
export type { CommandPaletteRecent, CommandPaletteRecents } from './commandPaletteRecents';
export {
  OPEN_ACTION_IDS,
  OPEN_ACTION_PARAM,
  OPEN_ACTIONS,
  openActionHref,
  useOpenAction,
} from './openActions';
export type { OpenAction } from './openActions';
export { default as UserMenu } from './UserMenu';
export type { UserMenuProps } from './UserMenu';
export { default as WorkspaceSwitcher, formatWorkspaceMeta, WORKSPACE_ROLE_TONE } from './WorkspaceSwitcher';
export type { WorkspaceSwitcherProps } from './WorkspaceSwitcher';
export { RAIL_ITEM_CLASS, RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';
export type { RailTooltipProps } from './railChrome';
export {
  RAIL_MENU_ABOVE_CLASS,
  RAIL_MENU_ITEM_CLASS,
  RAIL_MENU_ITEM_DISABLED_CLASS,
  RAIL_MENU_LABEL_CLASS,
  RAIL_MENU_SEPARATOR_CLASS,
  RAIL_MENU_SURFACE_CLASS,
  useRailMenu,
} from './railMenu';
export type { RailMenu, RailMenuOptions } from './railMenu';
export { RAIL_ICON_BREAKPOINT_PX, useIconRail } from './useIconRail';
export {
  NAV_COLLAPSED_STORAGE_KEY,
  readCollapsedNavGroups,
  toggleCollapsedNavGroup,
  writeCollapsedNavGroups,
} from './navGroupCollapse';
export {
  ADMIN_CONSOLE_ROUTE,
  APP_SHELL_ROUTE_PREFIXES,
  HELP_ROUTE,
  LAUNCHER_ROUTE,
  isAppShellRoute,
  suppressesTopHeader,
} from './appShellRoutes';
export {
  WHATS_NEW_SEEN_STORAGE_KEY,
  hasUnreadWhatsNew,
  markWhatsNewSeen,
  readLastSeenWhatsNew,
  useWhatsNewUnread,
} from './whatsNewSeen';
export type { WhatsNewUnread } from './whatsNewSeen';
