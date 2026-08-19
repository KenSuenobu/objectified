'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';
import { getLinkedAccountsForUser } from '@lib/db/helper';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Alert, AlertDescription, AlertTitle } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { GatedState } from '@/app/components/ui/EmptyState';
import { Spinner } from '@/app/components/ui/Spinner';
import { Stepper } from '@/app/components/ui/Stepper';

import {
  ACCOUNTS_CARD_TITLE,
  ADD_REPOSITORY_STEPS,
  BACK_DISABLED_TIP,
  BACK_LABEL,
  CANCEL_LABEL,
  CONTINUE_LABEL,
  DEFAULT_SOURCE,
  GATE_DESCRIPTION,
  IMPORT_FAILED_REMEDY,
  IMPORT_FAILED_TITLE,
  LINKED_ACCOUNTS_HREF,
  LIVE_STEP_ID,
  MANAGE_ACCOUNTS_LABEL,
  NOT_ENABLED_MESSAGE,
  PAGE_DESCRIPTION,
  PAGE_TITLE,
  PROPOSED_STEPS_BADGE,
  PROPOSED_STEPS_TIP,
  REGISTERED_TOAST,
  REPOSITORIES_API,
  REPOSITORIES_HREF,
  REPOS_LOAD_ERROR,
  REPO_CARD_TITLE,
  REQUEST_FAILED,
  SELECT_TENANT_TOAST,
  SOURCE_CARD_HINT,
  SOURCE_CARD_TITLE,
  STEPPER_LABEL,
  SUBMITTING_LABEL,
  TEST_PUBLIC_URL_API,
  URL_CARD_TITLE,
  URL_TEST_NEEDS_HTTPS_TOAST,
  URL_TEST_OK_TOAST,
  URL_TEST_UNAUTHORIZED_TOAST,
  URL_TEST_UNEXPECTED,
  URL_TEST_UNREACHABLE,
  addRepositoryBlocker,
  addRepositoryErrorMessage,
  addRepositoryRequestBody,
  autoSelectedAccountId,
  canBrowseRemotes,
  canSubmitAddRepository,
  createdRepositoryId,
  githubReposHref,
  linkedAccountLabel,
  parseLinkedAccounts,
  remoteReposFromPayload,
  repositoryPreviewHref,
  type AddRepositoryDraft,
  type AddRepositorySource,
  type LinkedAccount,
  type RemoteRepo,
  type UrlTestResult,
} from '@/app/components/ade/repositories/addRepositoryModel';
import {
  AddRepositorySourceChoice,
  LinkedAccountPicker,
  ProposedStepsCard,
  PublicCloneUrlField,
  RemoteRepositoryPicker,
} from '@/app/components/ade/repositories';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** The proposal card's id — the progress chip describes itself with it. */
const PROPOSAL_ID = 'repo-proposed-steps';

