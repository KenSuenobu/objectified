/**
 * Account-resolution & auto-link engine (OLO-1.3, #4188).
 *
 * One server-side policy decides what happens when an OAuth identity arrives at the app,
 * shared by every NextAuth OAuth callback (and mirrored for parity on the REST side in
 * `apiome-rest/src/app/account_resolution.py`). The ordered policy is:
 *
 *   0. While signed in, "link another provider" attaches the identity to the session user
 *      regardless of the provider email (explicit user intent — matches the existing link route).
 *   a. Known `(provider, provider_user_id)` identity → sign in the user it is bound to.
 *   b. Else a **verified** provider email that matches an existing user → auto-link the identity
 *      to that user and sign in. This is the industry-accepted behaviour when the provider proves
 *      the email (the Auth.js `allowDangerousEmailAccountLinking` guidance); we implement it
 *      explicitly so the policy is provider-gated and auditable.
 *   c. Else a verified email with no matching user → create the account (routed through the
 *      pending-signup / onboarding flow).
 *   d. Unverified email → reject with the stable `unverified-email` code. Auto-linking or account
 *      creation on an unverified address is an account-takeover vector (nOAuth advisory).
 *
 * The pure decision function (`resolveAccountDecision`) contains no I/O so the full policy matrix
 * is property-testable; `resolveOAuthSignIn` gathers the facts and executes the decision through
 * an injectable store.
 *
 * This module must stay free of database imports — callers inject the store (see
 * `credentials.ts` for the production wiring).
 */

/**
 * Stable machine-readable auth error codes — the structured auth error contract (OLO-1.5, #4190).
 *
 * These strings are a public contract: every login failure rides the NextAuth error redirect as
 * `/login?error=<code>`, the login page maps each code to distinct guidance
 * (`src/app/login/auth-error-copy.ts`), and the REST side mirrors the same values in
 * `apiome-rest/src/app/account_resolution.py`. The full contract — meaning, emitter, and user
 * copy per code — is documented in `apiome-ui/docs/AUTH_ERROR_CODES.md`.
 *
 * Stability rule: never change or reuse an existing value; add a new code instead, and document
 * it. (`EMAIL_REQUIRED` / `PROFILE_INCOMPLETE` keep their pre-contract PascalCase values for
 * exactly this reason.)
 */
