'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronsUpDown } from 'lucide-react';
import { Avatar } from '@/app/components/ui/Avatar';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { cn } from '@lib/utils';
import { RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';

/**
 * The rail's workspace row — interim (HIVE-3.1, #5287; `DESIGN.md` §5.2 region 2).
 *
 * The finished switcher is **HIVE-3.3 (#5289)**: a 300 px menu with
 * search, role badges, licence chips, suspended rows and the create-workspace cap, ported
 * whole from `TopHeader`. It cannot land here — this ticket is the shell it opens from.
 *
 * What it must not do in the meantime is strand anyone: retiring the top bar takes the
 * tenant pill with it, so until the menu arrives this row is a **link to the tenants
 * page**, which is where workspaces are already listed and switched
 * (`/ade/dashboard/tenants`). Same position, same avatar, same name, one click further
 * from the switch. HIVE-3.3 replaces the element and keeps everything around it.
 */

/** Props for {@link RailWorkspaceLink}. */
export interface RailWorkspaceLinkProps {
  /** The active workspace's display name; absent while loading or when there is none. */
  tenantName?: string | null;
  /** The active workspace id — the seed the hex avatar takes its tint from. */
  tenantId?: string | null;
  /** Whether the rail is drawing icon-only, in which case the name moves to a tooltip. */
  iconRail: boolean;
  /** Where the row goes. Defaults to the tenants page. */
  href?: string;
}

/** Copy for a signed-in user who has not joined or created a workspace yet. */
const NO_WORKSPACE = 'No workspace';

/** The row's second line: what this link does, since it is not yet a switcher. */
const ROW_META = 'Manage workspaces';

/**
 * The workspace row.
 *
 * @param props See {@link RailWorkspaceLinkProps}.
 * @returns A 44 px row: hex avatar, workspace name, and what happens when it is clicked.
 */
export default function RailWorkspaceLink({
  tenantName,
  tenantId,
  iconRail,
  href = '/ade/dashboard/tenants',
}: RailWorkspaceLinkProps) {
  const name = tenantName?.trim() || NO_WORKSPACE;

  const row = (
    <Link
      href={href}
      data-testid="rail-workspace"
      className={cn(
        'rail-item flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
        'transition-colors duration-[var(--dur-fast)]',
        RAIL_ITEM_HOVER_CLASS
      )}
    >
      {/* Decorative by default (the name is written beside it) and `neutral` until there
          is an identity to hash — a placeholder must not borrow another workspace's tint. */}
      <Avatar
        size="sm"
        shape="hex"
        seed={tenantId ?? undefined}
        name={name}
        tone={tenantId ? 'auto' : 'neutral'}
        className="shrink-0"
      />
      <span className="rail-label min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold leading-tight text-fg">{name}</span>
        <span className="truncate text-2xs text-fg-subtle">{ROW_META}</span>
      </span>
      <span className="rail-label shrink-0 items-center text-fg-subtle">
        <ChevronsUpDown size={ICON_SIZE.button} aria-hidden />
      </span>
    </Link>
  );

  return (
    <RailTooltip label={`${name} — ${ROW_META}`} when={iconRail}>
      {row}
    </RailTooltip>
  );
}
