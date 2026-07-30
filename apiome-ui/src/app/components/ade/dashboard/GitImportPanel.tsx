'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FolderOpen,
  File,
  ArrowLeft,
  Lock,
  Search,
  Loader2,
  Globe,
  AlertTriangle,
  CheckCircle2,
  FileCode,
  Bookmark,
  BookmarkPlus,
  Trash2,
  History,
} from 'lucide-react';
import { SiGithub, SiGitlab, SiGoogle, SiAmazon } from 'react-icons/si';
import { getLinkedAccountsForUser } from '../../../../../lib/db/helper';
import { extractFileMetadata, FileMetadataPreview } from '../../../utils/openapi-analyzer';
import { parseGitHubRepoUrl } from '../../../utils/git-repo-url';
import { TAB_LIST_SCROLL_CLASS, tabTriggerClass } from '../../ui/tabStyles';
import { cn } from '@lib/utils';
import {
  addGitImportSavedRepo,
  GitImportSavedRepo,
  loadGitImportSavedRepos,
  normalizeGitImportSpecPath,
  removeGitImportSavedRepo,
} from '../../../utils/git-import-saved-repos';
import {
  loadGitImportRecentSpecs,
  recordGitImportRecentSpec,
  recentSpecsForAccountAndOptionalRepo,
  type GitImportRecentSpec,
} from '../../../utils/git-import-recent-specs';
import { Button } from '../../../components/ui/Button';

interface GitImportPanelProps {
  userId: string;
  onSpecificationFetched: (content: string, filename: string, metadata?: FileMetadataPreview) => void;
}

interface LinkedAccount {
  id: string;
  provider: string;
  provider_username?: string;
  provider_email?: string;
}

interface GitHubRepoSummary {
  id: number;
  name: string;
  full_name: string;
  description?: string | null;
  private?: boolean;
  default_branch?: string;
  html_url?: string;
}

