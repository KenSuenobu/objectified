/**
 * Better Auth catch-all route for `/api/auth/*` (OLO-10.14 cutover, #5009).
 *
 * The Better Auth migration (docs/BETTER_AUTH_MIGRATION.md) ran NextAuth and Better Auth side by side
 * behind the `AUTH_ENGINE` flag; this ticket completes the cutover — NextAuth is removed and Better
 * Auth is now the only engine. The folder is `[...all]` (Better Auth's App Router convention); the URL
 * it serves is unchanged (`/api/auth/*`, matching `basePath: '/api/auth'` on the instance), so no
 * client/cookie path churn results from the rename off the legacy `[...nextauth]` folder.
 *
 * `betterAuthHandler` resolves the DB-over-env provider set per request (OLO-10.8) and dispatches on
 * method and path internally, so one function serves every Better Auth endpoint (GET and POST alike).
 */
import type { NextRequest } from 'next/server';
import { betterAuthHandler } from '../../../../../lib/auth/auth';

/**
 * Serve every `/api/auth/*` request through the Better Auth handler.
 *
 * @param req The incoming request from the Next.js App Router route.
 * @returns The Better Auth response for this request.
 */
function handler(req: NextRequest): Promise<Response> {
  return betterAuthHandler(req);
}

export { handler as GET, handler as POST };
