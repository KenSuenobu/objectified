/**
 * What the Linked accounts surface knows, with no React in it (HIVE-4.8, #5302).
 *
 * Authority: `docs/mockups/account/linked-accounts.html` — its **Keeps (1:1)** list fixes every
 * string below — and `docs/mockups/DESIGN.md` §7 (the status vocabulary, one primary action),
 * §8 ("Destructive": red primary, object named, consequence sentence) and §10 (sentence case).
 *
 * Linked accounts is a small screen with a large amount of *copy*: two confirms, a token dialog
 * with provider-specific scope guidance, a last-sign-in-method guard that has to explain itself
 * twice (a note in the row and a tooltip on the button), and a query-string handshake with
 * NextAuth. None of that needs a DOM to be right, and all of it is the part a redesign can
 * silently lose — so it lives here, where `tests/linked-accounts-model.test.ts` pins it
 * directly, and the components below spend their lines on layout.
 *
 * The rule the module follows is {@link ./accountModel accountModel}'s: **it never invents a
 * fact.** An unparseable timestamp comes back `null` rather than as today's date, a provider
 * this build no longer knows keeps its own id as a label rather than being dropped, and a
 * provider with no scope guidance gets no scopes banner rather than a guess at one.
 */

import type { ProviderSummary } from '@lib/auth/provider-registry';

import type { DestructiveConfirmOptions } from '@/app/components/dialogs/destructiveConfirm';
import { formatLoginStamp, providerLabel } from './accountModel';

// ---------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------

/**
 * One linked external identity, as `getLinkedAccountsForUser` returns it.
 *
 * The row carries the *last six characters* of the Personal Access Token and never the token:
 * the query projects `RIGHT(access_token, 6)` precisely so the client can say "PAT set" without
 * the secret ever reaching a browser.
 */
export interface LinkedAccount {
  /** `external_auth_providers.id` — the id every write below is scoped by. */
  id: string;
  /** Provider-registry id (`github`, `gitlab`, `azure`, …). */
  provider: string;
  /** The subject id at the provider. Not shown; kept because the row is passed through whole. */
  provider_user_id: string;
  /** The address at the provider. */
  provider_email: string;
  /** The handle at the provider, when it has one. */
  provider_username: string | null;
  /** Last 6 characters of the PAT when one is set (display only; the token never leaves the DB). */
  access_token_suffix?: string | null;
  /** When the identity was linked. */
  created_at: string;
  /** When it was last signed in with, or `null` if never. */
  last_login_at: string | null;
}

/** Providers whose linked accounts support a Personal Access Token for direct repo access. */
export const PAT_PROVIDERS: ReadonlySet<string> = new Set(['github', 'gitlab']);

/**
 * The scopes a provider's Personal Access Token has to carry, as the mockup's Keeps list fixes
 * them.
 *
 * Only the two PAT providers have an entry, and {@link patScopesFor} answers `null` for anything
 * else: a scope list is a promise about another product's permission model, so a provider whose
 * list this build does not know shows no banner rather than a plausible-looking guess.
 */
export const PAT_SCOPES: Readonly<Record<string, string>> = {
  github: 'repo (or public_repo), read:org, read:user, user:email',
  gitlab: 'read_api, read_repository, read_user',
};

/**
 * The scope guidance for a provider's token dialog.
 *
 * @param provider The registry id.
 * @returns The comma-separated scope list, or `null` when this build has none for it.
 */
export function patScopesFor(provider: string): string | null {
  return PAT_SCOPES[provider] ?? null;
}

/**
 * One line saying what a provider *is*, for the "Add a provider" cards.
 *
 * The mockup's Adds list asks for these ("provider one-liners"): a card that reads only
 * "Microsoft" leaves the reader to guess whether it means a personal account or their employer's
 * directory. The registry cannot hold them — it is imported by server boot validation and has no
 * business carrying display copy — so they are a table here, and a provider without one simply
 * draws no second line.
 */
export const PROVIDER_TAGLINES: Readonly<Record<string, string>> = {
  github: 'Repositories, organisations and pull requests',
  gitlab: 'Projects, groups and merge requests',
  azure: 'Entra ID / Azure AD single sign-on',
  google: 'Google Workspace or personal account',
  okta: 'Enterprise SSO via Okta OIDC',
  aws: 'Amazon Cognito user pool sign-in',
  keycloak: 'Self-hosted realm sign-in',
  oidc: 'Any OpenID Connect identity provider',
  auth0: 'Auth0 tenant single sign-on',
  line: 'LINE Login for JP, TW and TH accounts',
  vk: 'VK ID sign-in',
  wechat: 'WeChat Open Platform QR sign-in',
};