interface RepoFileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRecentOpenedAt(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export const GitImportPanel: React.FC<GitImportPanelProps> = ({
  userId,
  onSpecificationFetched
}) => {
  // Linked accounts state
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);

  // SSO Repository Browser state
  const [selectedAccount, setSelectedAccount] = useState<LinkedAccount | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepoSummary[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoSummary | null>(null);
  const [repoFiles, setRepoFiles] = useState<RepoFileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [repoSearchQuery, setRepoSearchQuery] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  /** GitHub: load repo by URL, branch/tag ref, optional typed spec path */
  const [repoUrlInput, setRepoUrlInput] = useState('');
  const [specPathInput, setSpecPathInput] = useState('');
  const [branchNames, setBranchNames] = useState<string[]>([]);
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedTag, setSelectedTag] = useState('');

  // Content state for preview
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  const [fetchedFilename, setFetchedFilename] = useState<string | null>(null);
  const [fileMetadata, setFileMetadata] = useState<FileMetadataPreview | null>(null);
  const [savedRepos, setSavedRepos] = useState<GitImportSavedRepo[]>([]);
  const [recentSpecs, setRecentSpecs] = useState<GitImportRecentSpec[]>([]);
  /** Middle column: full repo list vs recent spec opens for this account (optionally scoped to the selected repo). */
  const [repositoryListTab, setRepositoryListTab] = useState<'all' | 'history'>('all');

  const loadLinkedAccounts = useCallback(async () => {
    setIsLoadingAccounts(true);
    try {
      const result = await getLinkedAccountsForUser(userId);
      setLinkedAccounts(JSON.parse(result) as LinkedAccount[]);
    } catch (error) {
      console.error('Failed to load linked accounts:', error);
      setLinkedAccounts([]);
    } finally {
      setIsLoadingAccounts(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadLinkedAccounts();
  }, [loadLinkedAccounts]);

  useEffect(() => {
    if (typeof window === 'undefined' || !userId) return;
    setSavedRepos(loadGitImportSavedRepos(userId));
    setRecentSpecs(loadGitImportRecentSpecs(userId));
  }, [userId]);

  const getProviderIcon = (provider: string) => {
    switch (provider.toLowerCase()) {
      case 'github':
        return <SiGithub size={16} />;
      case 'gitlab':
        return <SiGitlab size={16} />;
      case 'google':
        return <SiGoogle size={16} />;
      case 'aws':
        return <SiAmazon size={16} />;
      default:
        return <Globe size={16} />;
    }
  };

  const fetchBranchesAndTags = async (account: LinkedAccount, fullName: string) => {
    if (account.provider?.toLowerCase() !== 'github') {
      setBranchNames([]);
      setTagNames([]);
      return;
    }
    try {
      const [brRes, trRes] = await Promise.all([
        fetch(`/api/sso/github/branches?accountId=${account.id}&repo=${encodeURIComponent(fullName)}`),
        fetch(`/api/sso/github/tags?accountId=${account.id}&repo=${encodeURIComponent(fullName)}`),
      ]);
      if (brRes.ok) {
        const bd = await brRes.json();
        setBranchNames(bd.branches || []);
      } else {
        setBranchNames([]);
      }
      if (trRes.ok) {
        const td = await trRes.json();
        setTagNames(td.tags || []);
      } else {
        setTagNames([]);
      }
    } catch {
      setBranchNames([]);
      setTagNames([]);
    }
  };

  const fetchDirectoryListing = async (
    account: LinkedAccount,
    repo: GitHubRepoSummary,
    path: string,
    ref: string
  ) => {
    let url = `/api/sso/${account.provider.toLowerCase()}/files?accountId=${encodeURIComponent(account.id)}&repo=${encodeURIComponent(repo.full_name)}&path=${encodeURIComponent(path)}`;
    if (account.provider?.toLowerCase() === 'github' && ref) {
      url += `&ref=${encodeURIComponent(ref)}`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || response.statusText);
    }
    const data = await response.json();
    return (data.files || []) as RepoFileEntry[];
  };

  const loadRepoRootAtRef = async (
    account: LinkedAccount,
    repo: GitHubRepoSummary,
    ref: string,
    manageLoading = true
  ) => {
    if (manageLoading) {
      setIsLoading(true);
      setErrorMessage('');
      setCurrentPath('');
    }
    try {
      const files = await fetchDirectoryListing(account, repo, '', ref);
      setRepoFiles(files);
    } catch (error: unknown) {
      setErrorMessage(`Failed to load files: ${formatError(error)}`);
    } finally {
      if (manageLoading) {
        setIsLoading(false);
      }
    }
  };

  const handleSelectAccount = async (account: LinkedAccount) => {
    setRepositoryListTab('all');
    setSelectedAccount(account);
    setSelectedRepo(null);
    setRepoFiles([]);
    setCurrentPath('');
    setRepoSearchQuery('');
    setRepoUrlInput('');
    setSpecPathInput('');
    setBranchNames([]);
    setTagNames([]);
    setSelectedBranch('');
    setSelectedTag('');
    setIsLoading(true);
    setErrorMessage('');
    setFetchedContent(null);
    setFetchedFilename(null);
    setFileMetadata(null);

    try {
      // Fetch repositories for the selected account
      const response = await fetch(`/api/sso/${account.provider.toLowerCase()}/repos?accountId=${encodeURIComponent(account.id)}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch repositories: ${response.statusText}`);
      }

      const data = await response.json();
      const sortedRepos = ((data.repositories || []) as GitHubRepoSummary[]).sort((a, b) => {
        const nameA = (a.name || '').toLowerCase();
        const nameB = (b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      setRepositories(sortedRepos);
    } catch (error: unknown) {
      setErrorMessage(`Failed to load repositories: ${formatError(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectRepo = async (repo: GitHubRepoSummary) => {
    if (!selectedAccount) return;
    const defaultBr = repo.default_branch || 'main';
    setSelectedRepo(repo);
    setRepoFiles([]);
    setIsLoading(true);
    setErrorMessage('');
    setCurrentPath('');
    setSpecPathInput('');
    setSelectedBranch(defaultBr);
    setSelectedTag('');
    setFetchedContent(null);
    setFetchedFilename(null);
    setFileMetadata(null);

    try {
      await fetchBranchesAndTags(selectedAccount, repo.full_name);
      await loadRepoRootAtRef(selectedAccount, repo, defaultBr, false);
    } catch (error: unknown) {
      setErrorMessage(`Failed to load files: ${formatError(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadRepoFromUrl = async () => {
    if (!selectedAccount || selectedAccount.provider?.toLowerCase() !== 'github') {
      setErrorMessage('Select a GitHub-linked account first.');
      return;
    }
    const parsed = parseGitHubRepoUrl(repoUrlInput);
    if (!parsed) {
      setErrorMessage('Enter a valid GitHub repository URL (e.g. https://github.com/org/repo or org/repo).');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    setFetchedContent(null);
    setFetchedFilename(null);
    setFileMetadata(null);

    try {
      const metaRes = await fetch(
        `/api/sso/github/repo?accountId=${selectedAccount.id}&repo=${encodeURIComponent(parsed.fullName)}`
      );
      if (!metaRes.ok) {
        const errBody = await metaRes.json().catch(() => ({}));
        throw new Error(errBody.error || metaRes.statusText);
      }
      const meta = await metaRes.json();
      const repo = meta.repository as GitHubRepoSummary;
      const defaultBr = repo.default_branch || 'main';
      setSelectedRepo(repo);
      setCurrentPath('');
      setSpecPathInput('');
      setSelectedBranch(defaultBr);
      setSelectedTag('');
      await fetchBranchesAndTags(selectedAccount, repo.full_name);
      await loadRepoRootAtRef(selectedAccount, repo, defaultBr, false);
    } catch (error: unknown) {
      setErrorMessage(formatError(error) || 'Failed to load repository from URL');
    } finally {
      setIsLoading(false);
    }
  };

  const applyRefAndReloadRoot = async (branch: string, tag: string) => {
    if (!selectedAccount || !selectedRepo) return;
    const ref = tag || branch || selectedRepo.default_branch || 'main';
    await loadRepoRootAtRef(selectedAccount, selectedRepo, ref, true);
  };

  const handleBranchSelectChange = (value: string) => {
    setSelectedBranch(value);
    setSelectedTag('');
    void applyRefAndReloadRoot(value, '');
  };

  const handleTagSelectChange = (value: string) => {
    if (!value) {
      const fallback = selectedRepo?.default_branch || 'main';
      setSelectedTag('');
      setSelectedBranch(fallback);
      void applyRefAndReloadRoot(fallback, '');
      return;
    }
    setSelectedTag(value);
    setSelectedBranch('');
    void applyRefAndReloadRoot('', value);
  };

  const handleNavigateToPath = async (path: string) => {
    if (!selectedAccount || !selectedRepo) return;
    const ref =
      selectedTag || selectedBranch || selectedRepo.default_branch || 'main';
    setRepoFiles([]);
    setIsLoading(true);
    setErrorMessage('');
    setCurrentPath(path);

    try {
      const files = await fetchDirectoryListing(selectedAccount, selectedRepo, path, ref);
      setRepoFiles(files);
    } catch (error: unknown) {
      setErrorMessage(`Failed to load files: ${formatError(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const loadRemoteSpecAndPublish = useCallback(
    async (
      account: LinkedAccount,
      repo: GitHubRepoSummary,
      refKind: GitImportRecentSpec['refKind'],
      refName: string,
      normalizedSpecPath: string
    ) => {
      const ref = refName;
      const response = await fetch(
        `/api/sso/${account.provider.toLowerCase()}/content?accountId=${encodeURIComponent(account.id)}&repo=${encodeURIComponent(repo.full_name)}&path=${encodeURIComponent(normalizedSpecPath)}&branch=${encodeURIComponent(ref)}`
      );

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(
          typeof errBody.error === 'string' ? errBody.error : response.statusText
        );
      }

      const data = await response.json();
      const content = data.content as string;
      const filename = normalizedSpecPath.split('/').pop() || normalizedSpecPath;
      const metadata = extractFileMetadata(content);
      setFetchedContent(content);
      setFetchedFilename(filename);
      setFileMetadata(metadata);
      onSpecificationFetched(content, filename, metadata);
      const { items } = recordGitImportRecentSpec(userId, {
        accountId: account.id,
        provider: account.provider,
        repoFullName: repo.full_name,
        refKind,
        refName,
        specPath: normalizedSpecPath,
      });
      setRecentSpecs(items);
    },
    [userId, onSpecificationFetched]
  );

  const handleSelectFile = async (file: RepoFileEntry) => {
    if (!selectedAccount || !selectedRepo) return;

    if (file.type === 'dir') {
      handleNavigateToPath(file.path);
      return;
    }

    setSpecPathInput(`/${file.path}`);

    const isOpenAPIFile =
      file.name.includes('openapi') ||
      file.name.includes('swagger') ||
      file.name.endsWith('.json') ||
      file.name.endsWith('.yaml') ||
      file.name.endsWith('.yml');

    if (!isOpenAPIFile) {
      setErrorMessage('Please select an OpenAPI specification file (JSON or YAML)');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const refKind: GitImportRecentSpec['refKind'] = selectedTag ? 'tag' : 'branch';
      const refName =
        selectedTag || selectedBranch || selectedRepo.default_branch || 'main';
      const pathNorm = normalizeGitImportSpecPath(file.path);
      if (!pathNorm) {
        setErrorMessage('Invalid file path.');
        return;
      }
      await loadRemoteSpecAndPublish(selectedAccount, selectedRepo, refKind, refName, pathNorm);
    } catch (error: unknown) {
      setErrorMessage(`Failed to load file: ${formatError(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenSpecPath = async () => {
    if (!selectedAccount || !selectedRepo) {
      setErrorMessage('Select a repository first.');
      return;
    }
    const raw = specPathInput.trim().replace(/^\/+/, '');
    if (!raw) {
      setErrorMessage('Enter a file path (e.g. specs/openapi.yaml).');
      return;
    }

    const base = raw.split('/').pop() || raw;
    const isOpenAPIFile =
      base.includes('openapi') ||
      base.includes('swagger') ||
      base.endsWith('.json') ||
      base.endsWith('.yaml') ||
      base.endsWith('.yml');

    if (!isOpenAPIFile) {
      setErrorMessage('Path should point to an OpenAPI specification file (JSON or YAML).');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const refKind: GitImportRecentSpec['refKind'] = selectedTag ? 'tag' : 'branch';
      const refName =
        selectedTag || selectedBranch || selectedRepo.default_branch || 'main';
      const pathNorm = normalizeGitImportSpecPath(raw);
      if (!pathNorm) {
        setErrorMessage('Enter a file path (e.g. specs/openapi.yaml).');
        return;
      }
      await loadRemoteSpecAndPublish(selectedAccount, selectedRepo, refKind, refName, pathNorm);
    } catch (error: unknown) {
      setErrorMessage(`Failed to load file: ${formatError(error)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveBookmark = () => {
    if (!selectedAccount || !selectedRepo) return;
    const refKind = selectedTag ? 'tag' : 'branch';
    const refName =
      selectedTag || selectedBranch || selectedRepo.default_branch || 'main';
    const specPath = normalizeGitImportSpecPath(specPathInput);
    const { persisted, items } = addGitImportSavedRepo(userId, {
      accountId: selectedAccount.id,
      provider: selectedAccount.provider,
      repoFullName: selectedRepo.full_name,
      refKind,
      refName,
      specPath,
    });
    setSavedRepos(items);
    if (!persisted) {
      setErrorMessage('Failed to save bookmark. Storage may be full or unavailable.');
    } else {
      setErrorMessage('');
    }
  };

  const handleRemoveSaved = (id: string) => {
    const { items } = removeGitImportSavedRepo(userId, id);
    setSavedRepos(items);
  };

  const handleOpenSaved = async (bookmark: GitImportSavedRepo) => {
    const account = linkedAccounts.find((a) => a.id === bookmark.accountId);
    if (!account) {
      setErrorMessage(
        'The linked account for this saved repository is no longer available. Remove the entry or reconnect your account.'
      );
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    setFetchedContent(null);
    setFetchedFilename(null);
    setFileMetadata(null);
    setRepoUrlInput('');
    setRepoSearchQuery('');

    try {
      const reposRes = await fetch(`/api/sso/${account.provider.toLowerCase()}/repos?accountId=${encodeURIComponent(account.id)}`);
      if (!reposRes.ok) {
        throw new Error(`Failed to fetch repositories: ${reposRes.statusText}`);
      }
      const data = await reposRes.json();
      let sortedRepos = ((data.repositories || []) as GitHubRepoSummary[]).sort((a, b) => {
        const nameA = (a.name || '').toLowerCase();
        const nameB = (b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });

      let repo: GitHubRepoSummary | undefined = sortedRepos.find(
        (r) => r.full_name.toLowerCase() === bookmark.repoFullName.toLowerCase()
      );

      if (!repo && account.provider?.toLowerCase() === 'github') {
        const metaRes = await fetch(
          `/api/sso/github/repo?accountId=${account.id}&repo=${encodeURIComponent(bookmark.repoFullName)}`
        );
        if (!metaRes.ok) {
          const errBody = await metaRes.json().catch(() => ({}));
          throw new Error(
            typeof errBody.error === 'string'
              ? errBody.error
              : 'Repository not found. It may have been renamed or removed.'
          );
        }
        const meta = await metaRes.json();
        repo = meta.repository as GitHubRepoSummary;
      }

      if (!repo) {
        throw new Error('Repository not found. It may have been renamed or removed.');
      }

      if (!sortedRepos.some((r) => r.full_name.toLowerCase() === repo.full_name.toLowerCase())) {
        sortedRepos = [...sortedRepos, repo].sort((a, b) => {
          const nameA = (a.name || '').toLowerCase();
          const nameB = (b.name || '').toLowerCase();
          return nameA.localeCompare(nameB);
        });
      }

      setSelectedAccount(account);
      setRepositories(sortedRepos);
      setSelectedRepo(repo);
      setCurrentPath('');

      const specNorm = normalizeGitImportSpecPath(bookmark.specPath);
      setSpecPathInput(specNorm ? `/${specNorm}` : '');

      const defaultBr = repo.default_branch || 'main';
      await fetchBranchesAndTags(account, repo.full_name);

      const ref =
        bookmark.refKind === 'tag' ? bookmark.refName : bookmark.refName || defaultBr;

      if (bookmark.refKind === 'tag') {
        setSelectedTag(bookmark.refName);
        setSelectedBranch('');
      } else {
        setSelectedTag('');
        setSelectedBranch(bookmark.refName || defaultBr);
      }

      await loadRepoRootAtRef(account, repo, ref, false);

      if (specNorm) {
        const refKind: GitImportRecentSpec['refKind'] = bookmark.refKind;
        const refName =
          bookmark.refKind === 'tag'
            ? bookmark.refName
            : bookmark.refName || repo.default_branch || 'main';
        await loadRemoteSpecAndPublish(account, repo, refKind, refName, specNorm);
      }
    } catch (error: unknown) {
      setErrorMessage(formatError(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenRecentFromHistory = async (entry: GitImportRecentSpec) => {
    const synthetic: GitImportSavedRepo = {
      id: entry.id,
      accountId: entry.accountId,
      provider: entry.provider,
      repoFullName: entry.repoFullName,
      refKind: entry.refKind,
      refName: entry.refName,
      specPath: entry.specPath,
      savedAt: entry.openedAt,
    };
    await handleOpenSaved(synthetic);
  };

  // Filter repositories based on search query
  const filteredRepos = repositories.filter((repo: GitHubRepoSummary) =>
    repo.name.toLowerCase().includes(repoSearchQuery.toLowerCase()) ||
    (repo.description && repo.description.toLowerCase().includes(repoSearchQuery.toLowerCase()))
  );

  const historyListEntries = useMemo(() => {
    if (!selectedAccount || repositoryListTab !== 'history') return [];
    return recentSpecsForAccountAndOptionalRepo(
      recentSpecs,
      selectedAccount.id,
      selectedRepo ? selectedRepo.full_name : null
    );
  }, [recentSpecs, selectedAccount, selectedRepo, repositoryListTab]);

  if (isLoadingAccounts) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">Loading linked accounts...</span>
      </div>
    );
  }

  if (linkedAccounts.length === 0) {
    return (
      <div className="p-6 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-amber-900 dark:text-amber-200">
              No Linked Accounts Found
            </div>
            <div className="text-sm text-amber-700 dark:text-amber-300 mt-1">
              Please link a GitHub or GitLab account from the{' '}
              <a
                href="/ade/dashboard/linked-accounts"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-900 dark:hover:text-amber-100"
              >
                Linked Accounts
              </a>{' '}
              page to import from Git repositories.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Error Message */}
      {errorMessage && (
        <div className="flex-shrink-0 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="text-sm text-red-700 dark:text-red-300">{errorMessage}</div>
          </div>
        </div>
      )}

      {savedRepos.length > 0 && (
        <div className="flex-shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            <Bookmark className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden />
            Saved for re-import
          </div>
          <ul className="mt-3 space-y-2">
            {savedRepos.map((b) => (
              <li
                key={b.id}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-md border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {b.repoFullName}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {b.refKind === 'tag' ? `Tag ${b.refName}` : `Branch ${b.refName}`}
                    {b.specPath ? ` · ${b.specPath}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleOpenSaved(b)}
                    disabled={isLoading}
                    className="shrink-0"
                  >
                    Open
                  </Button>
                  <button
                    type="button"
                    onClick={() => handleRemoveSaved(b.id)}
                    disabled={isLoading}
                    className="p-2 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
                    aria-label={`Remove saved repository ${b.repoFullName}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Stored in this browser on this device. Use the same linked account to open a saved entry.
          </p>
        </div>
      )}

      {selectedAccount && selectedRepo && (
        <div className="flex-shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/80 dark:bg-indigo-950/30 px-4 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={handleSaveBookmark}
            disabled={isLoading}
            className="shrink-0 border-indigo-300 dark:border-indigo-700"
          >
            <BookmarkPlus className="h-4 w-4 mr-2" aria-hidden />
            Save for later
          </Button>
          <p className="text-xs text-indigo-900/90 dark:text-indigo-200/90 sm:flex-1 sm:min-w-0">
            Saves the linked account, repository, branch or tag, and optional spec path so you can return here to re-import or open a PR branch later.
          </p>
        </div>
      )}

      {selectedAccount?.provider?.toLowerCase() === 'github' && (
        <div className="flex-shrink-0 space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 p-4">
          <div>
            <label
              htmlFor="git-import-repo-url"
              className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
            >
              Repository URL
            </label>
            <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                id="git-import-repo-url"
                type="text"
                value={repoUrlInput}
                onChange={(e) => setRepoUrlInput(e.target.value)}
                placeholder="https://github.com/org/repo or org/repo"
                disabled={isLoading}
                className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
              />
              <Button
                type="button"
                variant="default"
                onClick={() => void handleLoadRepoFromUrl()}
                disabled={isLoading || !repoUrlInput.trim()}
                className="shrink-0"
              >
                Load repository
              </Button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Paste a GitHub URL or <span className="font-mono">owner/repo</span>, then load to browse that repository at the branch or tag you choose below.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
            <span>Need access to private repos?</span>
            <a
              href="/ade/dashboard/linked-accounts"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 dark:text-indigo-400 underline hover:text-indigo-800 dark:hover:text-indigo-300"
            >
              Linked accounts
            </a>
          </div>

          {selectedRepo && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="git-import-branch"
                    className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    Branch
                  </label>
                  <select
                    id="git-import-branch"
                    value={selectedTag ? '' : selectedBranch}
                    onChange={(e) => handleBranchSelectChange(e.target.value)}
                    disabled={isLoading || !!selectedTag}
                    className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-60"
                  >
                    {selectedTag ? (
                      <option value="">—</option>
                    ) : null}
                    {(branchNames.length > 0
                      ? branchNames
                      : selectedBranch
                        ? [selectedBranch]
                        : []
                    ).map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="git-import-tag"
                    className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    Tag
                  </label>
                  <select
                    id="git-import-tag"
                    value={selectedTag}
                    onChange={(e) => handleTagSelectChange(e.target.value)}
                    disabled={isLoading}
                    className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  >
                    <option value="">(none)</option>
                    {tagNames.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="git-import-spec-path"
                  className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  Spec path
                </label>
                <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    id="git-import-spec-path"
                    type="text"
                    value={specPathInput}
                    onChange={(e) => setSpecPathInput(e.target.value)}
                    placeholder="specs/openapi.yaml"
                    disabled={isLoading}
                    className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleOpenSpecPath()}
                    disabled={isLoading || !specPathInput.trim()}
                    className="shrink-0"
                  >
                    Open file
                  </Button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Optional: type a path and open, or pick a file in the browser — the path updates when you select a file.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Three-Column Browser - fills remaining form height */}
      <div className="flex flex-1 min-h-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800">
        {/* Column 1: Accounts */}
        <div className="w-1/3 min-w-[200px] max-w-[300px] border-r border-gray-200 dark:border-gray-700 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex-shrink-0">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Accounts
            </span>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            {linkedAccounts.map((account) => {
              const isSelected = selectedAccount?.id === account.id;

              return (
                <button
                  key={account.id}
                  onClick={() => !isLoading && handleSelectAccount(account)}
                  disabled={isLoading}
                  className={`w-full px-3 py-2 flex items-center gap-2 border-b border-gray-100 dark:border-gray-700 transition-colors ${
                    isSelected
                      ? 'bg-indigo-600 text-white'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-900 dark:text-gray-100'
                  } ${isLoading ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <span className={`flex-shrink-0 ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`}>
                    {getProviderIcon(account.provider)}
                  </span>
                  <div className="flex-1 min-w-0 text-left">
                    <div className={`text-sm font-medium truncate ${isSelected ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>
                      {account.provider.charAt(0).toUpperCase() + account.provider.slice(1)}
                    </div>
                    <div className={`text-xs truncate ${isSelected ? 'text-indigo-100' : 'text-gray-500 dark:text-gray-400'}`}>
                      {account.provider_username || account.provider_email}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Column 2: Repositories */}
        <div className="w-1/3 min-w-[200px] max-w-[300px] border-r border-gray-200 dark:border-gray-700 flex flex-col min-h-0">
          <div className="px-2 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex-shrink-0 space-y-2">
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider shrink-0">
                Repositories
              </span>
              {selectedAccount ? (
                <div
                  className={cn(TAB_LIST_SCROLL_CLASS, 'border-b-0')}
                  role="tablist"
                  aria-label="Repository list mode"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={repositoryListTab === 'all'}
                    onClick={() => setRepositoryListTab('all')}
                    disabled={isLoading}
                    className={tabTriggerClass({
                      active: repositoryListTab === 'all',
                      disabled: isLoading,
                      size: 'sm',
                    })}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={repositoryListTab === 'history'}
                    onClick={() => setRepositoryListTab('history')}
                    disabled={isLoading}
                    className={tabTriggerClass({
                      active: repositoryListTab === 'history',
                      disabled: isLoading,
                      size: 'sm',
                    })}
                  >
                    <History className="h-3 w-3" aria-hidden />
                    History
                  </button>
                </div>
              ) : null}
            </div>
            {repositoryListTab === 'history' && selectedAccount ? (
              <p className="text-[10px] leading-snug text-gray-500 dark:text-gray-400">
                {selectedRepo
                  ? 'Specs you opened from this repository on this device.'
                  : 'Specs you opened from any repository for this account on this device.'}
              </p>
            ) : null}
          </div>

          {/* Search Box */}
          {repositoryListTab === 'all' && selectedAccount && repositories.length > 0 && (
            <div className="p-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search repositories..."
                  value={repoSearchQuery}
                  onChange={(e) => setRepoSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto min-h-0">
            {!selectedAccount ? (
              <div className="flex items-center justify-center h-full p-4">
                <span className="text-sm text-gray-500 dark:text-gray-400 text-center">
                  Select an account
                </span>
              </div>
            ) : repositoryListTab === 'history' ? (
              historyListEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full p-4 text-center">
                  <History className="h-8 w-8 text-gray-300 dark:text-gray-600 mb-2" aria-hidden />
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {selectedRepo
                      ? 'No recent imports for this repository yet. Open a spec from the file column to list it here.'
                      : 'No recent imports yet. Open a spec from a repository, then return here to re-open it quickly.'}
                  </span>
                </div>
              ) : (
                historyListEntries.map((entry) => {
                  const showRepo = !selectedRepo;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => !isLoading && void handleOpenRecentFromHistory(entry)}
                      disabled={isLoading}
                      className={`w-full px-3 py-2 border-b border-gray-100 dark:border-gray-700 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-900 dark:text-gray-100 ${
                        isLoading ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
                      }`}
                    >
                      {showRepo ? (
                        <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 truncate">
                          {entry.repoFullName}
                        </div>
                      ) : null}
                      <div className="text-sm font-medium truncate">{entry.specPath}</div>
                      <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                        {entry.refKind === 'tag' ? `Tag ${entry.refName}` : `Branch ${entry.refName}`}
                        <span className="mx-1">·</span>
                        {formatRecentOpenedAt(entry.openedAt)}
                      </div>
                    </button>
                  );
                })
              )
            ) : isLoading && repositories.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
              </div>
            ) : repositories.length === 0 ? (
              <div className="flex items-center justify-center h-full p-4">
                <span className="text-sm text-gray-500 dark:text-gray-400 text-center">
                  No repositories found
                </span>
              </div>
            ) : filteredRepos.length === 0 ? (
              <div className="flex items-center justify-center h-full p-4">
                <span className="text-sm text-gray-500 dark:text-gray-400 text-center">
                  No repositories match &quot;{repoSearchQuery}&quot;
                </span>
              </div>
            ) : (
              filteredRepos.map((repo: GitHubRepoSummary) => {
                const isSelected = selectedRepo?.id === repo.id;
                return (
                  <button
                    key={repo.id}
                    onClick={() => !isLoading && handleSelectRepo(repo)}
                    disabled={isLoading}
                    className={`w-full px-3 py-2 border-b border-gray-100 dark:border-gray-700 text-left transition-colors ${
                      isSelected
                        ? 'bg-indigo-600 text-white'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 text-gray-900 dark:text-gray-100'
                    } ${isLoading ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-center gap-1">
                      <span className={`text-sm font-medium flex-1 truncate ${isSelected ? 'text-white' : ''}`}>
                        {repo.name}
                      </span>
                      {repo.private && (
                        <Lock className={`h-3 w-3 flex-shrink-0 ${isSelected ? 'text-indigo-100' : 'text-gray-400'}`} />
                      )}
                    </div>
                    {repo.description && (
                      <div className={`text-xs truncate mt-0.5 ${isSelected ? 'text-indigo-100' : 'text-gray-500 dark:text-gray-400'}`}>
                        {repo.description}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Column 3: Files */}
        <div className="flex-1 min-w-[200px] flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex-shrink-0">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Files
            </span>
          </div>

          {/* Path breadcrumb */}
          {currentPath && (
            <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30 flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => {
                  const parentPath = currentPath.split('/').slice(0, -1).join('/');
                  handleNavigateToPath(parentPath);
                }}
                disabled={isLoading}
                className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                <ArrowLeft className="h-4 w-4 text-gray-500 dark:text-gray-400" />
              </button>
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                /{currentPath}
              </span>
            </div>
          )}

          <div className="flex-1 overflow-y-auto min-h-0">
            {!selectedRepo ? (
              <div className="flex items-center justify-center h-full p-4">
                <span className="text-sm text-gray-500 dark:text-gray-400 text-center">
                  Select a repository
                </span>
              </div>
            ) : isLoading ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
                <span className="text-sm text-gray-500 dark:text-gray-400">Loading...</span>
              </div>
            ) : repoFiles.length === 0 ? (
              <div className="flex items-center justify-center h-full p-4">
                <span className="text-sm text-gray-500 dark:text-gray-400 text-center">
                  No files found
                </span>
              </div>
            ) : (
              <>
                {/* Parent directory (..) entry when in a subdirectory */}
                {currentPath && (
                  <button
                    onClick={() => {
                      const parentPath = currentPath.split('/').slice(0, -1).join('/');
                      handleNavigateToPath(parentPath);
                    }}
                    disabled={isLoading}
                    className={`w-full px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                      isLoading ? 'cursor-not-allowed' : 'cursor-pointer'
                    }`}
                  >
                    <ArrowLeft className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    <span className="text-sm text-gray-900 dark:text-gray-100 font-medium">
                      ..
                    </span>
                  </button>
                )}

                {/* File and directory list */}
                {repoFiles.map((file: RepoFileEntry, idx: number) => {
                const isOpenAPIFile =
                  file.name.includes('openapi') ||
                  file.name.includes('swagger') ||
                  file.name.endsWith('.json') ||
                  file.name.endsWith('.yaml') ||
                  file.name.endsWith('.yml');

                return (
                  <button
                    key={idx}
                    onClick={() => !isLoading && handleSelectFile(file)}
                    disabled={isLoading}
                    className={`w-full px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                      isLoading ? 'cursor-not-allowed' : 'cursor-pointer'
                    }`}
                  >
                    {file.type === 'dir' ? (
                      <FolderOpen className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    ) : (
                      <File className={`h-4 w-4 flex-shrink-0 ${isOpenAPIFile ? 'text-green-500' : 'text-gray-400'}`} />
                    )}
                    <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {file.name}
                    </span>
                  </button>
                );
              })}
              </>
            )}
          </div>
        </div>
      </div>

      {/* File Metadata Preview */}
      {fetchedContent && fileMetadata && (
        <div className="flex-shrink-0 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <FileCode className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            File Preview: {fetchedFilename}
          </h3>

          <div className="space-y-4">
            {/* Unsupported Format Warning */}
            {!fileMetadata.formatSupported && fileMetadata.format !== 'unknown' && (
              <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-amber-900 dark:text-amber-200">
                      Format Not Available for Import
                    </div>
                    <div className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                      The detected format <span className="font-semibold">{fileMetadata.formatDisplayName}</span> is not yet supported for import.
                      Currently supported formats: OpenAPI 3.x, Swagger 2.x, JSON Schema, Arazzo, RAML, AsyncAPI, GraphQL, Protobuf, Thrift, Avro, and Postman.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Parse Error */}
            {!fileMetadata.syntaxValid && (
              <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-red-900 dark:text-red-200">
                      File Parse Error
                    </div>
                    <div className="text-sm text-red-700 dark:text-red-300 mt-1">
                      {fileMetadata.parseError || 'Unable to parse file content'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Metadata Grid */}
            <div className="grid grid-cols-3 gap-4">
              {/* Format */}
              <div className={`rounded-lg p-4 border ${fileMetadata.formatSupported ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'}`}>
                <div className="flex items-center gap-2 mb-2">
                  {fileMetadata.formatSupported ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  )}
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Detected Format
                  </span>
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                  {fileMetadata.formatDisplayName}
                </div>
              </div>

              {/* Spec Version */}
              <div className="rounded-lg p-4 border bg-gray-50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Version
                  </span>
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                  {fileMetadata.specVersion || fileMetadata.version || 'N/A'}
                </div>
              </div>

              {/* Syntax */}
              <div className={`rounded-lg p-4 border ${fileMetadata.syntaxValid ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}>
                <div className="flex items-center gap-2 mb-2">
                  {fileMetadata.syntaxValid ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
                  )}
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Syntax
                  </span>
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                  {fileMetadata.syntaxValid ? `Valid ${fileMetadata.syntax.toUpperCase()}` : 'Invalid'}
                </div>
              </div>
            </div>

            {/* Title */}
            {fileMetadata.title && (
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Title
                </span>
                <div className="text-base font-semibold text-gray-900 dark:text-white mt-1">
                  {fileMetadata.title}
                </div>
              </div>
            )}

            {/* Description */}
            {fileMetadata.description && (
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Description
                </span>
                <div className="text-sm text-gray-700 dark:text-gray-300 mt-1 leading-relaxed line-clamp-3">
                  {fileMetadata.description}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default GitImportPanel;

