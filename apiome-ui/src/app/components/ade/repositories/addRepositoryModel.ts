/**
 * Every rule the Add-repository screen obeys, in one React-free module (HIVE-7.4, #5321).
 *
 * Authority: `docs/mockups/sources/repository-new.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria, plus DESIGN.md §5.3 (page header), §7 (cards, fields and
 * the one primary action) and §3.1 (status vocabulary).
 *
 * The 643-line screen this replaces derived all of it inline: the two validity rules, the
 * request body, the five blocking toasts, the four API error shapes and every sentence of copy
 * were expressions inside JSX. That is how the screen came to accept a URL the Test button had
 * never approved on one path and refuse it on another. Everything here is a plain function over
 * plain data, unit-tested directly in `tests/add-repository-model.test.ts`, so the button's
 * `disabled` state and the toast that explains it are answered by the *same* function and can
 * never disagree.
 *
 * ### Why the copy is constants
 *
 * The mockup's **Keeps (1:1)** list names eighteen sentences that must survive the redesign
 * verbatim. A sentence that lives in JSX is a sentence a refactor rewrites by accident; every
 * one of them is a constant below, and `tests/add-repository-model.test.ts` asserts the exact
 * text. The screen never spells a string of its own.
 *
 * ### What is deliberately *not* here
 *
 * - **Parsing of the registered repository.** `DashboardRepository` and its parser stay in
 *   `components/ade/dashboard/repositories/repositoryStoreUi.tsx`; this screen creates one and
 *   navigates away, it never lists them.
 * - **Colour.** No tone below is a hue. The URL test's two outcomes resolve through
 *   `ui/statusVocabulary.ts` like every other state in the product.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import type { RepositoryProvider } from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';

// ---------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------

/** Where Cancel, Back and the breadcrumb's last hop all go — the repositories list. */
export const REPOSITORIES_HREF = '/ade/dashboard/repositories';

/** Where the reader manages the accounts this screen browses. */
export const LINKED_ACCOUNTS_HREF = '/ade/dashboard/linked-accounts';

/** The API this screen writes to. */
export const REPOSITORIES_API = '/api/repositories';

/** The API the Test button calls. */
export const TEST_PUBLIC_URL_API = '/api/repositories/test-public-url';

/**
 * Where a successful registration lands.
 *
 * The preview screen, not the detail screen: a repository that has just been registered has
 * not been scanned yet, so its detail page would be empty. Unchanged from what this replaces.
 *
 * @param repositoryId The id the create call returned.
 * @returns The preview route for that repository.
 */
export function repositoryPreviewHref(repositoryId: string): string {
  return `${REPOSITORIES_HREF}/${encodeURIComponent(repositoryId)}/preview`;
}

/**
 * Where the remote-repository list is read from.
 *
 * @param accountId The linked account to browse.
 * @returns The GitHub repositories endpoint for that account.
 */
export function githubReposHref(accountId: string): string {
  return `/api/sso/github/repos?accountId=${encodeURIComponent(accountId)}`;
}

// ---------------------------------------------------------------------------------------
// The stepper
// ---------------------------------------------------------------------------------------

/** One step of the flow, as `ui/Stepper` takes it. */
export interface AddRepositoryStep {
  /** Stable identifier. */
  id: string;
  /** The step's visible name. */
  label: string;
}

/**
 * The four steps the mockup's progress row draws.
 *
 * Only the first exists. The other three are the *proposed* split of this single screen, which
 * is why they are still drawn: a reader who has been shown a four-step row and is then dropped
 * onto `/preview` after step 1 has been told the flow is broken. Drawing all four and marking
 * three of them as a proposal is the honest version of the same picture — the ticket's third
 * acceptance criterion.
 */
export const ADD_REPOSITORY_STEPS: readonly AddRepositoryStep[] = [
  { id: 'source', label: 'Source' },
  { id: 'repository', label: 'Repository' },
  { id: 'scan', label: 'Scan settings' },
  { id: 'confirm', label: 'Confirm' },
] as const;

/** The only step that exists today, and therefore the only one ever current. */
export const LIVE_STEP_ID = 'source';

/** Names the progress row for a screen-reader user. */
export const STEPPER_LABEL = 'Add repository progress';

/** The chip beside the progress row. */
export const PROPOSED_STEPS_BADGE = 'Steps 2–4 proposed';

