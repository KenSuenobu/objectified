/**
 * apiome-ui middleware
 *
 * Single chokepoint that disables git-like API routes when
 * `FEATURE_GITLIKE` is off. The corresponding UI is already gated, so this
 * layer exists to ensure that direct fetches (or any straggling caller we
 * missed) cannot trigger commit / publish / branch / merge / rollback /
 * tag / change-report flows.
 *
 * - When `FEATURE_GITLIKE === true`: pass-through.
 * - When `FEATURE_GITLIKE === false`: respond `404 Not Found` for any
 *   git-like API path. Read-only and non-git-like routes (auth, classes,
 *   properties, paths, primitives, snapshot, sso, projects, migrations,
 *   `GET /api/versions`, `GET|PUT /api/versions/[id]`, sunset-timeline,
 *   etc.) are passed through unchanged.
 *
 * To re-enable git-like APIs, flip `FEATURE_GITLIKE` in `lib/feature-flags.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { FEATURE_GITLIKE } from '@lib/feature-flags';
import { isGitlikePath } from '@lib/gitlike-route-guard';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next();

  if (FEATURE_GITLIKE) {
    return response;
  }

  const { pathname } = request.nextUrl;
  if (!pathname.startsWith('/api/')) {
    return response;
  }

  if (isGitlikePath(pathname, request.method.toUpperCase())) {
    return NextResponse.json(
      {
        success: false,
        error: 'Not found',
        detail: 'Git-like features are disabled in this build.',
      },
      { status: 404 }
    );
  }

  return response;
}

/**
 * Run on pages and API routes so the git-like route guard covers direct API
 * fetches. Static assets are excluded. (Next.js requires `matcher` to be
 * statically analyzable.)
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
