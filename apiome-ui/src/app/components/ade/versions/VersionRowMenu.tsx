'use client';

/**
 * A revision row's overflow menu (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Row actions menu — *View spec · Export to
 * another format… · [gitlike] Compare with current · Relationship graph · Branch from here ·
 * Rollback… · Fork… · Tag · Schedule sunset (EOL)… · Edit · Publish/Unpublish · [gitlike]
 * Freeze schema · Lock/Unlock revision · Delete*, with the flag-gated items carrying a honey
 * `gitlike` flag rather than being hidden.
 *
 * ### What this replaces
 *
 * A hand-positioned `position: fixed` panel with its own viewport arithmetic
 * (`computeVersionActionsDropdownPosition`), a full-screen click-catcher `<div>`, and
 * fifteen `<button>`s each carrying the same forty-character hover string. It is a Radix
 * `DropdownMenu` now — the same one the projects and tenants tables use — which brings the
 * placement, the focus trap, the arrow keys, `Escape`, and the `menu`/`menuitem` roles.
 *
 * ### What it decides, and what it does not
 *
 * Nothing. Which items appear, which are inert and why is `versionRowMenuItems` in
 * `versionsModel`, so the fifteen rules — owner-or-admin, published-and-not-admin, locked,
 * archived, head, frozen, publishable, and the `FEATURE_GITLIKE` build rule — are unit
 * tested as data. This maps an item id to a glyph and hands a chosen id back to the screen,
 * whose `handleRowAction` is unchanged.
 */

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Ellipsis,
  Eye,
  FileOutput,
  GitBranch,
  GitCompareArrows,
  GitFork,
  Lock,
  Network,
  Pencil,
  Shield,
  Snowflake,
  Sun,
  Tag,
  Trash2,
  Undo2,
  Unlock,
} from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { cn } from '@lib/utils';

import { GitlikeFlag } from './GitlikeFlag';
import {
  versionLabel,
  versionRowMenuItems,
  type Version,
  type VersionRowMenuAction,
  type VersionRowMenuContext,
} from './versionsModel';

/** The glyph each action carries. */
const ACTION_ICON: Readonly<Record<VersionRowMenuAction, React.ComponentType<{ className?: string }>>> = {
  view: Eye,
  export: FileOutput,
  compareWithCurrent: GitCompareArrows,
  relationshipGraph: Network,
  branchFrom: GitBranch,
  rollbackBranch: Undo2,
  forkToProject: GitFork,
  tagFrom: Tag,
  scheduleSunset: Sun,
  edit: Pencil,
  publish: Lock,
  unpublish: Unlock,
  freezeSchema: Snowflake,
  toggleLock: Shield,
  delete: Trash2,
};

export interface VersionRowMenuProps {
  /** The revision. */
  version: Version;
  /** Everything the menu's rules need beyond the revision. */
  context: VersionRowMenuContext;
  /** Called with the chosen action. */
  onAction: (action: VersionRowMenuAction, version: Version) => void;
  /** True while a write is in flight — the trigger goes inert. */
  busy?: boolean;
}

/**
 * Render the row menu. See {@link VersionRowMenuProps}.
 *
 * @returns The trigger and its portalled menu.
 */
export function VersionRowMenu({ version, context, onAction, busy = false }: VersionRowMenuProps) {
  const items = React.useMemo(() => versionRowMenuItems(version, context), [version, context]);
  const label = versionLabel(version);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="px-1.5"
          disabled={busy}
          aria-label={`Actions for ${label}`}
          title="Actions"
          data-testid={`versions-row-menu-${version.id}`}
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tnt-menu ver-menu"
          sideOffset={4}
          align="end"
          collisionPadding={8}
          data-testid={`versions-row-menu-content-${version.id}`}
        >
          {items.map((item) => {
            const Icon = ACTION_ICON[item.id];
            return (
              <React.Fragment key={item.id}>
                {item.separatorBefore ? <DropdownMenu.Separator className="ver-menu__sep" /> : null}
                <DropdownMenu.Item
                  className={cn(
                    'tnt-menu__item ver-menu__item',
                    item.danger && 'ver-menu__item--danger',
                    item.id === 'publish' && 'ver-menu__item--publish'
                  )}
                  disabled={item.disabled}
                  title={item.title}
                  data-testid={`versions-row-action-${item.id}`}
                  data-gitlike={item.gitlike || undefined}
                  onSelect={() => onAction(item.id, version)}
                >
                  <Icon aria-hidden />
                  {item.label}
                  {item.gitlike && context.gitlike.marked ? (
                    <GitlikeFlag enabled={context.gitlike.enabled} className="ver-menu__flag" />
                  ) : null}
                </DropdownMenu.Item>
              </React.Fragment>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default VersionRowMenu;