/** Why that chip is there, on hover and as the chip's accessible description. */
export const PROPOSED_STEPS_TIP =
  'Today only step 1 exists; steps 2–4 are the proposed split of this single screen';

// ---------------------------------------------------------------------------------------
// The proposal card
// ---------------------------------------------------------------------------------------

/** One proposed step, as the proposal card draws it. */
export interface ProposedStep {
  /** The step this describes — its `id` in {@link ADD_REPOSITORY_STEPS}. */
  id: string;
  /** The caps label: the step's number and name. */
  title: string;
  /** What that step would do, and where the work lives today. */
  body: string;
}

/** The proposal card's heading. */
export const PROPOSAL_TITLE = 'Proposed steps 2–4';

/**
 * The chip inside the proposal card.
 *
 * Deliberately a full sentence rather than a word: "Proposed" alone reads as a *status of the
 * repository being added*, which is the one misreading this card exists to prevent.
 */
export const PROPOSAL_BADGE = 'Redesign proposal — not in the app today';

/** The line under the heading, for a reader who never reaches the chip. */
export const PROPOSAL_NOTE =
  'The form above is the whole flow today: it registers the repository from step 1. Nothing below is built.';

/** The three columns of the proposal card, in step order. */
export const PROPOSED_STEPS: readonly ProposedStep[] = [
  {
    id: 'repository',
    title: '2 · Repository',
    body:
      'Remote browse moves here: account picker + searchable repo list (this screen’s cards 2–3), ' +
      'leaving step 1 as the source choice only.',
  },
  {
    id: 'scan',
    title: '3 · Scan settings',
    body:
      'Branch selection (default branch pre-picked), subpath glob, auto-refresh cadence and ' +
      'conflict policy — today these live in repository Settings after registration.',
  },
  {
    id: 'confirm',
    title: '4 · Confirm',
    body:
      'Summary of provider, repo, branch and settings with a single “Register repository” commit; ' +
      'success routes to /[id]/preview as today.',
  },
] as const;

// ---------------------------------------------------------------------------------------
// The source choice
// ---------------------------------------------------------------------------------------

/** The two ways a repository can be brought in. */
export type AddRepositorySource = 'linked' | 'public_url';

/** One of the two source cards. */
export interface AddRepositorySourceOption {
  /** Which source this card chooses. */
  id: AddRepositorySource;
  /** The card's name. */
  label: string;
  /** The sentence under it. */
  description: string;
}

/** The card the screen opens on — the same default the screen this replaces had. */
export const DEFAULT_SOURCE: AddRepositorySource = 'linked';

/** The two source cards, with the mockup's copy verbatim. */
export const ADD_REPOSITORY_SOURCES: readonly AddRepositorySourceOption[] = [
  {
    id: 'linked',
    label: 'Linked account',
    description:
      'Pick from repos accessible via your connected GitHub, GitLab, or Bitbucket account.',
  },
  {
    id: 'public_url',
    label: 'Public Git URL',
    description: 'Paste the HTTPS clone URL of any public repository — no authentication required.',
  },
] as const;

/** Narrow an arbitrary string to a source, for a control that hands back `string`. */
export function isAddRepositorySource(value: string): value is AddRepositorySource {
  return ADD_REPOSITORY_SOURCES.some((option) => option.id === value);
}

// ---------------------------------------------------------------------------------------
// Linked accounts
// ---------------------------------------------------------------------------------------

/** A provider account the reader has connected. */
export interface LinkedAccount {
  /** The account's id, which is what the browse call is keyed by. */
  id: string;
  /** `github` / `gitlab` / `bitbucket`, in whatever case the row was written. */
  provider: string;
  /** The address the account was linked with. */
  provider_email: string;
  /** The handle at the provider, when one was returned. */
  provider_username: string | null;
}

/**
 * The one provider whose remotes this screen can browse.
 *
 * The limitation is the ticket's first acceptance criterion and is *unchanged* — only the fact
 * that it is now stated up front is new. GitLab and Bitbucket have no server-side listing
 * endpoint in this app, so a picker for them would be an empty box with no explanation.
 */
export const BROWSABLE_PROVIDER = 'github';

/**
 * Whether a provider's remotes can be listed from the dashboard.
 *
 * @param provider The provider string from a linked account, in any case, possibly absent.
 * @returns True only for GitHub.
 */
export function canBrowseRemotes(provider: string | null | undefined): boolean {
  return (provider ?? '').trim().toLowerCase() === BROWSABLE_PROVIDER;
}

