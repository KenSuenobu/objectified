'use client';

/**
 * The branch popover on the Files tab (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Files → branch popover — a search
 * field, a `Branches N` / `Tags` segmented pair with Tags disabled and titled, the branch list
 * with a `default` badge on one of them, and two stubbed verbs in the foot.
 *
 * ### Why the Tags half is a disabled segment and not a hidden one
 *
 * Hiding it would be the tidier screen and the worse answer: a reader looking for a tag would
 * conclude the product cannot index tags, when in fact it cannot index them *yet*. The segment
 * is drawn, disabled, and carries {@link TAGS_UNAVAILABLE} as its title — the ticket's
 * "stubbed controls remain visually honest" criterion. The count beside *Branches* is real.
 *
 * ### What changed besides the paint
 *
 * The search field was an `Input` with a hand-positioned `Search` glyph and its own `pl-8`;
 * it is `.input-wrap` (HIVE-2.1) now, which reserves the gutter from the icon's own token so
 * the text clears the glyph at every font scale. The tick beside the current branch used to be
 * an `opacity-0` icon, which reserves the space but still exposes the check to assistive tech;
 * it is `visibility: hidden` in the stylesheet, so the row reads as "main" rather than "check
 * main" on every row that is not chosen.
 */

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, GitBranch, GitCompare, RefreshCw, Search } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';

import { TAGS_UNAVAILABLE } from './repositoryDetailModel';

export interface RepositoryBranchPickerProps {
  /** The branch the file table is reading. */
  branch: string;
  /** The registration's default branch, which gets the `default` badge. */
  defaultBranch: string;
  /** Every indexed branch the last read discovered. */
  branches: readonly string[];
  /** Switch branches. */
  onSelect: (branch: string) => void;
  /** "Compare branches" — a stub until git metadata is exposed. */
  onCompareBranches: () => void;
  /** "Refresh from remote" — a stub until the scan-job endpoint exists. */
  onRefreshFromRemote: () => void;
}

/**
 * Render the picker. See {@link RepositoryBranchPickerProps}.
 *
 * @returns The trigger and its popover.
 */
export function RepositoryBranchPicker({
  branch,
  defaultBranch,
  branches,
  onSelect,
  onCompareBranches,
  onRefreshFromRemote,
}: RepositoryBranchPickerProps) {
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, search]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          className="repo-files-branch"
          data-testid="repository-branch-trigger"
        >
          <GitBranch aria-hidden />
          <span className="repo-files-branch__label">Branch</span>
          <span className="repo-files-branch__name mono">{branch}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tnt-menu repo-files-branch-menu"
          sideOffset={6}
          align="start"
          data-testid="repository-branch-menu"
        >
          <div className="repo-files-branch-menu__head">
            <div className="input-wrap">
              <Search aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Switch branch or tag…"
                aria-label="Search branches"
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <Segmented value="branches" aria-label="Reference kind" size="sm">
              <SegmentedItem value="branches">Branches {branches.length}</SegmentedItem>
              <SegmentedItem value="tags" disabled title={TAGS_UNAVAILABLE}>
                Tags
              </SegmentedItem>
            </Segmented>
          </div>

          <div className="repo-files-branch-menu__list">
            {filtered.length === 0 ? (
              <p className="repo-det-note px-2 py-2">No branches match.</p>
            ) : (
              filtered.map((b) => (
                <DropdownMenu.Item
                  key={b}
                  className="tnt-menu__item repo-files-branch-menu__item"
                  onSelect={() => onSelect(b)}
                >
                  <Check
                    className="repo-files-branch-menu__tick"
                    data-checked={b === branch ? 'true' : 'false'}
                    aria-hidden
                  />
                  <span className="repo-files-branch-menu__name mono">{b}</span>
                  {b === defaultBranch ? (
                    <Badge variant="outline">
                      default
                    </Badge>
                  ) : null}
                </DropdownMenu.Item>
              ))
            )}
          </div>

          <div className="repo-files-branch-menu__foot">
            <Button type="button" variant="ghost" size="sm" onClick={onCompareBranches}>
              <GitCompare aria-hidden />
              Compare branches
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onRefreshFromRemote}>
              <RefreshCw aria-hidden />
              Refresh from remote
            </Button>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default RepositoryBranchPicker;