/**
 * The one-liner under a provider's name.
 *
 * @param provider The registry id.
 * @returns The tagline, or `null` for a provider this build has no copy for.
 */
export function providerTagline(provider: string): string | null {
  return PROVIDER_TAGLINES[provider] ?? null;
}

/**
 * The reader-facing name of a provider, preferring the deployment's own registry label.
 *
 * The registry is the authority while a provider is enabled — an operator-renamed generic OIDC
 * entry reads as whatever the deployment calls it — and {@link providerLabel} is the fallback,
 * so a *linked* account whose provider has since been removed from the build still reads as a
 * word rather than as a slug.
 *
 * @param provider The registry id.
 * @param providers The summaries the server page resolved.
 * @returns The label to print.
 */
export function resolveProviderLabel(
  provider: string,
  providers: readonly ProviderSummary[]
): string {
  return providers.find((summary) => summary.id === provider)?.label ?? providerLabel(provider);
}

/**
 * How an account identifies its owner at the provider — the handle, or the address.
 *
 * @param account The linked identity.
 * @returns The handle, the address, or an empty string when the row carries neither.
 */
export function accountHandle(
  account: Pick<LinkedAccount, 'provider_username' | 'provider_email'>
): string {
  return account.provider_username || account.provider_email || '';
}

/** The masked form of a stored PAT: six bullets and the six characters the row does carry. */
export function patMask(suffix: string): string {
  return `••••••${suffix}`;
}

/** What the PAT row says when the account has no token yet. */
export const PAT_ADD_HINT = 'Optional: add a PAT for direct repo access.';

/** The note under an account that is the reader's only way in. */
export const LAST_METHOD_NOTE =
  'Only sign-in method — set a password or link another provider to remove it.';

/** The disabled Unlink button's tooltip, which the Keeps list fixes word for word. */
export const LAST_METHOD_TOOLTIP =
  'This is your only sign-in method. Set a password or link another provider before unlinking it.';

/** One row of the linked-accounts table, with every string it prints already decided. */
export interface LinkedAccountRow {
  /** The account this row is for, passed through whole so the actions can act on it. */
  account: LinkedAccount;
  /** `external_auth_providers.id`, as the table's row key. */
  id: string;
  /** Provider-registry id, for the brand mark. */
  provider: string;
  /** The provider's display name. */
  label: string;
  /** The handle or address at the provider. */
  handle: string;
  /** When it was linked, as `MM/DD/YY hh:mm AM`, or `null` when the stamp does not parse. */
  linkedAt: string | null;
  /** When it was last signed in with, same format, or `null` for never. */
  lastLoginAt: string | null;
  /** Whether unlinking this identity would leave the reader with no way to sign in. */
  isLastSignInMethod: boolean;
  /** Whether a Personal Access Token is stored against it. */
  hasPat: boolean;
}

/**
 * Whether unlinking one account would strip the reader's last sign-in method.
 *
 * The server enforces this too (`unlinkExternalAccount` refuses with `last-sign-in-method`);
 * this is what lets the page disable the button and say *why* before the click, rather than
 * letting the reader ask for something that is going to be refused.
 *
 * @param options.accounts Every linked identity on the account.
 * @param options.hasPassword Whether a usable password is set.
 * @param options.accountId The identity being considered.
 * @returns `true` when that identity is the only remaining method.
 */
export function isLastSignInMethod({
  accounts,
  hasPassword,
  accountId,
}: {
  accounts: readonly Pick<LinkedAccount, 'id'>[];
  hasPassword: boolean;
  accountId: string;
}): boolean {
  return !hasPassword && accounts.length === 1 && accounts[0]?.id === accountId;
}

/**
 * Turn the loaded identities into table rows.
 *
 * @param options.accounts The identities, newest first as the query returns them.
 * @param options.providers The registry summaries, for labels.
 * @param options.hasPassword Whether a usable password is set, for the last-method guard.
 * @returns One row per identity, in the order given.
 */
export function buildLinkedAccountRows({
  accounts,
  providers,
  hasPassword,
}: {
  accounts: readonly LinkedAccount[];
  providers: readonly ProviderSummary[];
  hasPassword: boolean;
}): LinkedAccountRow[] {
  return accounts.map((account) => ({
    account,
    id: account.id,
    provider: account.provider,
    label: resolveProviderLabel(account.provider, providers),
    handle: accountHandle(account),
    linkedAt: formatLoginStamp(account.created_at),
    lastLoginAt: formatLoginStamp(account.last_login_at),
    isLastSignInMethod: isLastSignInMethod({
      accounts,
      hasPassword,
      accountId: account.id,
    }),
    hasPat: Boolean(account.access_token_suffix),
  }));
}