export const AUTH_ERROR_CODES = {
  /** The provider could not prove the email address is verified — never auto-link or sign up. */
  UNVERIFIED_EMAIL: 'unverified-email',
  /** The provider shared no email address at all (pre-contract login-page copy key). */
  EMAIL_REQUIRED: 'OAuthEmailRequired',
  /** The OAuth response carried no stable provider user id (pre-contract login-page copy key). */
  PROFILE_INCOMPLETE: 'OAuthProfileIncomplete',
  /** The resolved user account is disabled (or its identity points at a deleted user). */
  ACCOUNT_DISABLED: 'account-disabled',
  /** The resolved user account has not completed its own email verification. */
  ACCOUNT_NOT_VERIFIED: 'account-not-verified',
  /** The user already has a different identity linked for this provider. */
  PROVIDER_ALREADY_LINKED: 'provider-already-linked',
  /** This provider identity is already bound to a different user. */
  IDENTITY_LINKED_ELSEWHERE: 'identity-linked-elsewhere',
  /**
   * Unlink was refused because the identity is the user's last remaining sign-in method
   * (no other linked identity and no usable password). Emitted by `unlinkExternalAccount`
   * (`lib/db/helper.ts`) to guard against locking a user out of their own account (OLO-2.4).
   */
  LAST_SIGN_IN_METHOD: 'last-sign-in-method',
  /** The user's tenant membership is suspended (tenant_users.status = 'suspended'). */
  MEMBERSHIP_SUSPENDED: 'membership-suspended',
  /** The requested sign-in provider is not configured/supported on this deployment. */
  PROVIDER_NOT_CONFIGURED: 'provider-not-configured',
  /** Self-signup is disabled on this deployment (AUTH_SIGNUP_DISABLED). */
  SIGNUP_DISABLED: 'signup-disabled',
  /**
   * Generic sign-in failure with no user-actionable detail. Used by the NextAuth `signIn`
   * callback's defensive fallback when a provider yields no resolvable user, so the redirect
   * stays on-contract and does not leak an "account exists / not found" signal (OLO-7.3). Renders
   * the generic banner copy.
   */
  SIGN_IN_FAILED: 'sign-in-failed',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/**
 * Whether self-signup is disabled for this deployment (`AUTH_SIGNUP_DISABLED=true|1`).
 * When disabled, a verified email with no existing account is rejected with the stable
 * `signup-disabled` code instead of being routed to onboarding.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns True when the flag is explicitly set to `true` or `1`.
 */
export function isSignupDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.AUTH_SIGNUP_DISABLED;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/**
 * Providers whose `email_verified` evidence we accept for auto-link / account creation.
 *
 * The auto-link policy is deliberately provider-gated: a provider outside this set is treated as
 * unverified no matter what its profile claims. `azure` is pre-listed for OLO-2.x but its claims
 * are additionally subject to the nOAuth hardening rules (OLO-1.4) before `emailVerified` may be
 * set true. `google` (OLO-9.2) is trusted through the generic path: Google's id token carries a
 * native `email_verified` claim, and any Workspace-domain restriction is already enforced upstream
 * in the provider's profile callback (`google-workspace-domain.ts`). `okta` (OLO-9.3),
 * `aws` / Cognito (OLO-9.4), and `keycloak` (OLO-9.5) are likewise trusted through the generic
 * path: their id tokens carry a native `email_verified` claim.
 */
export const AUTO_LINK_TRUSTED_PROVIDERS: ReadonlySet<string> = new Set([
  'github',
  'gitlab',
  'azure',
  'google',
  'okta',
  'aws',
  'keycloak',
]);

/**
 * Providers an already-signed-in user may explicitly link via `api/auth/link/[provider]`
 * (OLO-2.2, #4194). This is the OAuth-provider vocabulary — `credentials` is a sign-in method,
 * not a linkable identity, and V181 pins the same slugs at the DB level. The link route refuses
 * any slug outside this set so a typo'd or unsupported provider never reaches the OAuth flow
 * with a linking-intent cookie already set. (OLO-2.3 will replace this with the provider
 * registry; keep the two sets aligned until then.)
 */
export const LINKABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'github',
  'gitlab',
  'azure',
  'google',
  'okta',
  'aws',
  'keycloak',
]);
/**
 * Canonicalize an email address to the stored/indexed form: trimmed and lower-cased.
 * Mirror of `normalize_email` in apiome-rest (OLO-1.1): case and surrounding whitespace never
 * distinguish two accounts.
 *
 * @param email Raw address from the provider profile (or null/undefined).
 * @returns The canonical address, or null when no usable address was supplied.
 */
export function canonicalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const canonical = email.trim().toLowerCase();
  return canonical.length > 0 ? canonical : null;
}

/**
 * Whether the provider proved the sign-in email is verified.
 *
 * OIDC providers (GitLab `openid`) expose a boolean/string `email_verified` claim on the profile;
 * we honour that. For GitHub/GitLab OAuth the verified-email parity pass (OLO-2.5, #4197)
 * normalizes each provider's own signal — GitHub's `/user/emails` verified flags, GitLab's
 * `confirmed_at` — onto the raw profile as `email_verified` during the userinfo exchange
 * (see `verified-email.ts`), so this resolver reads it uniformly. A profile without the claim
 * still resolves to unverified (false). Never assume verified — that is the account-takeover
 * default the epic forbids.
 *
 * The `azure` provider never goes through this resolver: Entra ID's email claim is subject to the
 * nOAuth hardening rules instead (see `resolveEntraEmailVerified`, OLO-1.4).
 */