/**
 * What an account is called on its tile.
 *
 * The handle when the provider returned one, because that is what the reader recognises in a
 * repository path; the address otherwise, because an unlabelled tile is unusable.
 *
 * @param account The account.
 * @returns Its display label, never empty for an account with either field set.
 */
export function linkedAccountLabel(account: LinkedAccount): string {
  const handle = account.provider_username?.trim();
  return handle || account.provider_email;
}

/**
 * A provider string as a title-cased name.
 *
 * The known three get their own spelling — `GitHub`, not `Github` — and anything else is
 * returned with its first letter raised rather than being forced into the list. A provider this
 * app has not been told about is still a real account the reader linked.
 *
 * @param provider The raw provider string.
 * @returns The name to print.
 */
export function linkedAccountProviderName(provider: string | null | undefined): string {
  const raw = (provider ?? '').trim();
  if (!raw) return 'Account';
  const known: Readonly<Record<string, string>> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
  };
  return known[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * A linked account's provider as the one the repositories vocabulary knows.
 *
 * So the account tile draws the same tinted mark the repositories table draws for the same
 * service — `ProviderGlyph` is keyed by this type, and there is exactly one provider palette in
 * the product. A provider this app has not been told about falls back to `public_url`, whose
 * mark is a globe: honest for "some Git host", and never another service's logo.
 *
 * @param provider The raw provider string from the account row.
 * @returns The matching vocabulary member.
 */
export function linkedAccountProvider(provider: string | null | undefined): RepositoryProvider {
  const raw = (provider ?? '').trim().toLowerCase();
  if (raw === 'github' || raw === 'gitlab' || raw === 'bitbucket') return raw;
  return 'public_url';
}

/**
 * Read the linked-account list out of what `getLinkedAccountsForUser` returns.
 *
 * That helper answers with a JSON *string*, and the screen this replaces parsed it inside a
 * `try` whose `catch` silently produced an empty list — so a malformed payload and a reader
 * with no accounts looked identical. Parsing is here so the two can be told apart in a test,
 * and so every non-object row is dropped rather than reaching a tile that would render
 * `undefined`.
 *
 * @param raw The JSON string, or anything else.
 * @returns The accounts that parsed, in the order given; empty when nothing did.
 */
export function parseLinkedAccounts(raw: unknown): LinkedAccount[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is LinkedAccount =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as LinkedAccount).id === 'string' &&
      (row as LinkedAccount).id.length > 0
  );
}

/**
 * The account to select when the list arrives.
 *
 * Exactly one account is not a choice, so the screen makes it. Two or more is a choice and the
 * screen must not make it — pre-selecting one there would register the repository against an
 * account the reader never picked.
 *
 * @param accounts The parsed accounts.
 * @returns The id to select, or null to leave the picker empty.
 */
export function autoSelectedAccountId(accounts: readonly LinkedAccount[]): string | null {
  return accounts.length === 1 ? accounts[0].id : null;
}

// ---------------------------------------------------------------------------------------
// Remote repositories
// ---------------------------------------------------------------------------------------

/** One repository as the provider describes it. */
export interface RemoteRepo {
  /** The provider's own id — the picker's key and selection identity. */
  id: number;
  /** The bare name, `payments-specs`. */
  name: string;
  /** `owner/name`, which is what the row prints. */
  full_name: string;
  /** The provider's description, when it has one. */
  description?: string | null;
  /** Whether the repository is private — the row's lock. */
  private?: boolean;
  /** The branch a scan would start from. */
  default_branch?: string;
  /** The web URL, which is what the clone URL is derived from. */
  html_url?: string;
}

/**
 * `owner/repo` as `owner / repo`.
 *
 * The space either side of the slash is not decoration: for a reader in a dozen organizations
 * the owner is the part they are scanning for, and `acme/orders` sets it in the same visual run
 * as the name. A value with no slash, a leading slash or a trailing slash is returned unchanged
 * rather than being cut in half.
 *
 * @param fullName The provider's `owner/name`, possibly absent.
 * @returns The spaced form, or the input trimmed when it is not an `owner/name` pair.
 */
export function formatGroupAndRepoName(fullName: string | undefined | null): string {
  const raw = (fullName || '').trim();
  if (!raw) return '';
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return raw;
  return `${raw.slice(0, slash)} / ${raw.slice(slash + 1)}`;
}

