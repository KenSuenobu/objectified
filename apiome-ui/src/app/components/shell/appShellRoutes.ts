/**
 * Which routes render inside {@link AppShell} (HIVE-3.1, #5287).
 *
 * The Hive shell is "one chrome": a route inside it has a rail and nothing above the page,
 * so anything that draws a second chrome — today `ConditionalHeader` and its `TopHeader` —
 * has to know where the shell is in force. Keeping that answer in one module is what stops
 * the two systems double-rendering while the redesign migrates surface by surface
 * (`DESIGN.md` §5.1; the retirement itself is HIVE-3.8, #5294).
 *
 * The list grows as each surface migrates: `/ade/database` and `/ade/migration` (Tools)
 * still use `SidebarShell` beneath the old header and are deliberately absent.
 */

/** Route prefixes whose pages are wrapped in the Hive `AppShell`. */
export const APP_SHELL_ROUTE_PREFIXES: readonly string[] = ['/ade/dashboard'];

/**
 * The launcher: `/ade` itself has never drawn the top header and has no rail either — it
 * is the full-bleed "All apps" surface the rail's brand links back to.
 */
export const LAUNCHER_ROUTE = '/ade';

/**
 * Does this pathname render inside the Hive application shell?
 *
 * @param pathname Current `usePathname()` value; `null` before hydration on some routes.
 * @returns True when the route (or a descendant of it) is wrapped in `AppShell`.
 */
export function isAppShellRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return APP_SHELL_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Does this pathname draw its own chrome, leaving no room for the legacy top header?
 *
 * Both the launcher and every shell route answer yes — the first because it is its own
 * chrome, the second because the rail is.
 *
 * @param pathname Current `usePathname()` value.
 * @returns True when `TopHeader` must not render.
 */
export function suppressesTopHeader(pathname: string | null | undefined): boolean {
  return pathname === LAUNCHER_ROUTE || isAppShellRoute(pathname);
}
