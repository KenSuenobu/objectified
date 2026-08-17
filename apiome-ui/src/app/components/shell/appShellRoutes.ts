/**
 * The handful of routes the Hive shell names rather than renders (HIVE-3.1, #5287).
 *
 * This module used to answer a second question — *where is the shell in force?* — because two
 * chromes existed at once and `ConditionalHeader` had to keep the pre-Hive `TopHeader` off any
 * route the rail had already reached. HIVE-3.8 (#5294) retired that header, and with it the
 * predicate: every `/ade/**` route but the launcher now renders inside `AppShell`, so there is
 * nothing left to ask. What remains are the destinations the rail and its menus link *to*,
 * kept here so a path is written once (`DESIGN.md` §5.1–5.2).
 */

/**
 * The launcher: `/ade` itself has never drawn a top bar and has no rail either — it is the
 * full-bleed "All apps" surface the rail's brand links back to.
 */
export const LAUNCHER_ROUTE = '/ade';

/**
 * The admin console (HIVE-3.4, #5290).
 *
 * Listed in the rail's user menu for *every* reader, not only administrators: the route
 * gates itself (`/admin` redirects to its own sign-in when the admin session is absent),
 * and hiding the entry is what left "type the URL" as the only way anyone discovered it.
 * It opens in this tab but leaves the Hive chrome, which is why the row is marked ↗.
 */
export const ADMIN_CONSOLE_ROUTE = '/admin';

/**
 * Help & docs, the rail footer's first row (`DESIGN.md` §5.2 region 5).
 *
 * The page itself is **HIVE-4.9 (#5303)** — its acceptance criteria include "the rail's
 * Help & docs link resolves to a real page". Until it lands the row points at a route
 * Next.js answers with the app's not-found page.
 */
export const HELP_ROUTE = '/ade/dashboard/help';
