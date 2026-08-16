'use client';

import { useAuthSession } from '@lib/auth/session-client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Globe, Link2, Lock, PlusCircle, Search } from 'lucide-react';
import { Button, buttonVariants } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { Spinner } from '@/app/components/ui/Spinner';
import { Label } from '@/app/components/ui/Label';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { toast } from 'sonner';
import { cn } from '@lib/utils';
import { getLinkedAccountsForUser } from '@lib/db/helper';
import {
  dashboardContentStackClass,
  dashboardMainClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  LinkedAccountIcon,
  ManageLinkedAccountsLink,
  SourceOptionCard,
} from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';

type SourceKind = 'linked' | 'public_url';

interface LinkedAccount {
  id: string;
  provider: string;
  provider_email: string;
  provider_username: string | null;
}

interface RemoteRepo {
  id: number;
  name: string;
  full_name: string;
  description?: string | null;
  private?: boolean;
  default_branch?: string;
  html_url?: string;
}

function cloneUrlFromHtml(htmlUrl: string | undefined): string | undefined {
  if (!htmlUrl?.trim()) return undefined;
  const base = htmlUrl.trim().replace(/\/$/, '');
  return base.endsWith('.git') ? base : `${base}.git`;
}

/** GitHub `owner/repo` shown as "group / repository" for users in many orgs. */
function formatGroupAndRepoName(fullName: string | undefined): string {
  const raw = (fullName || '').trim();
  if (!raw) return '';
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return raw;
  return `${raw.slice(0, slash)} / ${raw.slice(slash + 1)}`;
}