/**
 * The HTTPS clone URL for a repository the reader picked from the list.
 *
 * @param htmlUrl The provider's web URL for the repository.
 * @returns The same URL with a single `.git` suffix, or undefined when there was no URL.
 */
export function cloneUrlFromHtml(htmlUrl: string | undefined | null): string | undefined {
  if (!htmlUrl?.trim()) return undefined;
  const base = htmlUrl.trim().replace(/\/+$/, '');
  return base.endsWith('.git') ? base : `${base}.git`;
}

/**
 * The remote list in the order the picker draws it: by full name, case-insensitively.
 *
 * @param repos The provider's list.
 * @returns A new sorted array; the input is not mutated.
 */
export function sortRemoteRepos(repos: readonly RemoteRepo[]): RemoteRepo[] {
  return [...repos].sort((a, b) =>
    (a.full_name || '').toLowerCase().localeCompare((b.full_name || '').toLowerCase())
  );
}

/**
 * The rows a search term leaves.
 *
 * Matches the name, the full name and the description, so both `orders` and `acme/orders` find
 * the same row and a reader who remembers what a repository is *for* can find it by that.
 *
 * @param repos The sorted list.
 * @param query What the reader typed; blank returns everything.
 * @returns The matching rows, in the given order.
 */
export function filterRemoteRepos(repos: readonly RemoteRepo[], query: string): RemoteRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  return repos.filter((repo) => {
    const haystack = [repo.name, repo.full_name, repo.description ?? '']
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Read the repository list out of the browse endpoint's payload.
 *
 * @param payload The parsed JSON body.
 * @returns The repositories, sorted; empty when the payload carried none.
 */
export function remoteReposFromPayload(payload: unknown): RemoteRepo[] {
  const list = (payload as { repositories?: unknown } | null)?.repositories;
  if (!Array.isArray(list)) return [];
  return sortRemoteRepos(
    list.filter(
      (row): row is RemoteRepo =>
        typeof row === 'object' && row !== null && typeof (row as RemoteRepo).id === 'number'
    )
  );
}

// ---------------------------------------------------------------------------------------
// The public URL
// ---------------------------------------------------------------------------------------

/**
 * Whether a string is shaped like a public HTTPS clone URL.
 *
 * Shape only — `https://` and a dotted host. Whether it *resolves* is what the Test button is
 * for, and this deliberately does not guess: a self-hosted GitLab on a private domain is a
 * perfectly good answer that no pattern can approve.
 *
 * @param url What the reader typed.
 * @returns True when the shape is right.
 */
export function isPublicCloneUrl(url: string): boolean {
  return /^https:\/\/.+\..+/.test(url.trim());
}

/** What the Test button found out. */
export interface UrlTestResult {
  /** Whether the URL answered. */
  ok: boolean;
  /** The server's sentence, or this module's own when the server was not reached. */
  message: string;
}

/** The tone the result line takes — resolved through the shared vocabulary, never a hue. */
export function urlTestTone(result: UrlTestResult): StatusTone {
  return result.ok ? 'ok' : 'danger';
}

// ---------------------------------------------------------------------------------------
// Can the reader continue?
// ---------------------------------------------------------------------------------------

/** Everything the two validity rules read. */
export interface AddRepositoryDraft {
  /** Which card is selected. */
  source: AddRepositorySource;
  /** The chosen linked account, when the source is `linked`. */
  accountId: string | null;
  /** The chosen remote repository, when the source is `linked`. */
  repo: RemoteRepo | null;
  /** What the reader typed, when the source is `public_url`. */
  url: string;
  /** The last Test outcome for exactly that URL, or null when it has not been tested. */
  urlTest: UrlTestResult | null;
}

/**
 * Why the reader cannot continue yet, or null when they can.
 *
 * One function answers both questions the screen asks — whether to disable the button, and what
 * to say when it is pressed anyway — because the screen this replaces answered them with two
 * separate expressions that had already drifted apart.
 *
 * The public-URL rule is the strict one on purpose: a shape that looks right is not enough,
 * the Test must have *passed* for this exact URL. `urlTest` is cleared by the screen whenever
 * the field changes, so a stale pass cannot approve a URL that was edited after it.
 *
 * @param draft The current state of the form.
 * @returns The sentence to show, or null when the form is complete.
 */
export function addRepositoryBlocker(draft: AddRepositoryDraft): string | null {
  if (draft.source === 'public_url') {
    if (!isPublicCloneUrl(draft.url)) return ENTER_HTTPS_URL_TOAST;
    if (draft.urlTest?.ok !== true) return TEST_BEFORE_CONTINUE_TOAST;
    return null;
  }
  if (!draft.accountId) return PICK_ACCOUNT_TOAST;
  if (!draft.repo) return PICK_REPOSITORY_TOAST;
  return null;
}

/**
 * Whether the form is complete.
 *
 * @param draft The current state of the form.
 * @returns True when {@link addRepositoryBlocker} has nothing to say.
 */
export function canSubmitAddRepository(draft: AddRepositoryDraft): boolean {
  return addRepositoryBlocker(draft) === null;
}

/** The body of the create call, for the source the reader chose. */
export type AddRepositoryRequest =
  | { source: 'public_url'; clone_url: string }
  | {
      source: 'linked_account';
      linked_account_id: string;
      repository_full_name: string | undefined;
      clone_url: string | undefined;
    };

/**
 * The request body for a complete draft.
 *
 * @param draft The form, which must satisfy {@link canSubmitAddRepository}.
 * @returns The JSON body to POST.
 * @throws If the draft is not complete — a caller that skipped the check has a bug, and a
 *   half-filled body would be written to the database as a repository nobody can scan.
 */
export function addRepositoryRequestBody(draft: AddRepositoryDraft): AddRepositoryRequest {
  const blocker = addRepositoryBlocker(draft);
  if (blocker) throw new Error(blocker);
  if (draft.source === 'public_url') {
    return { source: 'public_url', clone_url: draft.url.trim() };
  }
  return {
    source: 'linked_account',
    linked_account_id: draft.accountId as string,
    repository_full_name: draft.repo?.full_name,
    clone_url: cloneUrlFromHtml(draft.repo?.html_url),
  };
}

/**
 * The id of the repository a successful create returned.
 *
 * @param payload The parsed response body.
 * @returns The id as a string, or null when the response carried none — in which case the
 *   screen stays put rather than navigating to `/undefined/preview`.
 */
export function createdRepositoryId(payload: unknown): string | null {
  const id = (payload as { repository?: { id?: unknown } } | null)?.repository?.id;
  if (id === null || id === undefined || id === '') return null;
  return String(id);
}

/**
 * The sentence to show for a failed write.
 *
 * The API answers in four shapes — `{error}`, `{detail: string}`, FastAPI's
 * `{detail: [{msg}]}` and nothing at all — and the screen this replaces unpicked all four
 * inline. Pulled out so each is a test rather than a nested ternary.
 *
 * @param payload The parsed response body, whatever shape it came in.
 * @param fallback What to say when the payload explains nothing — the status text.
 * @returns The message to print.
 */
export function addRepositoryErrorMessage(payload: unknown, fallback: string): string {
  const body = payload as { error?: unknown; detail?: unknown } | null;
  if (typeof body?.error === 'string' && body.error.trim()) return body.error;
  if (typeof body?.detail === 'string' && body.detail.trim()) return body.detail;
  if (Array.isArray(body?.detail) && body.detail.length > 0) {
    const first = body.detail[0] as { msg?: unknown } | null;
    if (first && typeof first === 'object' && typeof first.msg === 'string' && first.msg.trim()) {
      return first.msg;
    }
  }
  return fallback || REQUEST_FAILED;
}

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------
// Every sentence the mockup's Keeps (1:1) list pins, and nothing else. The screen imports
// these; it never writes a string of its own.

/** The page's `h1`. */
export const PAGE_TITLE = 'Add a repository';

/** The line under it. DESIGN.md §5.3 asks for 14 words or fewer; this is 12. */
export const PAGE_DESCRIPTION =
  'Register a repository so Apiome can scan it for importable specifications.';

/** The source card's heading and its sub-line. */
export const SOURCE_CARD_TITLE = 'Where does the repository live?';
export const SOURCE_CARD_HINT = 'Choose a linked account or paste a public Git URL.';

/** The linked-accounts card. */
export const ACCOUNTS_CARD_TITLE = 'Linked accounts';
export const MANAGE_ACCOUNTS_LABEL = 'Manage linked accounts →';
export const ACCOUNTS_LOADING = 'Loading linked accounts…';
export const ACCOUNTS_EMPTY_TITLE = 'No linked accounts yet';
export const ACCOUNTS_EMPTY_BODY = 'Connect GitHub or GitLab to browse private repositories.';
export const ACCOUNTS_AUTOSELECT_NOTE = 'Auto-selected when exactly one account is linked.';

/**
 * The limitation, stated before the reader can trip over it — acceptance criterion 1.
 *
 * The screen this replaces only said it *after* a GitLab account had been selected and the
 * picker had failed to appear, which is the wrong moment: by then the reader has already
 * concluded the feature is broken.
 */
export const BROWSE_LIMITATION_NOTE =
  'Remote browsing is available for GitHub accounts only. Other providers register through Public Git URL.';

/**
 * The same limitation for the account the reader actually chose, kept verbatim from the screen
 * this replaces.
 *
 * @param provider The chosen account's provider.
 * @returns The sentence naming that provider.
 */
export function nonBrowsableProviderNote(provider: string | null | undefined): string {
  const name = (provider ?? '').trim() ? linkedAccountProviderName(provider) : 'this provider';
  return (
    'Browsing repositories from the dashboard is available for GitHub linked accounts. ' +
    `For ${name}, use Public Git URL above, or link a GitHub account.`
  );
}

/** The repository picker. */
export const REPO_CARD_TITLE = 'Choose a repository';
export const REPO_CARD_HINT =
  'Each row lists group / repository (organization or user, then repo name). Private repositories show a lock, and the provider’s description follows the name.';
export const REPOS_LOADING = 'Loading repositories…';
export const REPOS_EMPTY = 'No repositories returned for this account.';
export const REPOS_LOAD_ERROR = 'Could not load repositories. Check your connection and try again.';

/**
 * The picker's search placeholder.
 *
 * @param accountLabel The chosen account's handle or address.
 * @returns The placeholder naming that account.
 */
export function repoSearchPlaceholder(accountLabel: string): string {
  return `Search repositories for ${accountLabel}…`;
}

/**
 * What a search that matched nothing says.
 *
 * @param query What the reader typed.
 * @returns The sentence quoting it back.
 */
export function reposSearchMiss(query: string): string {
  return `No repositories match “${query.trim()}”.`;
}

/** The public-URL card. */
export const URL_CARD_TITLE = 'Public clone URL';
export const URL_FIELD_LABEL = 'HTTPS URL';
export const URL_FIELD_PLACEHOLDER = 'https://github.com/org/public-repo.git';
export const URL_FIELD_HINT =
  'Must be reachable without credentials. Private repositories require a linked account instead.';
export const URL_TEST_LABEL = 'Test';
export const URL_TEST_BUSY_LABEL = 'Testing…';
export const URL_TEST_OK_TOAST = 'URL looks reachable.';
export const URL_TEST_NEEDS_HTTPS_TOAST = 'Enter an HTTPS clone URL to test.';
export const URL_TEST_UNAUTHORIZED_TOAST = 'Sign in to test this URL.';
export const URL_TEST_UNREACHABLE =
  'Could not reach the test service. Check your connection and try again.';
export const URL_TEST_UNEXPECTED = 'Unexpected response from server.';
/** What the field says before it has been tested — the second acceptance criterion's baseline. */
export const URL_TEST_UNTESTED = 'Not tested yet.';

/** The five blocking toasts. */
export const SELECT_TENANT_TOAST = 'Select a tenant first.';
export const ENTER_HTTPS_URL_TOAST = 'Enter an HTTPS clone URL.';
export const TEST_BEFORE_CONTINUE_TOAST =
  'Use Test and confirm the URL succeeds before continuing.';
export const PICK_ACCOUNT_TOAST = 'Pick a linked account.';
export const PICK_REPOSITORY_TOAST = 'Pick a repository from the list.';

/** The write's outcomes. */
export const REGISTERED_TOAST = 'Repository registered.';
export const NOT_ENABLED_MESSAGE = 'Repository API is not enabled yet.';
export const IMPORT_FAILED_TITLE = 'Import failed';
export const IMPORT_FAILED_REMEDY =
  'Fix the problem above and try again, or choose a different source.';
export const REQUEST_FAILED = 'Request failed.';

/** The footer. */
export const CANCEL_LABEL = 'Cancel';
export const BACK_LABEL = 'Back';
export const BACK_DISABLED_TIP = 'Source is the first step — there is nothing behind it.';
export const CONTINUE_LABEL = 'Continue';
export const SUBMITTING_LABEL = 'Adding…';

/** The no-workspace gate. */
export const GATE_DESCRIPTION = 'A repository is registered against one workspace.';
