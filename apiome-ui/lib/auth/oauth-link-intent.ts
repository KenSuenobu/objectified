/**
 * OAuth account-link intent cookie (OLO-2.4).
 *
 * When a signed-in user clicks "Link {provider}" in the linked-accounts panel, a one-shot
 * `oauth_link_intent` cookie is written carrying `{ provider, userId, timestamp }`. The OAuth callback
 * then reads it here to distinguish an explicit *link* action from an ordinary sign-in, so the resolved
 * identity is bound to the already-signed-in user rather than starting a fresh session.
 *
 * The cookie is single-use and short-lived: reading it deletes it, and an intent older than the TTL is
 * ignored. Everything fails soft — a missing/corrupt cookie or an unavailable cookie store yields
 * `null` (a normal sign-in), never an error.
 *
 * This reader was extracted from the NextAuth `credentials.ts` at the OLO-10.14 cutover; the Better
 * Auth OAuth provider set consumes it from `better-auth-oauth-providers.ts` (`resolveLinkIntentUserId`).
 */

/** Cookie name carrying the one-shot link intent. */
const OAUTH_LINK_INTENT_COOKIE = 'oauth_link_intent';

/** Link intents older than this (ms) are treated as expired. */
const LINK_INTENT_TTL_MS = 600000;

/** The decoded link-intent payload written by the "Link {provider}" action. */
export interface OAuthLinkIntent {
  /** Provider slug the user chose to link (e.g. `github`). */
  provider: string;
  /** The signed-in user the new identity should bind to. */
  userId: string;
  /** Epoch ms the intent was written; used to expire stale intents. */
  timestamp: number;
}

/**
 * Read (and consume) the one-shot `oauth_link_intent` cookie.
 *
 * @returns The decoded, non-expired intent, or `null` when there is none (or on any error).
 */
export const checkLinkingIntent = async (): Promise<OAuthLinkIntent | null> => {
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const linkIntent = cookieStore.get(OAUTH_LINK_INTENT_COOKIE);

    if (linkIntent && linkIntent.value) {
      try {
        const intent = JSON.parse(linkIntent.value) as OAuthLinkIntent;
        if (Date.now() - intent.timestamp < LINK_INTENT_TTL_MS) {
          cookieStore.delete(OAUTH_LINK_INTENT_COOKIE);
          return intent;
        }
        cookieStore.delete(OAUTH_LINK_INTENT_COOKIE);
      } catch {
        cookieStore.delete(OAUTH_LINK_INTENT_COOKIE);
      }
    }
  } catch {
    // Cookie store unavailable; treat as no intent.
  }

  return null;
};
