/**
 * GitHub/GitLab verified-email parity (OLO-2.5, #4197).
 *
 * The OLO-1.3 engine only trusts an email the provider *proved* is verified
 * (`resolveOAuthEmailVerified` reads `email_verified` off the raw OAuth profile). Neither
 * provider's REST profile carries that claim natively, so this module normalizes each
 * provider's own verified-email signal onto the profile during the userinfo exchange:
 *
 *   - **GitHub** — the `/user` profile email is the *public* email and may be null (or an
 *     address the user never verified). With the `user:email` scope, `/user/emails` lists
 *     every address with `primary`/`verified` flags. When the profile email is null we adopt
 *     the primary address from that list; either way `email_verified` is true only when the
 *     address in use is backed by a `verified: true` entry.
 *   - **GitLab** — with the `read_user` scope, `/api/v4/user` returns the account's primary
 *     email plus `confirmed_at` (set once the user completed email confirmation; GitLab only
 *     promotes confirmed addresses to primary). `email_verified` is true only when both are
 *     present.
 *
 * Everything fails closed: an unreachable emails API, a malformed body, or a missing signal
 * resolves to unverified, which the engine classifies under OLO-1.3 rule 4 (structured
 * `UNVERIFIED_EMAIL` rejection) — never as a distinct account and never as trusted.
 *
 * Server-only helpers; the provider wiring that calls them lives in `better-auth-oauth-providers.ts`.
 */

/** GitHub OAuth scopes: profile read plus the emails API (OLO-2.5). */
export const GITHUB_OAUTH_SCOPE = 'read:user user:email';

/** GitLab OAuth scope: read-only user profile including primary email + `confirmed_at`. */
export const GITLAB_OAUTH_SCOPE = 'read_user';

/** The GitHub emails endpoint unlocked by the `user:email` scope (production default). */
export const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

/** Remove a single trailing slash so `${base}/path` never doubles the separator. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Base URL of the GitHub REST API (`/user`, `/user/emails`). Overridable via
 * `GITHUB_API_BASE_URL` for the mocked-provider e2e journey (OLO-7.4); defaults to the
 * real host.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The base URL without a trailing slash.
 */
export function githubApiBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const raw = env.GITHUB_API_BASE_URL;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return stripTrailingSlash(trimmed.length > 0 ? trimmed : 'https://api.github.com');
}

/**
 * Base URL of the GitLab instance (`/oauth/*`, `/api/v4/user`). Overridable via
 * `GITLAB_BASE_URL` for the mocked-provider e2e journey (OLO-7.4); defaults to gitlab.com.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The base URL without a trailing slash.
 */
export function gitlabBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const raw = env.GITLAB_BASE_URL;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return stripTrailingSlash(trimmed.length > 0 ? trimmed : 'https://gitlab.com');
}

/**
 * The GitHub emails endpoint this deployment should call: the production constant unless
 * `GITHUB_API_BASE_URL` points the API at a mock (OLO-7.4).
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The absolute `/user/emails` URL.
 */
export function githubEmailsUrl(
  env: Record<string, string | undefined> = process.env
): string {
  return `${githubApiBaseUrl(env)}/user/emails`;
}

/** One entry of the GitHub `/user/emails` response. */
export interface GithubEmailEntry {
  email: string;
  primary?: boolean;
  verified?: boolean;
  visibility?: string | null;
}

/** The email the sign-in should use and whether the provider proved it verified. */
export interface VerifiedEmailResolution {
  email: string | null;
  emailVerified: boolean;
}

/**
 * Minimal slice of the userinfo request context these hooks need: an openid-client instance able to
 * perform the userinfo exchange, and the token set. (The `{ client, tokens }` shape originated with
 * next-auth's userinfo request; the Better Auth provider hooks pass the same slice.)
 */
export interface UserinfoContext {
  client: { userinfo: (accessToken: string) => Promise<Record<string, unknown>> };
  tokens: { access_token?: string };
}

/** Minimal fetch shape, injectable so tests never touch the network. */
type FetchLike = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Canonical comparison form of an address: trimmed and lower-cased (mirrors OLO-1.1). */
function canonical(email: string): string {
  return email.trim().toLowerCase();
}

/** Keep only entries that actually carry an address; the rest prove nothing. */
function usableEntries(entries: GithubEmailEntry[] | null): GithubEmailEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is GithubEmailEntry =>
      !!entry && typeof entry.email === 'string' && entry.email.trim().length > 0
  );
}