export default function AddRepositoryPage() {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;
  const userId = (session?.user as { user_id?: string })?.user_id;

  const [source, setSource] = useState<SourceKind>('linked');
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [repoSearch, setRepoSearch] = useState('');
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selectedRemoteRepo, setSelectedRemoteRepo] = useState<RemoteRepo | null>(null);
  const [publicCloneUrl, setPublicCloneUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [urlTestLoading, setUrlTestLoading] = useState(false);
  const [urlTestResult, setUrlTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoadingAccounts(true);
    void (async () => {
      try {
        const raw = await getLinkedAccountsForUser(userId);
        const list = JSON.parse(raw) as LinkedAccount[];
        if (!cancelled) {
          setLinkedAccounts(Array.isArray(list) ? list : []);
          if (Array.isArray(list) && list.length === 1) {
            setSelectedAccountId(list[0].id);
          }
        }
      } catch {
        if (!cancelled) setLinkedAccounts([]);
      } finally {
        if (!cancelled) setLoadingAccounts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    setUrlTestResult(null);
  }, [publicCloneUrl]);

  // Drop a stale failure message once the user changes what they're importing.
  useEffect(() => {
    setSubmitError(null);
  }, [source, selectedAccountId, selectedRemoteRepo, publicCloneUrl]);

  const selectedAccount = useMemo(
    () => linkedAccounts.find((a) => a.id === selectedAccountId) ?? null,
    [linkedAccounts, selectedAccountId]
  );

  useEffect(() => {
    if (source !== 'linked' || !selectedAccount) {
      setRemoteRepos([]);
      setSelectedRemoteRepo(null);
      setReposError(null);
      setLoadingRepos(false);
      return;
    }

    const provider = selectedAccount.provider?.toLowerCase() ?? '';
    if (provider !== 'github') {
      setRemoteRepos([]);
      setSelectedRemoteRepo(null);
      setReposError(null);
      setLoadingRepos(false);
      return;
    }

    let cancelled = false;
    setLoadingRepos(true);
    setReposError(null);
    setSelectedRemoteRepo(null);
    setRepoSearch('');

    void (async () => {
      try {
        const res = await fetch(
          `/api/sso/github/repos?accountId=${encodeURIComponent(selectedAccount.id)}`,
          { credentials: 'include' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          repositories?: RemoteRepo[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setRemoteRepos([]);
          setReposError(typeof data.error === 'string' ? data.error : res.statusText);
          return;
        }
        const list = Array.isArray(data.repositories) ? data.repositories : [];
        setRemoteRepos(
          [...list].sort((a, b) =>
            (a.full_name || '').toLowerCase().localeCompare((b.full_name || '').toLowerCase())
          )
        );
      } catch {
        if (!cancelled) {
          setRemoteRepos([]);
          setReposError('Could not load repositories. Check your connection and try again.');
        }
      } finally {
        if (!cancelled) setLoadingRepos(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, selectedAccount]);

  const accountLabel = (a: LinkedAccount) => {
    const u = a.provider_username?.trim();
    if (u) return u;
    return a.provider_email;
  };

  const filteredRemoteRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return remoteRepos;
    return remoteRepos.filter((r) => {
      const name = (r.name || '').toLowerCase();
      const full = (r.full_name || '').toLowerCase();
      const desc = (r.description || '').toLowerCase();
      return name.includes(q) || full.includes(q) || desc.includes(q);
    });
  }, [remoteRepos, repoSearch]);

  const canContinue =
    source === 'public_url'
      ? /^https:\/\/.+\..+/.test(publicCloneUrl.trim()) && urlTestResult?.ok === true
      : Boolean(selectedAccountId && selectedRemoteRepo);

  const handleTestPublicUrl = async () => {
    const u = publicCloneUrl.trim();
    if (!/^https:\/\//i.test(u)) {
      toast.error('Enter an HTTPS clone URL to test.');
      return;
    }
    setUrlTestLoading(true);
    setUrlTestResult(null);
    try {
      const res = await fetch('/api/repositories/test-public-url', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (res.status === 401) {
        toast.error('Sign in to test this URL.');
        return;
      }
      const ok = Boolean(data.ok);
      const message = typeof data.message === 'string' ? data.message : 'Unexpected response from server.';
      setUrlTestResult({ ok, message });
      if (ok) {
        toast.success('URL looks reachable.');
      } else {
        toast.error(message);
      }
    } catch {
      const message = 'Could not reach the test service. Check your connection and try again.';
      setUrlTestResult({ ok: false, message });
      toast.error(message);
    } finally {
      setUrlTestLoading(false);
    }
  };

  const handleContinue = async () => {
    if (!currentTenantId) {
      toast.error('Select a tenant first.');
      return;
    }
    if (!canContinue) {
      if (source === 'public_url') {
        if (!/^https:\/\/.+\..+/.test(publicCloneUrl.trim())) {
          toast.error('Enter an HTTPS clone URL.');
        } else {
          toast.error('Use Test and confirm the URL succeeds before continuing.');
        }
      } else if (!selectedAccountId) {
        toast.error('Pick a linked account.');
      } else {
        toast.error('Pick a repository from the list.');
      }
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body =
        source === 'public_url'
          ? { source: 'public_url', clone_url: publicCloneUrl.trim() }
          : {
              source: 'linked_account',
              linked_account_id: selectedAccountId,
              repository_full_name: selectedRemoteRepo?.full_name,
              clone_url: cloneUrlFromHtml(selectedRemoteRepo?.html_url),
            };
      const res = await fetch('/api/repositories', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 501) {
        const message = typeof data.error === 'string' ? data.error : 'Repository API is not enabled yet.';
        toast.message(message);
        setSubmitError(message);
        return;
      }
      if (!res.ok) {
        const detail = data as { error?: unknown; detail?: unknown };
        let message = res.statusText;
        if (typeof detail.error === 'string') message = detail.error;
        else if (typeof detail.detail === 'string') message = detail.detail;
        else if (Array.isArray(detail.detail) && detail.detail[0] && typeof detail.detail[0] === 'object') {
          const row = detail.detail[0] as { msg?: unknown };
          if (typeof row.msg === 'string') message = row.msg;
        }
        throw new Error(message);
      }
      toast.success('Repository registered.');
      const created = data as { repository?: { id?: unknown } };
      const newId = created.repository?.id != null ? String(created.repository.id) : '';
      if (newId) {
        router.push(`/ade/dashboard/repositories/${newId}/preview`);
      }
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : 'Request failed.';
      toast.error(message);
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!currentTenantId) {
    return (
      <div className={cn(dashboardMainClass, 'max-w-3xl')}>
        <div className="rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50 to-yellow-50 p-8 dark:border-amber-700/50 dark:from-amber-900/20 dark:to-yellow-900/20">
          <h2 className="mb-2 text-xl font-bold text-amber-900 dark:text-amber-100">No tenant selected</h2>
          <p className="mb-4 text-amber-800 dark:text-amber-200">Select a tenant before adding a repository.</p>
          <Link href="/ade/dashboard/tenants" className={cn(buttonVariants())}>
            Go to Tenants
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(dashboardMainClass, dashboardContentStackClass, 'max-w-4xl')}>
      <div className="border-b border-gray-200 bg-white px-6 pb-5 pt-6 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-start gap-4">
          <span className="inline-flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 text-white shadow-lg shadow-purple-500/20">
            <PlusCircle className="h-6 w-6" aria-hidden />
          </span>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Add a repository</h2>
            <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-400">
              Register a repository so Apiome can scan it for importable specifications. Choose a linked account or
              paste a public Git URL.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-5 px-6 pb-10">
        <ol className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <li className="flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-2xs font-semibold text-white">
              1
            </span>
            Source
          </li>
          <li className="hidden w-8 border-t border-gray-300 sm:block dark:border-gray-600" aria-hidden />
          <li className="flex items-center gap-2 text-gray-400">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-2xs font-semibold dark:bg-gray-700">
              2
            </span>
            Repository
          </li>
          <li className="hidden w-8 border-t border-gray-300 sm:block dark:border-gray-600" aria-hidden />
          <li className="flex items-center gap-2 text-gray-400">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-2xs font-semibold dark:bg-gray-700">
              3
            </span>
            Scan settings
          </li>
          <li className="hidden w-8 border-t border-gray-300 sm:block dark:border-gray-600" aria-hidden />
          <li className="flex items-center gap-2 text-gray-400">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-2xs font-semibold dark:bg-gray-700">
              4
            </span>
            Confirm
          </li>
        </ol>

        <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 text-sm font-semibold">Where does the repository live?</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <SourceOptionCard
              radioName="repo-source"
              selected={source === 'linked'}
              onSelect={() => setSource('linked')}
              icon={<Link2 className="h-4 w-4 text-indigo-500" aria-hidden />}
              title="Linked account"
              description="Pick from repos accessible via your connected GitHub, GitLab, or Bitbucket account."
            />
            <SourceOptionCard
              radioName="repo-source"
              selected={source === 'public_url'}
              onSelect={() => setSource('public_url')}
              icon={<Globe className="h-4 w-4 text-emerald-500" aria-hidden />}
              title="Public Git URL"
              description="Paste the HTTPS clone URL of any public repository — no authentication required."
            />
          </div>
        </div>

        {source === 'linked' && (
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Linked accounts</h3>
              <ManageLinkedAccountsLink />
            </div>
            {loadingAccounts ? (
              <LoadingState message="Loading linked accounts…" />
            ) : linkedAccounts.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No linked accounts yet.{' '}
                <Link href="/ade/dashboard/linked-accounts" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  Connect GitHub or GitLab
                </Link>{' '}
                to browse private repositories.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {linkedAccounts.map((a) => {
                  const active = selectedAccountId === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSelectedAccountId(a.id)}
                      className={cn(
                        'rounded-lg border-2 p-3 text-left transition-colors',
                        active
                          ? 'border-indigo-500 bg-indigo-50/40 dark:border-indigo-500 dark:bg-indigo-900/10'
                          : 'border-gray-200 hover:border-indigo-300 dark:border-gray-700 dark:hover:border-indigo-600'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <LinkedAccountIcon provider={a.provider} />
                        <span className="text-sm font-medium capitalize">{a.provider}</span>
                      </div>
                      <p className="mt-1 font-mono text-2xs text-gray-500 dark:text-gray-400">{accountLabel(a)}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {source === 'linked' && selectedAccount && (
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-3 text-sm font-semibold">Choose a repository</h3>
            {selectedAccount.provider?.toLowerCase() !== 'github' ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Browsing repositories from the dashboard is available for <strong className="font-medium">GitHub</strong>{' '}
                linked accounts. For {selectedAccount.provider ? `${selectedAccount.provider}` : 'this provider'}, use{' '}
                <strong className="font-medium">Public Git URL</strong> above, or link a GitHub account.
              </p>
            ) : (
              <>
                <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                  Each row lists <span className="font-medium text-gray-600 dark:text-gray-300">group / repository</span>{' '}
                  (organization or user, then repo name). When GitHub provides a description, it appears on the second
                  line.
                </p>
                <div className="relative mb-3">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                    aria-hidden
                  />
                  <Input
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    placeholder={`Search repositories for ${accountLabel(selectedAccount)}…`}
                    disabled={loadingRepos}
                    className="bg-gray-50 pl-9 dark:bg-gray-900/50"
                    aria-busy={loadingRepos}
                  />
                </div>
                {loadingRepos && remoteRepos.length === 0 ? (
                  <LoadingState message="Loading repositories…" />
                ) : null}
                {reposError ? (
                  <p className="text-sm text-rose-600 dark:text-rose-400" role="alert">
                    {reposError}
                  </p>
                ) : null}
                {!loadingRepos && !reposError && remoteRepos.length === 0 ? (
                  <p className="rounded-md border border-dashed border-gray-200 py-8 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400">
                    No repositories returned for this account.
                  </p>
                ) : null}
                {!loadingRepos && !reposError && remoteRepos.length > 0 ? (
                  <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-600">
                    {filteredRemoteRepos.length === 0 ? (
                      <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                        No repositories match &quot;{repoSearch.trim()}&quot;.
                      </p>
                    ) : (
                      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                        {filteredRemoteRepos.map((repo) => {
                          const active = selectedRemoteRepo?.id === repo.id;
                          const primary = formatGroupAndRepoName(repo.full_name);
                          const desc =
                            typeof repo.description === 'string' ? repo.description.trim() : '';
                          return (
                            <li key={repo.id}>
                              <button
                                type="button"
                                onClick={() => setSelectedRemoteRepo(repo)}
                                className={cn(
                                  'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors',
                                  active
                                    ? 'bg-indigo-50 text-indigo-950 dark:bg-indigo-900/25 dark:text-indigo-50'
                                    : 'hover:bg-gray-50 dark:hover:bg-gray-700/40'
                                )}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <span
                                    className={cn(
                                      'min-w-0 flex-1 truncate text-sm font-medium font-mono tracking-tight',
                                      active ? 'text-indigo-950 dark:text-indigo-50' : 'text-gray-900 dark:text-gray-100'
                                    )}
                                  >
                                    {primary || repo.name}
                                  </span>
                                  {repo.private ? (
                                    <Lock
                                      className={cn(
                                        'h-3.5 w-3.5 shrink-0',
                                        active ? 'text-indigo-400 dark:text-indigo-300' : 'text-gray-400'
                                      )}
                                      aria-label="Private repository"
                                    />
                                  ) : null}
                                </div>
                                {desc ? (
                                  <span
                                    className={cn(
                                      'truncate text-xs',
                                      active
                                        ? 'text-indigo-800/90 dark:text-indigo-200/90'
                                        : 'text-gray-500 dark:text-gray-400'
                                    )}
                                  >
                                    {desc}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}

        {source === 'public_url' && (
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-3 text-sm font-semibold">Public clone URL</h3>
            <Label htmlFor="clone-url" className="text-xs text-gray-500 dark:text-gray-400">
              HTTPS URL
            </Label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                id="clone-url"
                value={publicCloneUrl}
                onChange={(e) => setPublicCloneUrl(e.target.value)}
                placeholder="https://github.com/org/public-repo.git"
                className="min-w-0 flex-1 font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="default"
                className="shrink-0"
                disabled={urlTestLoading || !publicCloneUrl.trim()}
                onClick={() => void handleTestPublicUrl()}
              >
                {urlTestLoading ? 'Testing…' : 'Test'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Must be reachable without credentials. Private repositories require a linked account instead.
            </p>
            {urlTestResult ? (
              <p
                className={cn(
                  'mt-2 text-sm',
                  urlTestResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                )}
              >
                {urlTestResult.message}
              </p>
            ) : null}
          </div>
        )}

        {submitError ? (
          <div
            className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-700/50 dark:bg-rose-900/20"
            role="alert"
            aria-live="assertive"
          >
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-rose-500 dark:text-rose-400" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-rose-900 dark:text-rose-100">Import failed</p>
              <p className="mt-0.5 break-words text-sm text-rose-800 dark:text-rose-200">{submitError}</p>
              <p className="mt-1 text-xs text-rose-700/80 dark:text-rose-300/80">
                Fix the problem above and try again, or choose a different source.
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/ade/dashboard/repositories"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Cancel
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/ade/dashboard/repositories" className={cn(buttonVariants({ variant: 'outline', size: 'default' }))}>
              Back
            </Link>
            <Button
              type="button"
              size="sm"
              className="gap-1.5 bg-indigo-600 hover:bg-indigo-700"
              disabled={!canContinue || submitting}
              aria-busy={submitting}
              onClick={() => void handleContinue()}
            >
              {submitting ? (
                <>
                  <Spinner size="sm" tone="light" className="shrink-0" aria-hidden />
                  Adding…
                </>
              ) : (
                <>
                  Continue
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