// ---------------------------------------------------------------------------------------
// The provider cards
// ---------------------------------------------------------------------------------------

/** One "Add a provider" card, with everything it draws already decided. */
export interface ProviderCardModel {
  /** Registry id — the React key, the brand mark, and what `signIn()` is called with. */
  id: string;
  /** The provider's display name. */
  label: string;
  /** The one-liner under it, or `null` when this build has none. */
  tagline: string | null;
  /** Whether this deployment's configuration enables linking it today. */
  available: boolean;
  /** Whether it is a registry teaser rather than something that can be linked. */
  comingSoon: boolean;
  /** Whether the reader already has an identity with it. */
  linked: boolean;
  /** That identity, when there is one. */
  account: LinkedAccount | null;
  /** Whether the provider supports a Personal Access Token at all. */
  supportsPat: boolean;
  /** Whether to draw the PAT row: a linkable PAT provider the reader has actually linked. */
  showPatRow: boolean;
  /** The stored token's last six characters, or `null` when none is set. */
  patSuffix: string | null;
}

/**
 * The cards the "Add a provider" grid draws.
 *
 * The filter is the provider registry's contract (OLO-2.3, #4195) and is unchanged by this
 * ticket: an **enabled** provider gets a card, a **coming-soon** registry entry gets a disabled
 * teaser, and an `available` provider whose configuration is incomplete is hidden outright —
 * its NextAuth route is not registered, so a Link button could only dead-end.
 *
 * @param options.providers The registry summaries the server page resolved.
 * @param options.accounts The reader's linked identities.
 * @returns One card model per offered provider, in registry order.
 */
export function buildProviderCards({
  providers,
  accounts,
}: {
  providers: readonly ProviderSummary[];
  accounts: readonly LinkedAccount[];
}): ProviderCardModel[] {
  return providers
    .filter((provider) => provider.enabled || provider.status === 'coming-soon')
    .map((provider) => {
      const account = accounts.find((candidate) => candidate.provider === provider.id) ?? null;
      const supportsPat = PAT_PROVIDERS.has(provider.id);

      return {
        id: provider.id,
        label: provider.label,
        tagline: providerTagline(provider.id),
        available: provider.enabled,
        comingSoon: provider.status === 'coming-soon',
        linked: account !== null,
        account,
        supportsPat,
        showPatRow: supportsPat && provider.enabled && account !== null,
        patSuffix: account?.access_token_suffix ?? null,
      };
    });
}

// ---------------------------------------------------------------------------------------
// The query-string handshake
// ---------------------------------------------------------------------------------------

/** The route the page lives at, and the URL the linking round trip returns to. */
export const LINKED_ACCOUNTS_PATH = '/ade/dashboard/linked-accounts';

/** What a completed link says, which the Keeps list fixes. */
export const LINK_SUCCESS_MESSAGE = 'Account linked successfully!';

/** What a link that came back with an empty `?error=` says. */
export const LINK_FAILURE_MESSAGE = 'Failed to link account';

/** The banner a return from the provider asks for, if it asks for one. */
export interface LinkOutcome {
  /** The success banner's text, or `null`. */
  success: string | null;
  /** The error banner's text, or `null`. */
  error: string | null;
  /** Whether the query string has to be scrubbed out of the address bar. */
  cleanUrl: boolean;
}

/** Nothing to report — a plain visit to the page. */
const NO_OUTCOME: LinkOutcome = { success: null, error: null, cleanUrl: false };

/**
 * Read the banner out of the query string NextAuth returned to.
 *
 * `?linked=true` means the callback completed; `?error=…` carries whatever went wrong. Either
 * way the parameter is a *one-shot* message, so it is reported once and the URL is cleaned —
 * otherwise a reload would re-announce a link that happened minutes ago, and a shared link
 * would announce one that never happened at all.
 *
 * Success is checked first and wins: a callback that set both is reporting a link that
 * completed, and the failure it also mentions is the one it recovered from.
 *
 * @param search The `location.search` string, with or without its leading `?`.
 * @returns Which banner to show, and whether to scrub the query.
 */
export function readLinkOutcome(search: string): LinkOutcome {
  const params = new URLSearchParams(search);

  if (params.get('linked') === 'true') {
    return { success: LINK_SUCCESS_MESSAGE, error: null, cleanUrl: true };
  }
  if (params.has('error')) {
    return { success: null, error: params.get('error') || LINK_FAILURE_MESSAGE, cleanUrl: true };
  }
  return NO_OUTCOME;
}

