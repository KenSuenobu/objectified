'use client';

/**
 * Linked accounts — `/ade/dashboard/linked-accounts` (HIVE-4.8, #5302).
 *
 * Mockup: `docs/mockups/account/linked-accounts.html`. Design language: `docs/mockups/DESIGN.md`
 * §5.3 (page header + tab row), §7 (one primary action, the status vocabulary), §8 (a list page's
 * table, and the destructive confirm).
 *
 * ## What was wrong
 *
 * The page drew its own `<header>` inside the shell's `<main>` — a second header for a page that
 * already has one — with an `indigo` glyph beside an `h2` that was really the page's `h1`. Under
 * it sat a hand-rolled table built from the `dashboardScreenClasses.ts` string constants, so it
 * had no caption, no `scope`d headers, no keyboard row navigation and no skeleton rows, and its
 * empty state replaced the entire card rather than sitting inside it. The rest was named colours:
 * `bg-gray-100 dark:bg-gray-700` icon tiles, `text-amber-600 dark:text-amber-400` for the
 * last-method note, and a `text-red-600 hover:bg-red-50 …` cluster of four utilities standing in
 * for the one `danger-soft` button role. None of those could follow a theme.
 *
 * Worse, the guard that matters most here explained itself only on hover: the last-remaining
 * sign-in method disabled its Unlink and put the reason in a `title`, which a keyboard or screen
 * reader user never reaches.
 *
 * ## What it is now
 *
 * `Page` / `PageHeader` / `PageBody` (HIVE-3.5) with the account tab strip HIVE-4.7 built —
 * **Profile · Linked accounts · Preferences** — carrying the linked count, then the HIVE-2.3
 * `DataTable`, then the provider grid, in the mockup's order.
 *
 * Every capability the page had is here: the `?linked=true` / `?error=` handshake and its URL
 * cleanup, the last-method guard, the OAuth link round trip, and all three Personal Access Token
 * flows with their provider-specific scope copy. What is new is that the guard now says itself
 * three ways (see `LinkedAccountsTable`), the two confirms name what the click costs as DESIGN.md
 * §8 requires, and the list has a loading state instead of appearing fully formed.
 *
 * ## Where the logic went
 *
 * Everything that can be decided without a DOM is in `linkedAccountsModel.ts` — the row and card
 * view models, the query-string handshake, the confirm copy and the scope tables — so this file
 * is the page's *wiring*: session, loads, writes, and which banner is showing.
 *
 * ## Why it is still a client component
 *
 * The session is what every read is scoped by and `useAuthSession` is a hook; the query-string
 * handshake can only be read (and scrubbed) in a browser; and the link round trip ends in
 * `signIn()`, which navigates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

import { signIn, useAuthSession } from '@lib/auth/session-client';
import {
  getLinkedAccountsForUser,
  getUserHasPassword,
  removePersonalAccessToken,
  unlinkExternalAccount,
  updatePersonalAccessToken,
} from '@lib/db/helper';
import type { ProviderSummary } from '@lib/auth/provider-registry';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import PageHeader from '@/app/components/shell/PageHeader';
import { useDialog } from '@/app/components/providers/DialogProvider';
import {
  AccountTabs,
  LinkedAccountsTable,
  PatDialog,
  ProviderCard,
  buildLinkedAccountRows,
  buildProviderCards,
  parsePayload,
  readActionError,
  readLinkOutcome,
  removePatConfirmOptions,
  unlinkConfirmOptions,
  accountHandle,
  describeRemainingMethods,
  LINKED_ACCOUNTS_PATH,
  type LinkedAccount,
  type LinkedAccountRow,
  type ProviderCardModel,
} from '@/app/components/ade/account';

/** The `/ade/dashboard` home, which the breadcrumb's first step returns to. */
const HOME_ROUTE = '/ade/dashboard';

/** The provider grid's anchor, which both "Link a provider" affordances point at. */
const ADD_PROVIDER_ANCHOR = 'linked-add-provider';

/** Which linked identity the token dialog is editing, and how to title it. */
interface PatTarget {
  /** `external_auth_providers.id` — what the write is scoped by. */
  accountId: string | null;
  /** The provider's registry id. */
  providerId: string;
  /** Its display name. */
  label: string;
  /** The handle or address at the provider. */
  handle: string;
  /** Whether a token is already stored against the identity. */
  hasToken: boolean;
}

/** Props for {@link LinkedAccountsClient}. */
export interface LinkedAccountsClientProps {
  /** Registry summaries for every known provider (enabled or not), resolved server-side. */
  providers: ProviderSummary[];
}

/**
 * The Linked accounts page.
 *
 * @param props See {@link LinkedAccountsClientProps}.
 * @returns The page's header and body, or the loading state while there is no session.
 */