/**
 * Bring in → Repositories → Add a repository (HIVE-7.4, #5321).
 *
 * Authority: `docs/mockups/sources/repository-new.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §7 (cards, fields, one
 * primary action) and §9 (the a11y bar).
 *
 * ### What this screen is
 *
 * The only write in the Repositories section: it registers a Git repository against the current
 * workspace, from a connected account or from a public HTTPS URL. It is step 1 of a four-step
 * flow of which only step 1 exists — see {@link ProposedStepsCard} for what the other three
 * would be and why they are drawn at all.
 *
 * ### What it owns, and what it no longer does
 *
 * It owns the two reads, the write, and which card is open. It owns none of the *rules*:
 * whether Continue is available, which sentence explains it when it is not, what the request
 * body is, which of the API's four error shapes carries the message, and every word of copy all
 * live in `addRepositoryModel`, where they are tested without rendering a screen. The 643-line
 * page this replaces had every one of them inline — which is how its `canContinue` expression
 * and its "why not" branch came to disagree about whether a URL had been tested.
 *
 * ### Five things this fixes rather than restyles
 *
 * 1. **The four-step progress row was a lie.** It drew steps 2–4 as ordinary upcoming steps,
 *    and then committed from step 1 and left. The row is now marked, and the proposal is
 *    stated as a proposal — the ticket's third acceptance criterion.
 * 2. **The GitHub-only limitation was discovered, not stated.** It appeared only after a
 *    non-GitHub account had been selected and the picker had failed to appear. The linked-
 *    accounts card now says it up front and chips each affected tile — criterion one.
 * 3. **The URL test gave no standing feedback.** An untested URL and a passing one looked
 *    identical, and the result was never announced. There is a live status line now, whose
 *    first state is "Not tested yet" — criterion two.
 * 4. **Nothing was reachable by keyboard.** The source cards, the account tiles and every
 *    repository row were `<button>`s or bare `<label>`s in no group: a reader could not move
 *    between choices with the arrow keys, and nothing announced how many there were. All three
 *    are `ui/RadioGroup`s now.
 * 5. **A failed remote read was a red sentence with no way out.** It is an `ErrorState` with a
 *    retry, which re-runs the read rather than making the reader re-pick the account.
 *
 * Cancel — in the header, in the footer, and as the breadcrumb's Repositories crumb — returns
 * to the list, which is the ticket's fourth acceptance criterion.
 */
