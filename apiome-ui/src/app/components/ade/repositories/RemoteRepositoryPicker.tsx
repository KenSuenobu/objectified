'use client';

/**
 * The "Choose a repository" card (HIVE-7.4, #5321).
 *
 * Authority: `docs/mockups/sources/repository-new.html` card 3 (`.repo-row`) — the
 * `group / repository` hint, the search field named after the account, the 22rem scroll list,
 * the lock on a private repository, the description beside the name, and the four states the
 * mockup's footnote lists (non-GitHub · loading · empty · search miss).
 *
 * ### Why the rows are radios
 *
 * The rows are a one-of-many choice, and the screen this replaces drew them as a list of
 * `<button>`s — so a keyboard reader tabbed through every repository in the account one at a
 * time, with nothing announcing which was chosen. `ui/RadioGroup` gives arrow-key movement,
 * "3 of 47" and a checked state for free. The native input is `sr-only` because the row already
 * carries its selection in the accent ground and the trailing tick; `.repo-new-repo:has(input:
 * focus-visible)` in `globals.css` is what puts the focus ring back on the row.
 *
 * ### Both facts about the search
 *
 * A search that matches nothing and an account that returned nothing are different situations
 * with different remedies, so they are different sentences — the mockup lists both, and the
 * screen this replaces already had them. What it did not have is the count: the list is capped
 * at 22rem of scroll, so how many rows are *below the fold* is information the reader cannot
 * otherwise get.
 */

import * as React from 'react';
import { Check, FolderGit2, Lock, Search } from 'lucide-react';

import { EmptyState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { Input } from '@/app/components/ui/Input';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { RadioGroup, RadioGroupItem } from '@/app/components/ui/RadioGroup';
import { cn } from '@lib/utils';

import {
  REPOS_EMPTY,
  REPOS_LOADING,
  REPO_CARD_HINT,
  filterRemoteRepos,
  formatGroupAndRepoName,
  nonBrowsableProviderNote,
  reposSearchMiss,
  repoSearchPlaceholder,
  type LinkedAccount,
  type RemoteRepo,
} from './addRepositoryModel';

/** The field id the card's search input is labelled by. */
const SEARCH_ID = 'repo-remote-search';

export interface RemoteRepositoryPickerProps {
  /** The account whose remotes these are — names the search field. */
  account: LinkedAccount;
  /** Whether this account's remotes can be listed at all (GitHub only). */
  browsable: boolean;
  /** The account's repositories, sorted. */
  repos: readonly RemoteRepo[];
  /** The read is in flight. */
  loading: boolean;
  /** The read failed, with this sentence. */
  error: string | null;
  /** Re-run the read. */
  onRetry: () => void;
  /** What the reader typed into the search field. */
  query: string;
  /** Called as they type. */
  onQueryChange: (next: string) => void;
  /** The chosen repository, or null. */
  selected: RemoteRepo | null;
  /** Called with the newly chosen repository. */
  onSelect: (repo: RemoteRepo) => void;
  /** The account's display label, for the search placeholder. */
  accountLabel: string;
}

/**
 * Render the picker. See {@link RemoteRepositoryPickerProps}.
 *
 * @returns The provider note, or the search field over the scrolling list of rows.
 */
export function RemoteRepositoryPicker({
  account,
  browsable,
  repos,
  loading,
  error,
  onRetry,
  query,
  onQueryChange,
  selected,
  onSelect,
  accountLabel,
}: RemoteRepositoryPickerProps) {
  const visible = React.useMemo(() => filterRemoteRepos(repos, query), [repos, query]);

  if (!browsable) {
    return (
      <p className="repo-new-note" data-testid="repo-provider-note">
        {nonBrowsableProviderNote(account.provider)}
      </p>
    );
  }

  if (loading && repos.length === 0) return <LoadingState message={REPOS_LOADING} />;

  if (error) {
    return (
      <ErrorState
        variant="compact"
        surface={false}
        title="Could not load repositories"
        description={error}
        onRetry={onRetry}
        data-testid="repo-remote-error"
      />
    );
  }

  if (repos.length === 0) {
    return (
      <EmptyState
        variant="compact"
        tone="neutral"
        titleAs="h3"
        surface={false}
        dashed
        icon={<FolderGit2 />}
        title={REPOS_EMPTY}
        description="Check that the account has access to the repository you are looking for."
        data-testid="repo-remote-empty"
      />
    );
  }

  return (
    <>
      <p className="repo-new-note">{REPO_CARD_HINT}</p>

      <div className="input-wrap repo-new-search">
        <Search aria-hidden />
        <label className="sr-only" htmlFor={SEARCH_ID}>
          {repoSearchPlaceholder(accountLabel)}
        </label>
        <Input
          id={SEARCH_ID}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={repoSearchPlaceholder(accountLabel)}
          disabled={loading}
          aria-busy={loading}
          data-testid="repo-remote-search"
        />
      </div>

      {visible.length === 0 ? (
        <p className="repo-new-note" role="status" data-testid="repo-remote-miss">
          {reposSearchMiss(query)}
        </p>
      ) : (
        <>
          <RadioGroup
            value={selected ? String(selected.id) : ''}
            onValueChange={(next) => {
              const repo = repos.find((candidate) => String(candidate.id) === next);
              if (repo) onSelect(repo);
            }}
            aria-label="Repository"
            className="repo-new-repos"
            data-testid="repo-remote-list"
          >
            {visible.map((repo) => {
              const chosen = selected?.id === repo.id;
              const description = (repo.description ?? '').trim();
              return (
                <RadioGroupItem
                  key={repo.id}
                  value={String(repo.id)}
                  id={`repo-remote-${repo.id}`}
                  name="repo-remote"
                  data-testid={`repo-remote-${repo.id}`}
                  className={cn('repo-new-repo', chosen && 'is-selected')}
                  inputClassName="sr-only"
                  label={
                    <>
                      <FolderGit2 className="repo-new-repo__glyph" aria-hidden />
                      <span className="repo-new-repo__name mono">
                        {formatGroupAndRepoName(repo.full_name) || repo.name}
                      </span>
                      {repo.private ? (
                        <>
                          <Lock className="repo-new-repo__lock" aria-hidden />
                          <span className="sr-only">Private repository</span>
                        </>
                      ) : null}
                      {description ? (
                        <span className="repo-new-repo__desc">{description}</span>
                      ) : null}
                      {chosen ? <Check className="repo-new-repo__tick" aria-hidden /> : null}
                    </>
                  }
                />
              );
            })}
          </RadioGroup>

          <p className="repo-new-note" data-testid="repo-remote-count">
            {visible.length === repos.length
              ? `${repos.length.toLocaleString()} repositor${repos.length === 1 ? 'y' : 'ies'}`
              : `${visible.length.toLocaleString()} of ${repos.length.toLocaleString()} repositories`}
          </p>
        </>
      )}
    </>
  );
}

export default RemoteRepositoryPicker;