export function resolveOAuthEmailVerified(profile: any, account: any): boolean {
  const raw = profile?.email_verified ?? account?.email_verified;
  if (raw === true) return true;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

/**
 * Tri-state reading of a boolean-ish token claim: `true` / `false` when the token explicitly
 * asserts the value (boolean, `"true"`/`"false"`, or the 0/1 forms Entra emits for optional
 * claims), `null` when the claim is absent or unrecognizable. The distinction matters because an
 * explicit `false` is stronger evidence than a missing claim — it must veto, not merely fail to
 * prove.
 */
function readClaimFlag(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

/** Minimal email shape gate for the UPN rule: `local@domain.tld`, no whitespace. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Entra ID (azure) verified-email evidence — the nOAuth hardening rules (OLO-1.4, #4189).
 *
 * Entra ID's `email` claim is attacker-controlled in multi-tenant app registrations: any tenant
 * admin can set an arbitrary address on the mutable `mail` attribute (the published **nOAuth**
 * account-takeover pattern), so for `azure` the generic `email_verified` handling is not enough.
 * The email is treated as verified only when the token carries acceptable evidence:
 *
 *   - `xms_edov` ("email domain owner verified") — the optional claim the app registration must
 *     request (see `apiome-ui/docs/ENTRA_ID_APP_REGISTRATION.md`) — is explicitly true, or
 *   - `email_verified` is explicitly true, or
 *   - the email equals the token's `upn` claim: member UPNs (no `#EXT#` guest marker) can only
 *     carry domains verified in the issuing tenant, which an attacker cannot forge for a domain
 *     they do not own.
 *
 * Fail-closed rules: an explicitly-false `xms_edov` or `email_verified` claim vetoes everything
 * (a contradictory token is never trusted), claim-based evidence only attests the token's own
 * `email` claim (never a different address the caller ended up with), and anything unrecognized
 * resolves to unverified.
 *
 * @param profile The OIDC profile / id-token claims from the provider.
 * @param account The NextAuth account object (fallback source for the claims).
 * @param emailInUse The canonical address the sign-in will actually use, when the caller derived
 *   it from somewhere other than `profile.email`; defaults to the profile's own email claim.
 * @returns True only when the token proves the address is verified; false otherwise.
 */
export function resolveEntraEmailVerified(
  profile: any,
  account: any,
  emailInUse?: string | null
): boolean {
  const claimedEmail = canonicalizeEmail(profile?.email);
  const email = emailInUse === undefined ? claimedEmail : canonicalizeEmail(emailInUse);
  if (!email) return false;

  const domainOwnerVerified = readClaimFlag(profile?.xms_edov ?? account?.xms_edov);
  const emailVerifiedClaim = readClaimFlag(profile?.email_verified ?? account?.email_verified);

  // An explicit negative claim is the strongest signal in the token — it vetoes every other rule.
  if (domainOwnerVerified === false || emailVerifiedClaim === false) return false;

  // Positive claims attest the token's own email claim, never a different address.
  if ((domainOwnerVerified === true || emailVerifiedClaim === true) && claimedEmail === email) {
    return true;
  }

  // UPN rule: a member UPN's domain is enforced-verified in the issuing tenant. Guest UPNs
  // (marked `#EXT#`) are rewritten onto the host tenant's domain and prove nothing.
  const upn = typeof profile?.upn === 'string' ? profile.upn : null;
  if (upn && !upn.toLowerCase().includes('#ext#')) {
    const canonicalUpn = canonicalizeEmail(upn);
    if (canonicalUpn && EMAIL_SHAPE.test(canonicalUpn) && canonicalUpn === email) return true;
  }

  return false;
}

/** The user-account facts the policy needs to admit or refuse a sign-in. */
export interface ResolutionUser {
  id: string;
  /** Account switch: disabled accounts never authenticate. */
  enabled: boolean;
  /** The account's own email-verification flag (apiome.users.verified). */
  verified: boolean;
  /**
   * True when the sign-in surface resolved a tenant context and found the user's membership
   * suspended (tenant_users.status = 'suspended'). Optional: the plain login flow has no tenant
   * context and leaves it unset; tenant-scoped surfaces (invitation acceptance, tenant selection —
   * OLO-3.x/5.x) populate it so the rejection carries the stable `membership-suspended` code.
   */
  membershipSuspended?: boolean;
  email?: string | null;
  name?: string | null;
}

/**
 * The facts `resolveAccountDecision` decides over. All lookups happen before the decision so the
 * policy itself is a pure function of this object.
 */
export interface ResolutionInput {
  /** OAuth provider slug (github | gitlab | azure | …). */
  provider: string;
  /** Stable provider-side user id from the OAuth response, if present. */
  providerUserId: string | null;
  /** Canonicalized provider email, or null when the provider shared none. */
  email: string | null;
  /** Whether the provider proved that email is verified (see resolveOAuthEmailVerified / OLO-1.4). */
  emailVerified: boolean;
  /**
   * Session user id when this OAuth round-trip is an explicit "link another provider" action for
   * this provider; null for a normal sign-in.
   */
  linkToUserId: string | null;
  /**
   * The `(provider, providerUserId)` binding, when one exists. `user` is null when the identity
   * row points at a user that no longer resolves (soft-deleted) — a dangling identity.
   */
  identity: { found: boolean; user: ResolutionUser | null };
  /** Existing user whose canonical email equals `email`, if any. */
  emailUser: ResolutionUser | null;
  /**
   * True when this deployment refuses self-signup (see `isSignupDisabled`). A verified email with
   * no existing account is then rejected with `signup-disabled` instead of routed to onboarding.
   */
  signupDisabled?: boolean;
}

/** What the engine decided; `executeResolutionDecision` turns this into effects. */
export type ResolutionDecision =
  | { action: 'link-to-session'; userId: string }
  | { action: 'sign-in'; user: ResolutionUser }
  | { action: 'auto-link'; user: ResolutionUser }
  | { action: 'signup'; email: string }
  | { action: 'reject'; code: AuthErrorCode };

/**
 * Gate that refuses disabled / not-yet-verified accounts. Shared by the known-identity and
 * email-match paths so no branch can admit an account the other would refuse.
 */
function rejectionForUser(user: ResolutionUser | null): AuthErrorCode | null {
  if (!user) return AUTH_ERROR_CODES.ACCOUNT_DISABLED;
  if (!user.enabled) return AUTH_ERROR_CODES.ACCOUNT_DISABLED;
  if (!user.verified) return AUTH_ERROR_CODES.ACCOUNT_NOT_VERIFIED;
  if (user.membershipSuspended) return AUTH_ERROR_CODES.MEMBERSHIP_SUSPENDED;
  return null;
}

/**
 * The account-resolution policy (pure — no I/O).
 *
 * Applies, in order: explicit link intent → (a) known identity → (d) unverified rejection →
 * (b) verified-email auto-link → (c) verified-email signup. See the module doc for the policy
 * rationale.
 *
 * @param input Pre-gathered facts (see ResolutionInput).
 * @returns The decision to execute. Never returns 'signup' when a user already exists for the
 *   email, and never returns 'sign-in' / 'auto-link' / 'signup' for an unproven email (the two
 *   acceptance invariants of OLO-1.3).
 */
export function resolveAccountDecision(input: ResolutionInput): ResolutionDecision {
  // 0. Explicit "link another provider" while signed in: attach to the session user regardless
  //    of the provider email — the signed-in session is the proof of intent and ownership.
  if (input.linkToUserId) {
    return { action: 'link-to-session', userId: input.linkToUserId };
  }

  // Without a stable provider user id we can neither key the identity nor safely link it.
  if (!input.providerUserId) {
    return { action: 'reject', code: AUTH_ERROR_CODES.PROFILE_INCOMPLETE };
  }

  // (a) Known identity → sign in its user. No email trust is required here: the binding was
  //     established under this same policy (or by explicit linking).
  if (input.identity.found) {
    const rejection = rejectionForUser(input.identity.user);
    if (rejection) return { action: 'reject', code: rejection };
    return { action: 'sign-in', user: input.identity.user as ResolutionUser };
  }

  // From here on the email is the only evidence, so it must exist and be proven verified by a
  // provider we trust to assert that. Canonicalize defensively — the policy must never compare
  // or store a non-canonical address (OLO-1.1).
  const email = canonicalizeEmail(input.email);
  if (!email) {
    return { action: 'reject', code: AUTH_ERROR_CODES.EMAIL_REQUIRED };
  }

  const emailProven = input.emailVerified && AUTO_LINK_TRUSTED_PROVIDERS.has(input.provider);
  if (!emailProven) {
    // (d) Unverified email → structured rejection. Never auto-link, never create an account.
    return { action: 'reject', code: AUTH_ERROR_CODES.UNVERIFIED_EMAIL };
  }

  if (input.emailUser) {
    // (b) Verified email matches an existing account → auto-link this identity and sign in.
    //     This is the invariant's teeth: a second account can never be created for this email.
    const rejection = rejectionForUser(input.emailUser);
    if (rejection) return { action: 'reject', code: rejection };
    return { action: 'auto-link', user: input.emailUser };
  }

  // (c) Verified email, no account → create user + identity (routed via onboarding/signup),
  //     unless this deployment refuses self-signup.
  if (input.signupDisabled) {
    return { action: 'reject', code: AUTH_ERROR_CODES.SIGNUP_DISABLED };
  }
  return { action: 'signup', email };
}

/** Result contract of a NextAuth signIn callback: `true` to admit, or a redirect path. */
export type OAuthSignInResult = boolean | string;

/** Persistence operations the engine needs; injected so the policy stays testable without a DB. */
export interface ResolutionStore {
  /** Resolve the user bound to `(provider, providerUserId)`, if the identity exists. */
  getIdentity(
    provider: string,
    providerUserId: string
  ): Promise<{ found: boolean; userId: string | null }>;
  /** Fetch a live (non-deleted) user by id; null when missing. */
  getUserById(userId: string): Promise<ResolutionUser | null>;
  /** Fetch a live user by canonical email; null when missing. */
  getUserByEmail(email: string): Promise<ResolutionUser | null>;
  /**
   * Bind the identity to the user (INSERT into external_auth_providers).
   * Must enforce the OLO-1.2 uniqueness invariants and report failures via `code`.
   */
  linkIdentity(userId: string, identity: OAuthIdentityDetails): Promise<{
    success: boolean;
    code?: AuthErrorCode;
  }>;
  /** Refresh the identity's last_login_at / provider_email / email_verified columns. */
  recordIdentityLogin(
    provider: string,
    providerUserId: string,
    email: string | null,
    emailVerified: boolean
  ): Promise<void>;
  /** Stamp users.last_login_at (best-effort; must not block sign-in). */
  recordUserLogin(userId: string): Promise<void>;
  /** Persist a pending self-signup row and return its token for the onboarding redirect. */
  createPendingSignup(
    provider: string,
    providerUserId: string,
    email: string,
    account: Record<string, unknown>,
    profile: Record<string, unknown>
  ): Promise<{ id: string }>;
}

/** Everything `linkIdentity` persists about the incoming OAuth identity. */
export interface OAuthIdentityDetails {
  provider: string;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  username: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  profileData: Record<string, unknown>;
}

/**
 * The Entra ID token claims persisted into `profile_data` for later re-validation (OLO-2.2,
 * #4194): the immutable directory identity (`oid`, `tid`), the address claims (`upn`,
 * `preferred_username`, `email`), and the raw verified-email evidence (`email_verified`,
 * `xms_edov`) exactly as the token asserted them. Storing the *raw* evidence — not just the
 * computed boolean — lets a later pass re-run the nOAuth rules (OLO-1.4) against what was
 * actually presented, and keeps `profile_data->>'email_verified'` readable by the V181 backfill.
 *
 * @param profile The raw id-token claims from the Entra ID sign-in.
 * @returns The claim subset, with `null` for anything the token did not carry (an explicit shape
 *   so re-validation reads never have to guess which keys exist).
 */
function azureRevalidationClaims(
  profile: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return {
    oid: typeof profile?.oid === 'string' ? profile.oid : null,
    tid: typeof profile?.tid === 'string' ? profile.tid : null,
    upn: typeof profile?.upn === 'string' ? profile.upn : null,
    preferred_username:
      typeof profile?.preferred_username === 'string' ? profile.preferred_username : null,
    email: typeof profile?.email === 'string' ? profile.email : null,
    email_verified: profile?.email_verified ?? null,
    xms_edov: profile?.xms_edov ?? null,
  };
}

/**
 * Extract the identity details from a NextAuth signIn payload (account + profile). The profile
 * key fallbacks cover the GitHub (`avatar_url`/`html_url`), GitLab (`image_url`/`web_url`), and
 * Entra ID (`preferred_username`) response shapes. For `azure`, the stored `profile_data`
 * additionally carries the re-validation claims (see `azureRevalidationClaims`).
 */
export function extractIdentityDetails(
  provider: string,
  payload: any,
  email: string | null,
  emailVerified: boolean
): OAuthIdentityDetails {
  const account = payload?.account ?? {};
  const profile = payload?.profile ?? payload?.user ?? {};

  return {
    provider,
    providerUserId: account.providerAccountId ?? profile.id ?? null,
    email,
    emailVerified,
    username:
      (typeof profile.login === 'string' && profile.login) ||
      (typeof profile.username === 'string' && profile.username) ||
      (typeof profile.preferred_username === 'string' && profile.preferred_username) ||
      null,
    accessToken: typeof account.access_token === 'string' ? account.access_token : null,
    refreshToken: typeof account.refresh_token === 'string' ? account.refresh_token : null,
    tokenExpiresAt:
      typeof account.expires_at === 'number' ? new Date(account.expires_at * 1000) : null,
    profileData: {
      name: profile.name,
      avatar_url: profile.avatar_url || profile.image_url || profile.image || profile.picture || null,
      profile_url: profile.html_url || profile.web_url || profile.url || null,
      ...(provider === 'azure' ? azureRevalidationClaims(profile) : {}),
    },
  };
}

/** Redirect targets used when executing decisions. */
const LINKED_ACCOUNTS_PAGE = '/ade/dashboard/linked-accounts';
const LOGIN_PAGE = '/login';

/**
 * The transport of the error contract: a login-page redirect carrying the stable code as the
 * NextAuth `error` query param (`/login?error=<code>`). Every emitter of a contract code —
 * this engine, the credentials sign-in path, and the provider dispatch — must build its redirect
 * through this helper so the shape can never drift.
 */
export const loginErrorRedirect = (code: AuthErrorCode) =>
  `${LOGIN_PAGE}?error=${encodeURIComponent(code)}`;

/** Copy the resolved user onto the NextAuth payload so the jwt/session callbacks see it. */
function adoptUserIntoPayload(payload: any, user: ResolutionUser) {
  payload.user.id = user.id;
  payload.user.email = user.email ?? payload.user.email;
  payload.user.name = user.name ?? payload.user.name;
  payload.user.enabled = user.enabled;
  payload.user.verified = user.verified;
}

/**
 * Resolve an incoming OAuth sign-in end to end: gather the facts, run the pure policy, execute
 * the decision through the store, and return the NextAuth signIn-callback result.
 *
 * @param provider The OAuth provider slug ('github' | 'gitlab' | …).
 * @param payload The NextAuth signIn callback payload ({ user, account, profile }). On a
 *   successful sign-in the payload's user is mutated to the resolved account (NextAuth reads it
 *   in the jwt callback).
 * @param linkIntentUserId Session user id when this round-trip is an explicit link action for
 *   this provider (from the link-intent cookie); null otherwise.
 * @param store Persistence operations (production wiring lives in credentials.ts).
 * @returns `true` to admit the sign-in, or a redirect path (login error, signup wizard, or the
 *   linked-accounts page for link flows).
 */
export async function resolveOAuthSignIn(
  provider: string,
  payload: any,
  linkIntentUserId: string | null,
  store: ResolutionStore
): Promise<OAuthSignInResult> {
  const account = payload?.account ?? null;
  const profile = payload?.profile ?? null;

  const providerUserId: string | null = account?.providerAccountId ?? null;
  const email =
    canonicalizeEmail(payload?.user?.email) ?? canonicalizeEmail(profile?.email);
  // Azure/Entra email claims are subject to the nOAuth hardening evidence rules (OLO-1.4);
  // every other provider uses the generic email_verified resolution.
  const emailVerified =
    provider === 'azure'
      ? resolveEntraEmailVerified(profile, account, email)
      : resolveOAuthEmailVerified(profile, account);
  const details = extractIdentityDetails(provider, payload, email, emailVerified);

  // Gather the facts the pure policy decides over.
  let identity: ResolutionInput['identity'] = { found: false, user: null };
  if (providerUserId) {
    const bound = await store.getIdentity(provider, providerUserId);
    if (bound.found) {
      identity = {
        found: true,
        user: bound.userId ? await store.getUserById(bound.userId) : null,
      };
    }
  }
  const emailUser = email ? await store.getUserByEmail(email) : null;

  const decision = resolveAccountDecision({
    provider,
    providerUserId,
    email,
    emailVerified,
    linkToUserId: linkIntentUserId,
    identity,
    emailUser,
    signupDisabled: isSignupDisabled(),
  });

  switch (decision.action) {
    case 'link-to-session': {
      const linked = await store.linkIdentity(decision.userId, details);
      return linked.success
        ? `${LINKED_ACCOUNTS_PAGE}?linked=true`
        : `${LINKED_ACCOUNTS_PAGE}?error=Failed to link account. It may already be linked to another user.`;
    }

    case 'sign-in': {
      // 'sign-in' is only reachable for a known identity, so providerUserId is present.
      await store.recordIdentityLogin(provider, providerUserId as string, email, emailVerified);
      adoptUserIntoPayload(payload, decision.user);
      void store.recordUserLogin(decision.user.id).catch(() => undefined);
      return true;
    }

    case 'auto-link': {
      // The sign-in is only admitted when the identity binding is actually persisted — an
      // unrecorded email-match sign-in would bypass the audited invariant.
      const linked = await store.linkIdentity(decision.user.id, details);
      if (!linked.success) {
        return loginErrorRedirect(linked.code ?? AUTH_ERROR_CODES.IDENTITY_LINKED_ELSEWHERE);
      }
      adoptUserIntoPayload(payload, decision.user);
      void store.recordUserLogin(decision.user.id).catch(() => undefined);
      return true;
    }

    case 'signup': {
      const pending = await store.createPendingSignup(
        provider,
        providerUserId as string,
        decision.email,
        {
          access_token: details.accessToken,
          refresh_token: details.refreshToken,
          expires_at: account?.expires_at ?? null,
          providerAccountId: providerUserId,
        },
        { ...(profile || {}), email: decision.email }
      );
      return `/signup/oauth?token=${encodeURIComponent(pending.id)}`;
    }

    case 'reject':
      return loginErrorRedirect(decision.code);
  }
}