// ---------------------------------------------------------------------------------------
// Confirm copy
// ---------------------------------------------------------------------------------------

/**
 * Name the ways in that survive an unlink — `"your password or GitLab"`.
 *
 * The mockup's confirm reassures the reader before the destructive click, and the only honest
 * way to do that is to name what is left. Composed rather than templated because the list is
 * 1, 2 or many, and "your password, GitHub or GitLab" is the only reading of all three that is
 * not stilted.
 *
 * @param options.hasPassword Whether a usable password is set.
 * @param options.otherLabels The display names of the identities that are not being unlinked.
 * @returns The phrase, or `null` when nothing would be left — a state the guard prevents.
 */
export function describeRemainingMethods({
  hasPassword,
  otherLabels,
}: {
  hasPassword: boolean;
  otherLabels: readonly string[];
}): string | null {
  const methods = [...(hasPassword ? ['your password'] : []), ...otherLabels];
  if (methods.length === 0) return null;
  if (methods.length === 1) return methods[0];
  return `${methods.slice(0, -1).join(', ')} or ${methods[methods.length - 1]}`;
}

/**
 * The unlink confirm, as DESIGN.md §8 asks for it.
 *
 * The **message** is the sentence the page has always asked ("Are you sure you want to unlink
 * your GitHub account (ada-lovelace)?"), which the Keeps list preserves. The **consequence** is
 * what §8 adds and what the page never said: which ways in are left, and that the stored token
 * goes with the identity.
 *
 * @param options.label The provider's display name.
 * @param options.handle The handle or address at the provider.
 * @param options.hasPat Whether a Personal Access Token is stored against the identity.
 * @param options.remaining The phrase from {@link describeRemainingMethods}, or `null`.
 * @returns Options for `useDialog().confirm`.
 */
export function unlinkConfirmOptions({
  label,
  handle,
  hasPat,
  remaining,
}: {
  label: string;
  handle: string;
  hasPat: boolean;
  remaining: string | null;
}): DestructiveConfirmOptions {
  const consequence = [
    remaining ? `You can still sign in with ${remaining}.` : null,
    hasPat ? 'The stored Personal Access Token is removed too.' : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    title: `Unlink ${label} account?`,
    message: `Are you sure you want to unlink your ${label} account (${handle})?`,
    consequence: consequence || undefined,
    variant: 'danger',
    confirmLabel: 'Unlink',
    cancelLabel: 'Cancel',
  };
}

/**
 * The remove-token confirm.
 *
 * @param options.label The provider's display name.
 * @param options.handle The handle or address at the provider.
 * @param options.suffix The token's last six characters, when the row carries them.
 * @returns Options for `useDialog().confirm`.
 */
export function removePatConfirmOptions({
  label,
  handle,
  suffix,
}: {
  label: string;
  handle: string;
  suffix: string | null;
}): DestructiveConfirmOptions {
  const named = suffix ? ` (${patMask(suffix)})` : '';

  return {
    title: 'Remove Personal Access Token?',
    message: `Are you sure you want to remove the Personal Access Token for your ${label} account (${handle})${named}?`,
    consequence: 'Repository imports that rely on it fall back to the OAuth grant.',
    variant: 'danger',
    confirmLabel: 'Remove token',
    cancelLabel: 'Cancel',
  };
}

// ---------------------------------------------------------------------------------------
// Result envelopes
// ---------------------------------------------------------------------------------------

/**
 * Read a `{ success, error }` envelope out of a server action's JSON string.
 *
 * Every write this page makes answers with a JSON *string* and reports failure in the body
 * rather than by throwing, and a page that threw on an unexpected shape would replace a working
 * screen with a blank one. Same contract as Profile's `readActionError`.
 *
 * @param raw The JSON string the action returned.
 * @param fallbackError What to say when it failed without saying why.
 * @returns `null` when it succeeded, or the message to show.
 */
export function readActionError(raw: string, fallbackError: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallbackError;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallbackError;

  const response = parsed as { success?: boolean; error?: string };
  if (response.success) return null;
  return response.error || fallbackError;
}

/**
 * Parse a JSON payload, refusing a shape the caller did not ask for.
 *
 * @param raw The JSON string the action returned.
 * @param accepts Whether the parsed value is the expected shape.
 * @param fallback What to use when it does not parse, or is not that shape.
 * @returns The parsed value, or `fallback`.
 */
export function parsePayload<T>(
  raw: string,
  accepts: (value: unknown) => boolean,
  fallback: T
): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return accepts(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}