/**
 * Fetch the authenticated user's email list from GitHub. Fail-soft: any transport error,
 * non-2xx response, or non-array body yields null (the caller then resolves to unverified —
 * never a crash of the whole sign-in round trip).
 *
 * @param accessToken The OAuth access token from the token exchange.
 * @param fetchImpl Fetch implementation (injectable for tests; defaults to global fetch).
 * @returns The raw email entries, or null when the list could not be retrieved.
 */
export async function fetchGithubEmailEntries(
  accessToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<GithubEmailEntry[] | null> {
  try {
    const res = await fetchImpl(githubEmailsUrl(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body) ? (body as GithubEmailEntry[]) : null;
  } catch {
    return null;
  }
}

/**
 * Decide the GitHub sign-in email and its verified status from the profile email and the
 * `/user/emails` list:
 *
 *   - Profile email present → keep it; verified only when the list contains that address
 *     with `verified: true` (a public email is not inherently verified).
 *   - Profile email null → adopt the primary address from the list; verified only when that
 *     entry is `verified: true` (an unverified primary still surfaces the address so the
 *     engine rejects it as UNVERIFIED_EMAIL rather than "no email").
 *   - No usable list (API failure) → keep the profile email, unverified.
 *
 * @param profileEmail The (public) email from the GitHub `/user` profile, or null.
 * @param entries The `/user/emails` response, or null when unavailable.
 * @returns The address to use and whether GitHub proved it verified.
 */
export function resolveGithubVerifiedEmail(
  profileEmail: string | null,
  entries: GithubEmailEntry[] | null
): VerifiedEmailResolution {
  const usable = usableEntries(entries);

  if (typeof profileEmail === 'string' && profileEmail.trim().length > 0) {
    const match = usable.find((entry) => canonical(entry.email) === canonical(profileEmail));
    return { email: profileEmail, emailVerified: match?.verified === true };
  }

  const primary = usable.find((entry) => entry.primary === true);
  if (primary) {
    return { email: primary.email, emailVerified: primary.verified === true };
  }

  return { email: null, emailVerified: false };
}

/**
 * Whether GitLab proved the profile's primary email is verified: the `/api/v4/user`
 * response must carry both the email and a non-empty `confirmed_at` timestamp.
 *
 * @param profile The raw GitLab userinfo response.
 * @returns True only when the confirmed-email evidence is present.
 */
export function resolveGitlabEmailVerified(profile: unknown): boolean {
  const record = profile as Record<string, unknown> | null | undefined;
  const email = record?.email;
  const confirmedAt = record?.confirmed_at;
  return (
    typeof email === 'string' &&
    email.trim().length > 0 &&
    typeof confirmedAt === 'string' &&
    confirmedAt.trim().length > 0
  );
}

/**
 * NextAuth userinfo hook for GitHub: perform the standard `/user` exchange, consult
 * `/user/emails`, and stamp the resolved address + `email_verified` onto the raw profile
 * (the object the signIn callback, and therefore `resolveOAuthEmailVerified`, receives).
 *
 * @param context userinfo request context ({ client, tokens }).
 * @param fetchImpl Fetch implementation for the emails API (injectable for tests).
 * @returns The raw GitHub profile with `email`/`email_verified` normalized.
 */
export async function githubUserinfoRequest(
  context: UserinfoContext,
  fetchImpl?: FetchLike
): Promise<Record<string, unknown>> {
  const accessToken = context.tokens.access_token ?? '';
  const profile = await context.client.userinfo(accessToken);
  const entries = await fetchGithubEmailEntries(accessToken, fetchImpl);
  const resolution = resolveGithubVerifiedEmail(
    typeof profile.email === 'string' ? profile.email : null,
    entries
  );
  profile.email = resolution.email;
  profile.email_verified = resolution.emailVerified;
  return profile;
}

/**
 * NextAuth userinfo hook for GitLab: perform the standard `/api/v4/user` exchange and stamp
 * `email_verified` from the `confirmed_at` evidence onto the raw profile.
 *
 * @param context userinfo request context ({ client, tokens }).
 * @returns The raw GitLab profile with `email_verified` normalized.
 */
export async function gitlabUserinfoRequest(
  context: UserinfoContext
): Promise<Record<string, unknown>> {
  const profile = await context.client.userinfo(context.tokens.access_token ?? '');
  profile.email_verified = resolveGitlabEmailVerified(profile);
  return profile;
}