const LinkedAccountsClient = ({ providers }: LinkedAccountsClientProps) => {
  const { data: session } = useAuthSession();
  const { confirm: confirmDialog } = useDialog();

  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  /** Whether the reader has a usable password sign-in method (OLO-2.4 last-method guard). */
  const [hasPassword, setHasPassword] = useState(false);
  /** The first load, which draws skeleton rows rather than an empty list. */
  const [isLoading, setIsLoading] = useState(true);
  /** A write in flight, which disables every control that could start a second one. */
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [patTarget, setPatTarget] = useState<PatTarget | null>(null);

  const userId = (session?.user as { user_id?: string } | undefined)?.user_id;

  /** Guards the one-shot query-string handshake against a second run in Strict Mode. */
  const outcomeRead = useRef(false);

  /**
   * Load the reader's identities and whether they have a password.
   *
   * The two are asked together because the guard needs both: "this is your only sign-in method"
   * is a statement about the identities *and* the password, and answering it from one of them
   * arriving before the other would flicker the guard on and off.
   */
  const loadLinkedAccounts = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      const [accountsResult, passwordResult] = await Promise.all([
        getLinkedAccountsForUser(userId),
        getUserHasPassword(userId),
      ]);
      setLinkedAccounts(parsePayload<LinkedAccount[]>(accountsResult, Array.isArray, []));
      const { hasPassword: password } = parsePayload<{ hasPassword?: boolean }>(
        passwordResult,
        (value) => value != null && typeof value === 'object',
        {}
      );
      setHasPassword(Boolean(password));
    } catch {
      setErrorMessage('Failed to load linked accounts');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void loadLinkedAccounts();
  }, [userId, loadLinkedAccounts]);

  // The banner NextAuth's callback asked for, read once and then scrubbed out of the address
  // bar: a `?linked=true` left in the URL would re-announce on every reload, and a shared link
  // would announce a link that never happened.
  useEffect(() => {
    if (!userId || outcomeRead.current) return;
    outcomeRead.current = true;

    const outcome = readLinkOutcome(window.location.search);
    if (outcome.success) setSuccessMessage(outcome.success);
    if (outcome.error) setErrorMessage(outcome.error);
    if (outcome.cleanUrl) window.history.replaceState({}, '', LINKED_ACCOUNTS_PATH);
  }, [userId]);

  const rows = useMemo(
    () => buildLinkedAccountRows({ accounts: linkedAccounts, providers, hasPassword }),
    [linkedAccounts, providers, hasPassword]
  );

  const providerCards = useMemo(
    () => buildProviderCards({ providers, accounts: linkedAccounts }),
    [providers, linkedAccounts]
  );

  /** Clear both banners — every write starts by dropping the last one's news. */
  const resetBanners = useCallback(() => {
    setErrorMessage('');
    setSuccessMessage('');
  }, []);

  const handleLinkAccount = useCallback(
    async (providerId: string) => {
      try {
        // The pre-flight is the server's chance to refuse a link this account cannot have
        // (already linked, bound elsewhere) *before* the reader is bounced to the provider.
        const response = await fetch(`/api/auth/link/${providerId}`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) {
          const failure = await response.json().catch(() => ({ error: 'Unknown error' }));
          setErrorMessage(`Failed to initiate account linking: ${failure.error || 'Unknown error'}`);
          return;
        }
        signIn(providerId, { callbackUrl: LINKED_ACCOUNTS_PATH });
      } catch {
        setErrorMessage('An error occurred while linking the account');
      }
    },
    []
  );

  const handleUnlinkAccount = useCallback(
    async (row: LinkedAccountRow) => {
      const confirmed = await confirmDialog(
        unlinkConfirmOptions({
          label: row.label,
          handle: row.handle,
          hasPat: row.hasPat,
          remaining: describeRemainingMethods({
            hasPassword,
            otherLabels: rows.filter((other) => other.id !== row.id).map((other) => other.label),
          }),
        })
      );
      if (!confirmed) return;

      setIsBusy(true);
      resetBanners();
      try {
        const failure = readActionError(
          await unlinkExternalAccount(userId as string, row.id),
          'Failed to unlink account'
        );
        if (failure) {
          setErrorMessage(failure);
          return;
        }
        setSuccessMessage(`Successfully unlinked ${row.label} account`);
        await loadLinkedAccounts();
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : 'An error occurred while unlinking the account'
        );
      } finally {
        setIsBusy(false);
      }
    },
    [confirmDialog, hasPassword, loadLinkedAccounts, resetBanners, rows, userId]
  );

  const handleOpenPatDialog = useCallback((provider: ProviderCardModel) => {
    resetBanners();
    setPatTarget({
      accountId: provider.account?.id ?? null,
      providerId: provider.id,
      label: provider.label,
      handle: provider.account ? accountHandle(provider.account) : '',
      hasToken: provider.patSuffix !== null,
    });
  }, [resetBanners]);

  /**
   * Save the token the dialog collected.
   *
   * @param token The token as typed.
   * @returns `null` when it saved, or the message the dialog should show.
   */
  const handleSavePatToken = useCallback(
    async (token: string): Promise<string | null> => {
      if (!patTarget) return 'No linked account found. Please link your account first.';
      // Unreachable from the UI — the PAT row only exists on a linked card — but the id is what
      // the write is scoped by, so it is checked rather than assumed.
      if (!patTarget.accountId) return 'No linked account found. Please link your account first.';

      setIsBusy(true);
      try {
        const failure = readActionError(
          await updatePersonalAccessToken(userId as string, patTarget.accountId, token),
          'Failed to save Personal Access Token'
        );
        if (failure) return failure;
        setSuccessMessage(
          `Successfully ${patTarget.hasToken ? 'updated' : 'added'} Personal Access Token`
        );
        await loadLinkedAccounts();
        return null;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'An error occurred while saving the Personal Access Token';
      } finally {
        setIsBusy(false);
      }
    },
    [loadLinkedAccounts, patTarget, userId]
  );

  const handleRemovePatToken = useCallback(
    async (provider: ProviderCardModel) => {
      const account = provider.account;
      if (!account) return;

      const confirmed = await confirmDialog(
        removePatConfirmOptions({
          label: provider.label,
          handle: accountHandle(account),
          suffix: provider.patSuffix,
        })
      );
      if (!confirmed) return;

      setIsBusy(true);
      resetBanners();
      try {
        const failure = readActionError(
          await removePersonalAccessToken(userId as string, account.id),
          'Failed to remove Personal Access Token'
        );
        if (failure) {
          setErrorMessage(failure);
          return;
        }
        setSuccessMessage(`Successfully removed Personal Access Token for ${provider.label}`);
        await loadLinkedAccounts();
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'An error occurred while removing the Personal Access Token'
        );
      } finally {
        setIsBusy(false);
      }
    },
    [confirmDialog, loadLinkedAccounts, resetBanners, userId]
  );

  if (!session) {
    return (
      <Page>
        <PageBody>
          <LoadingState minHeightClassName="min-h-64" message="Loading linked accounts..." />
        </PageBody>
      </Page>
    );
  }

  /** Both "Link a provider" affordances: a plain anchor, so it works with no JavaScript. */
  const addProviderAction = (
    <Button asChild variant="outline" size="sm">
      <a href={`#${ADD_PROVIDER_ANCHOR}`}>
        <Plus aria-hidden />
        Link a provider
      </a>
    </Button>
  );

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Account' },
          { label: 'Linked accounts' },
        ]}
        title="Linked accounts"
        description="Link external accounts for single sign-on and repository access."
        actions={addProviderAction}
        tabs={
          <AccountTabs
            current="linked-accounts"
            linkedCount={isLoading ? undefined : linkedAccounts.length}
          />
        }
      />

      <PageBody>
        {successMessage && (
          <Alert variant="ok" onClose={() => setSuccessMessage('')} data-testid="linked-success">
            {successMessage}
          </Alert>
        )}
        {errorMessage && (
          <Alert variant="danger" onClose={() => setErrorMessage('')} data-testid="linked-error">
            {errorMessage}
          </Alert>
        )}

        <LinkedAccountsTable
          rows={rows}
          loading={isLoading}
          hasPassword={hasPassword}
          busy={isBusy}
          onUnlink={handleUnlinkAccount}
          emptyAction={addProviderAction}
        />

        <section id={ADD_PROVIDER_ANCHOR} aria-labelledby={`${ADD_PROVIDER_ANCHOR}-title`}>
          <div className="lnk-section-title">
            {/* `h2` carries its type from the unlayered base rule in `globals.css`, which
                outranks every utility class — so it is not given one here. */}
            <h2 id={`${ADD_PROVIDER_ANCHOR}-title`}>Add a provider</h2>
            <span className="lnk-section-title__note">
              Only the providers this deployment enables are listed.
            </span>
          </div>

          <div className="lnk-providers">
            {providerCards.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                // Also while the identities are loading: until they land the card does not yet
                // know whether this provider is linked, and a Link on an already-linked
                // provider is a round trip the server is only going to refuse.
                busy={isBusy || isLoading}
                onLink={handleLinkAccount}
                onEditPat={handleOpenPatDialog}
                onRemovePat={handleRemovePatToken}
              />
            ))}
          </div>
        </section>

        <Alert variant="info">
          You can link multiple providers. Once linked, you can sign in with any of them.
        </Alert>

        {patTarget && (
          <PatDialog
            open
            onOpenChange={(next) => !next && setPatTarget(null)}
            providerId={patTarget.providerId}
            providerLabel={patTarget.label}
            handle={patTarget.handle}
            hasToken={patTarget.hasToken}
            onSubmit={handleSavePatToken}
          />
        )}
      </PageBody>
    </Page>
  );
};

export default LinkedAccountsClient;