export default function AddRepositoryClient() {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;
  const userId = (session?.user as { user_id?: string } | undefined)?.user_id;

  // ---- the form ------------------------------------------------------------------------

  const [source, setSource] = React.useState<AddRepositorySource>(DEFAULT_SOURCE);
  const [accounts, setAccounts] = React.useState<LinkedAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = React.useState(false);
  const [selectedAccountId, setSelectedAccountId] = React.useState<string | null>(null);

  const [repos, setRepos] = React.useState<RemoteRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = React.useState(false);
  const [reposError, setReposError] = React.useState<string | null>(null);
  const [reposReload, setReposReload] = React.useState(0);
  const [repoQuery, setRepoQuery] = React.useState('');
  const [selectedRepo, setSelectedRepo] = React.useState<RemoteRepo | null>(null);

  const [url, setUrl] = React.useState('');
  const [urlTest, setUrlTest] = React.useState<UrlTestResult | null>(null);
  const [testing, setTesting] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const selectedAccount = React.useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId]
  );

  const draft: AddRepositoryDraft = {
    source,
    accountId: selectedAccountId,
    repo: selectedRepo,
    url,
    urlTest,
  };
  const blocker = addRepositoryBlocker(draft);
  const canContinue = canSubmitAddRepository(draft);

  // ---- the reads -----------------------------------------------------------------------

  // The linked accounts. One read per signed-in user; `cancelled` is what stops a slow answer
  // from landing after the reader has navigated away.
  React.useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    setLoadingAccounts(true);
    void (async () => {
      try {
        const list = parseLinkedAccounts(await getLinkedAccountsForUser(userId));
        if (cancelled) return;
        setAccounts(list);
        setSelectedAccountId((current) => current ?? autoSelectedAccountId(list));
      } catch {
        if (!cancelled) setAccounts([]);
      } finally {
        if (!cancelled) setLoadingAccounts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // The chosen account's remotes. Only GitHub has a listing endpoint, so every other provider
  // resolves to an empty list and the picker's own note — never a spinner that never ends.
  React.useEffect(() => {
    if (source !== 'linked' || !selectedAccount || !canBrowseRemotes(selectedAccount.provider)) {
      setRepos([]);
      setSelectedRepo(null);
      setReposError(null);
      setLoadingRepos(false);
      return undefined;
    }

    let cancelled = false;
    setLoadingRepos(true);
    setReposError(null);
    setSelectedRepo(null);
    setRepoQuery('');

    void (async () => {
      try {
        const res = await fetch(githubReposHref(selectedAccount.id), { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setRepos([]);
          setReposError(addRepositoryErrorMessage(data, res.statusText || REPOS_LOAD_ERROR));
          return;
        }
        setRepos(remoteReposFromPayload(data));
      } catch {
        if (!cancelled) {
          setRepos([]);
          setReposError(REPOS_LOAD_ERROR);
        }
      } finally {
        if (!cancelled) setLoadingRepos(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, selectedAccount, reposReload]);

  // A passing test belongs to the string it was run against, so editing the field withdraws it.
  // Without this the strict half of `addRepositoryBlocker` would be defeated by typing.
  React.useEffect(() => {
    setUrlTest(null);
  }, [url]);

  // A failure describes the attempt that produced it. Change what is being imported and the
  // sentence is no longer about anything.
  React.useEffect(() => {
    setSubmitError(null);
  }, [source, selectedAccountId, selectedRepo, url]);

  // ---- the two writes ------------------------------------------------------------------

  /** Ask the server whether the typed URL answers, and keep the verdict beside the field. */
  const testPublicUrl = async () => {
    const candidate = url.trim();
    if (!/^https:\/\//i.test(candidate)) {
      toast.error(URL_TEST_NEEDS_HTTPS_TOAST);
      return;
    }
    setTesting(true);
    setUrlTest(null);
    try {
      const res = await fetch(TEST_PUBLIC_URL_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: candidate }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.status === 401) {
        toast.error(URL_TEST_UNAUTHORIZED_TOAST);
        setUrlTest({ ok: false, message: URL_TEST_UNAUTHORIZED_TOAST });
        return;
      }
      const ok = Boolean(data.ok);
      const message = typeof data.message === 'string' ? data.message : URL_TEST_UNEXPECTED;
      setUrlTest({ ok, message });
      if (ok) toast.success(URL_TEST_OK_TOAST);
      else toast.error(message);
    } catch {
      setUrlTest({ ok: false, message: URL_TEST_UNREACHABLE });
      toast.error(URL_TEST_UNREACHABLE);
    } finally {
      setTesting(false);
    }
  };

  /** Register the repository, and go to its preview. */
  const submit = async () => {
    if (!currentTenantId) {
      toast.error(SELECT_TENANT_TOAST);
      return;
    }
    if (blocker) {
      toast.error(blocker);
      return;
    }
    if (submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(REPOSITORIES_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addRepositoryRequestBody(draft)),
      });
      const data = await res.json().catch(() => ({}));

      // 501 is not a failure of this form: the endpoint exists and says the capability is off.
      // A toast plus the banner, and the reader's input is left exactly as it was.
      if (res.status === 501) {
        const message = addRepositoryErrorMessage(data, NOT_ENABLED_MESSAGE);
        toast.message(message);
        setSubmitError(message);
        return;
      }
      if (!res.ok) throw new Error(addRepositoryErrorMessage(data, res.statusText));

      toast.success(REGISTERED_TOAST);
      const id = createdRepositoryId(data);
      if (id) router.push(repositoryPreviewHref(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : REQUEST_FAILED;
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- the page ------------------------------------------------------------------------

  return (
    <Page width="narrow">
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'Repositories', href: REPOSITORIES_HREF },
          { label: 'Add repository' },
        ]}
        title={PAGE_TITLE}
        description={PAGE_DESCRIPTION}
        actions={
          <Button variant="ghost" asChild data-testid="repo-new-cancel-header">
            <Link href={REPOSITORIES_HREF}>{CANCEL_LABEL}</Link>
          </Button>
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={GATE_DESCRIPTION} />
        ) : (
          <>
            <div className="repo-new-progress">
              <Stepper
                steps={ADD_REPOSITORY_STEPS}
                current={LIVE_STEP_ID}
                aria-label={STEPPER_LABEL}
                data-testid="repo-new-stepper"
              />
              <Badge
                variant="honey"
                size="lg"
                title={PROPOSED_STEPS_TIP}
                aria-describedby={PROPOSAL_ID}
                data-testid="repo-new-proposed-badge"
              >
                {PROPOSED_STEPS_BADGE}
              </Badge>
            </div>

            <Card className="repo-new-card" data-testid="repo-new-source-card">
              <h2 className="repo-new-card__title">{SOURCE_CARD_TITLE}</h2>
              <p className="repo-new-note">{SOURCE_CARD_HINT}</p>
              <AddRepositorySourceChoice value={source} onChange={setSource} />
            </Card>

            {source === 'linked' ? (
              <Card className="repo-new-card" data-testid="repo-new-accounts-card">
                <div className="repo-new-card__head">
                  <h2 className="repo-new-card__title">{ACCOUNTS_CARD_TITLE}</h2>
                  <Link className="repo-new-link" href={LINKED_ACCOUNTS_HREF}>
                    {MANAGE_ACCOUNTS_LABEL}
                  </Link>
                </div>
                <LinkedAccountPicker
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  onSelect={setSelectedAccountId}
                  loading={loadingAccounts}
                />
              </Card>
            ) : null}

            {source === 'linked' && selectedAccount ? (
              <Card className="repo-new-card" data-testid="repo-new-repos-card">
                <h2 className="repo-new-card__title">{REPO_CARD_TITLE}</h2>
                <RemoteRepositoryPicker
                  account={selectedAccount}
                  accountLabel={linkedAccountLabel(selectedAccount)}
                  browsable={canBrowseRemotes(selectedAccount.provider)}
                  repos={repos}
                  loading={loadingRepos}
                  error={reposError}
                  onRetry={() => setReposReload((n) => n + 1)}
                  query={repoQuery}
                  onQueryChange={setRepoQuery}
                  selected={selectedRepo}
                  onSelect={setSelectedRepo}
                />
              </Card>
            ) : null}

            {source === 'public_url' ? (
              <Card className="repo-new-card" data-testid="repo-new-url-card">
                <h2 className="repo-new-card__title">{URL_CARD_TITLE}</h2>
                <PublicCloneUrlField
                  value={url}
                  onChange={setUrl}
                  onTest={() => void testPublicUrl()}
                  testing={testing}
                  result={urlTest}
                />
              </Card>
            ) : null}

            {submitError ? (
              <Alert variant="danger" aria-live="assertive" data-testid="repo-new-error">
                <AlertTitle>{IMPORT_FAILED_TITLE}</AlertTitle>
                <AlertDescription>
                  <p className="repo-new-error__message">{submitError}</p>
                  <p className="repo-new-error__remedy">{IMPORT_FAILED_REMEDY}</p>
                </AlertDescription>
              </Alert>
            ) : null}

            <ProposedStepsCard id={PROPOSAL_ID} />

            <div className="repo-new-actions">
              <Button variant="ghost" asChild data-testid="repo-new-cancel">
                <Link href={REPOSITORIES_HREF}>
                  <ArrowLeft aria-hidden />
                  {CANCEL_LABEL}
                </Link>
              </Button>
              <div className="repo-new-actions__end">
                <Button
                  type="button"
                  variant="outline"
                  disabled
                  title={BACK_DISABLED_TIP}
                  data-testid="repo-new-back"
                >
                  {BACK_LABEL}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void submit()}
                  disabled={!canContinue || submitting}
                  aria-busy={submitting}
                  title={blocker ?? undefined}
                  data-testid="repo-new-continue"
                >
                  {submitting ? (
                    <>
                      <Spinner size="sm" tone="light" aria-hidden />
                      {SUBMITTING_LABEL}
                    </>
                  ) : (
                    <>
                      {CONTINUE_LABEL}
                      <ArrowRight aria-hidden />
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Why Continue is unavailable, for a reader who cannot see a `title` tooltip and
                is not going to press a disabled button to find out. */}
            <p className="sr-only" role="status" data-testid="repo-new-blocker">
              {blocker ?? ''}
            </p>
          </>
        )}
      </PageBody>
    </Page>
  );
}
