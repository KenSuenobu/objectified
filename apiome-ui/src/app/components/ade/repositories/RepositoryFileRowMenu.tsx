'use client';

/**
 * The verbs one indexed file offers (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §File row menu — *View details ·
 * Import… · Open on provider · Copy path*.
 *
 * The same shape as {@link import('./RepositoryRowMenu').RepositoryRowMenu}, and deliberately
 * a separate component rather than a generalisation of it: a repository's verbs and a file's
 * verbs have nothing in common but the trigger, and a menu that takes an array of items is a
 * menu with no opinion about what belongs in it.
 *
 * *Open on provider* is dropped rather than disabled when the repository has no resolvable web
 * base. A disabled row in a four-item menu reads as a feature the workspace has lost; the row
 * is simply not one of this repository's verbs, the same way *Rescan* is not a verb of a
 * repository that has never been indexed.
 */

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Copy, Ellipsis, ExternalLink, FileSearch, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/app/components/ui/Button';

export interface RepositoryFileRowMenuProps {
  /** Repository-relative path of the file this menu belongs to. */
  path: string;
  /** The branch it was indexed on — part of the provider URL. */
  branch: string;
  /** The repository's page on its provider, or `null` when there is none. */
  githubWebBase: string | null;
  /** Open the file-detail pane. */
  onView: () => void;
  /** Open the Map & import overlay for this file. */
  onImport: () => void;
}

/**
 * The file's page on its provider.
 *
 * Each segment is encoded separately so a path containing a `#` or a `?` still resolves, while
 * the separators stay separators.
 *
 * @param base The repository's web base, or null.
 * @param branch The branch to link into.
 * @param path Repository-relative path.
 * @returns The URL, or `null` when there is no base to build it from.
 */
export function repositoryFileProviderHref(
  base: string | null,
  branch: string,
  path: string
): string | null {
  if (!base) return null;
  const segments = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${base.replace(/\/+$/, '')}/blob/${encodeURIComponent(branch)}/${segments}`;
}

/**
 * Render the menu. See {@link RepositoryFileRowMenuProps}.
 *
 * @returns The overflow trigger and its items.
 */
export function RepositoryFileRowMenu({
  path,
  branch,
  githubWebBase,
  onView,
  onImport,
}: RepositoryFileRowMenuProps) {
  const providerHref = repositoryFileProviderHref(githubWebBase, branch, path);

  const copyPath = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success('Path copied to clipboard.');
    } catch {
      toast.error('Could not copy path.');
    }
  }, [path]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="repo-row-menu"
          aria-label={`Actions for ${path}`}
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
          <DropdownMenu.Item className="tnt-menu__item" onSelect={onView}>
            <FileSearch aria-hidden />
            View details
          </DropdownMenu.Item>
          <DropdownMenu.Item className="tnt-menu__item" onSelect={onImport}>
            <Upload aria-hidden />
            Import…
          </DropdownMenu.Item>
          {providerHref ? (
            <DropdownMenu.Item asChild className="tnt-menu__item">
              <a href={providerHref} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
                Open on provider
              </a>
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className="tnt-menu__item" onSelect={() => void copyPath()}>
            <Copy aria-hidden />
            Copy path
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default RepositoryFileRowMenu;
