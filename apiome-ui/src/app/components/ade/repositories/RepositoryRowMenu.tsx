'use client';

/**
 * The verbs a repository offers, as one menu (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html` §Row menu — *Open detail · Rescan ·
 * Remove from list*, the last one destructive and behind a confirm.
 *
 * ### One menu, both views
 *
 * The card and the table row draw the same three verbs. The screen this replaces had two
 * different menus — the card's had only *Remove from list*, the table's had the same one plus
 * an inline `Detail →` link — so which actions a repository offered depended on which view was
 * selected. There is one component now, and it is the only place a repository's verbs are
 * spelled.
 *
 * ### The confirm is the app's confirm
 *
 * The menu used to own a private `AlertDialog` and its own `busy` state, which is why its copy
 * had drifted from DESIGN.md §8 (no object named in the title, no consequence sentence). It
 * now asks `useDialog().confirm` with {@link removeRepositoryConfirm}, the same route every
 * other destructive verb in the app takes, and the caller owns the write — so a page that
 * needs to reload after a removal does not have to discover that one happened.
 */

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { cn } from '@lib/utils';

import { removeRepositoryConfirm, type DashboardRepository } from './repositoriesModel';

/** The row-menu item class, shared with the tenants menu and the catalog card. */
const MENU_ITEM_CLASS = 'tnt-menu__item';

/** The verbs a repository row offers. Both views are handed the same object. */
export interface RepositoryRowHandlers {
  /** Open the repository's detail view. */
  onOpenDetail: (repository: DashboardRepository) => void;
  /** Queue a rescan. Stubbed until scan jobs are wired to the API. */
  onRescan: (repository: DashboardRepository) => void;
  /** Remove the repository from this workspace, after the confirm below. */
  onRemove: (repository: DashboardRepository) => void;
}

export interface RepositoryRowMenuProps extends RepositoryRowHandlers {
  /** The repository the menu belongs to. */
  repository: DashboardRepository;
  /** True while a write is in flight — every verb goes inert. */
  busy?: boolean;
  /** Extra classes for the trigger. */
  className?: string;
}

/**
 * Render the menu. See {@link RepositoryRowMenuProps}.
 *
 * @returns The overflow trigger and its three items.
 */
export function RepositoryRowMenu({
  repository,
  onOpenDetail,
  onRescan,
  onRemove,
  busy = false,
  className,
}: RepositoryRowMenuProps) {
  const { confirm } = useDialog();

  /**
   * Ask before removing, then hand the write back to the caller.
   *
   * Deferred out of the `onSelect` handler with a microtask: Radix closes the menu during
   * `onSelect`, and opening a dialog inside that same tick makes the menu's focus-restore race
   * the dialog's focus-trap — the symptom is a confirm that opens with nothing focused.
   */
  const askThenRemove = React.useCallback(() => {
    queueMicrotask(async () => {
      if (await confirm(removeRepositoryConfirm(repository))) onRemove(repository);
    });
  }, [confirm, onRemove, repository]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`Actions for ${repository.name}`}
          data-testid="repository-row-menu"
          className={cn('repo-row-menu', className)}
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            data-testid="repository-menu-detail"
            onSelect={() => onOpenDetail(repository)}
          >
            <FolderOpen aria-hidden />
            Open detail
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            data-testid="repository-menu-rescan"
            onSelect={() => onRescan(repository)}
          >
            <RefreshCw aria-hidden />
            Rescan
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="repo-menu__sep" />
          <DropdownMenu.Item
            className={cn(MENU_ITEM_CLASS, 'repo-menu__item--danger')}
            data-testid="repository-menu-remove"
            onSelect={askThenRemove}
          >
            <Trash2 aria-hidden />
            Remove from list
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default RepositoryRowMenu;
