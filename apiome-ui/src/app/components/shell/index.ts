/**
 * The Hive application shell (HIVE-3.1, #5287).
 *
 * `AdeAppShell` is what a route group mounts; `AppShell` is the shell itself, for a surface
 * with its own session plumbing (the admin console, a commercial host). Everything else
 * exported here is a seam the later shell tickets build on — HIVE-3.4's footer menu and
 * HIVE-3.6's search trigger each replace one region, and both open from `railMenu`'s chrome
 * the way HIVE-3.3's `WorkspaceSwitcher` does.
 */
export { default as AppShell } from './AppShell';
export type { AppShellProps, RailRegion, RailRegionContext } from './AppShell';
export { default as AdeAppShell } from './AdeAppShell';
export type { AdeAppShellProps } from './AdeAppShell';
export { default as RailNav } from './RailNav';
export type { RailNavProps } from './RailNav';
export { default as RailFooter } from './RailFooter';
export type { RailFooterProps } from './RailFooter';
export { default as WorkspaceSwitcher, formatWorkspaceMeta, WORKSPACE_ROLE_TONE } from './WorkspaceSwitcher';
export type { WorkspaceSwitcherProps } from './WorkspaceSwitcher';
export { RAIL_ITEM_CLASS, RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';
export type { RailTooltipProps } from './railChrome';
export {
  RAIL_MENU_ITEM_CLASS,
  RAIL_MENU_ITEM_DISABLED_CLASS,
  RAIL_MENU_LABEL_CLASS,
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
  APP_SHELL_ROUTE_PREFIXES,
  LAUNCHER_ROUTE,
  isAppShellRoute,
  suppressesTopHeader,
} from './appShellRoutes';
