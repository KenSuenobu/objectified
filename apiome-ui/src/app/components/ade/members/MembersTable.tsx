'use client';

import * as React from 'react';
import { Mail, Power, RotateCcw, Send, Shield, Trash2, UserPlus, Users } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableFilterChip,
  DataTableSearch,
  DataTableToolbarSpacer,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';

import {
  describeMemberBreakdown,
  formatMemberDate,
  formatMemberRelative,
  isPendingInvite,
  isSelf,
  matchesMemberFacet,
  memberDisplayName,
  memberFacetCounts,
  memberRowActions,
  memberStatusLabel,
  searchMembers,
  sortMembers,
  summariseMembers,
  MEMBER_FACETS,
  MEMBER_FACET_LABELS,
  type MemberCapabilities,
  type MemberFacet,
  type MemberRecord,
  type RoleRecord,
} from './membersModel';

/**
 * The members list — HIVE-5.2 (#5305).
 *
 * Authority: `docs/mockups/workspace/members.html` `#members-table`; DESIGN.md §8 (list
 * pattern) and §2.4 (the shared status vocabulary).
 *
 * ### What changed from the screen this replaces
 *
 * The old table was four hand-built columns — User, Role, Status, Actions — with two bespoke
 * status chips (`bg-emerald-100` / `bg-amber-100` / `bg-rose-100`, none of which followed a
 * theme), no way to find one person among fifty, and no visible difference between a member
 * and an invitation nobody had accepted. It is now {@link DataTable}, so it gets the sticky
 * caps header, the sortable columns, the row-hover actions, the `.` shortcut, the skeleton
 * and the in-card empty state for free, with the toolbar the mockup adds: a search box over
 * name *and* email, and the five facet chips.
 *
 * Two columns are new and both are real: **Last active** (`users.last_login_at`) and
 * **Joined** (`tenant_users.created_at`), which this ticket added to
 * `GET /v1/access/{slug}/members` because both columns the roadmap asks for were, until now,
 * data the API did not return.
 *
 * ### Two deliberate departures from the mockup
 *
 * The mockup puts `data-member-email` on the `<tr>`. `DataTable` sets a row's attributes itself and
 * takes no per-row escape hatch, so the attribute — and the `member-row` test id the OLO
 * journey suites count — sit on the identity cell instead: one per row either way, and
 * neither is worth a new prop on a primitive forty screens share.
 *
 * The mockup also fades a suspended row to 85 %. HIVE-4.8 measured that: `--fg-muted` behind an
 * `opacity: .85` row is 3.99:1, under AA. The Suspended badge is what says a member is
 * suspended, and it says it without dimming anything. A pending row *is* tinted — see
 * `.mbr-row--pending` in `globals.css` — because a tint changes the backdrop rather than the
 * ink, which is the one of the two that cannot fail a contrast check.
 */

/** Props for {@link MembersTable}. */
export interface MembersTableProps {
  /** Every member of the tenant. */
  members: readonly MemberRecord[];
  /** The tenant's roles, for the inline role select. */
  roles: readonly RoleRecord[];
  /** What the viewer may do, from `memberCapabilities`. */
  capabilities: MemberCapabilities;
  /** The session's user id, so the viewer's own row can be marked and protected. */
  viewerId: string | null | undefined;
  /** True while the page is loading. */
  loading?: boolean;
  /** The load error, if the roster could not be read. */
  error?: string | null;
  /** Retry the load. */
  onRetry?: () => void;
  /** The member whose row controls are inert because a write is in flight. */
  busyMemberId?: string | null;
  /** Open the detail drawer. */
  onOpenMember: (member: MemberRecord) => void;
  /** Assign a role. */
  onChangeRole: (member: MemberRecord, roleId: string) => void;
  /** Suspend or reinstate. */
  onToggleStatus: (member: MemberRecord) => void;
  /** Offboard, or cancel an invitation. */
  onOffboard: (member: MemberRecord) => void;
  /** Re-issue an outstanding invitation. */
  onResendInvite: (member: MemberRecord) => void;
  /** Open the invite dialog, from the empty state. */
  onInvite: () => void;
  /** Whether inviting is offered at all — false at capacity or without the grant. */
  canInviteNow: boolean;
}

/**
 * Stop a click inside a cell from also activating the row.
 *
 * The role select and the row's own buttons are their own affordances; without this, changing
 * a role would also open the drawer behind the select. The actions column is already handled
 * by `DataTable`, so only the role cell needs it.
 *
 * @param event The click.
 */
function swallowRowActivation(event: React.MouseEvent) {
  event.stopPropagation();
}

/**
 * The members list, its toolbar and its per-row controls.
 *
 * @param props See {@link MembersTableProps}.
 * @returns The table card.
 */
export default function MembersTable({
  members,
  roles,
  capabilities,
  viewerId,
  loading = false,
  error = null,
  onRetry,
  busyMemberId = null,
  onOpenMember,
  onChangeRole,
  onToggleStatus,
  onOffboard,
  onResendInvite,
  onInvite,
  canInviteNow,
}: MembersTableProps) {
  const [query, setQuery] = React.useState('');
  const [facet, setFacet] = React.useState<MemberFacet>('all');
  const [sort, setSort] = React.useState<DataTableSortState | null>({
    column: 'user',
    direction: 'asc',
  });

  const searched = React.useMemo(() => searchMembers(members, query), [members, query]);
  const counts = React.useMemo(() => memberFacetCounts(searched), [searched]);
  const visible = React.useMemo(
    () => sortMembers(searched.filter((member) => matchesMemberFacet(member, facet)), sort),
    [searched, facet, sort]
  );
  const summary = React.useMemo(() => summariseMembers(members), [members]);
  const narrowed = query.trim().length > 0 || facet !== 'all';

  const columns = React.useMemo<DataTableColumn<MemberRecord>[]>(
    () => [
      {
        id: 'user',
        header: 'User',
        sortable: true,
        cell: (member) => {
          const pending = isPendingInvite(member);
          const name = memberDisplayName(member);
          return (
            <div
              className="mbr-identity"
              data-testid="member-row"
              data-member-email={member.email}
            >
              {pending ? (
                <span className="mbr-invite-mark">
                  <Mail aria-hidden />
                </span>
              ) : (
                <Avatar name={name} seed={member.user_id} size="sm" />
              )}
              <span className="mbr-identity__text">
                <span className="mbr-identity__name">
                  {name}
                  {isSelf(member, viewerId) && <span className="mbr-identity__self">(you)</span>}
                </span>
                <span className="mbr-identity__sub mono">
                  {pending
                    ? `Invited ${formatMemberDate(member.member_since)}`
                    : member.email}
                </span>
              </span>
            </div>
          );
        },
        skeletonWidth: '12rem',
      },
      {
        id: 'role',
        header: 'Role',
        cell: (member) => {
          const actions = memberRowActions(member, { capabilities, viewerId });
          if (!actions.canChangeRole) {
            return (
              <Badge variant="outline" title={actions.disabledReason ?? undefined}>
                {member.role_name ?? 'No role'}
              </Badge>
            );
          }
          return (
            <span onClick={swallowRowActivation}>
              <select
                className="hive-control mbr-role-select"
                aria-label={`Role for ${memberDisplayName(member)}`}
                value={member.role_id ?? ''}
                disabled={busyMemberId === member.user_id}
                onChange={(event) => onChangeRole(member, event.target.value)}
              >
                {member.role_id === null && <option value="">No role</option>}
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </span>
          );
        },
        skeletonWidth: '8rem',
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (member) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge status={member.status} dot>
              {memberStatusLabel(member.status)}
            </Badge>
            {member.is_admin && (
              <Badge variant="violet">
                <Shield aria-hidden />
                Admin
              </Badge>
            )}
          </span>
        ),
        skeletonWidth: '5.5rem',
      },
      {
        id: 'lastActive',
        header: 'Last active',
        sortable: true,
        cell: (member) => (
          <span className="whitespace-nowrap text-sm text-fg-muted tabular-nums">
            {formatMemberRelative(member.last_active)}
          </span>
        ),
        skeletonWidth: '5rem',
      },
      {
        id: 'joined',
        header: 'Joined',
        sortable: true,
        cell: (member) => (
          <span className="whitespace-nowrap text-sm text-fg-muted tabular-nums">
            {formatMemberDate(member.joined_at)}
          </span>
        ),
        skeletonWidth: '5.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        cell: (member) => {
          const actions = memberRowActions(member, { capabilities, viewerId });
          const busy = busyMemberId === member.user_id;
          const name = memberDisplayName(member);
          const suspended = member.status === 'suspended';
          return (
            <div className="mbr-row-actions">
              {actions.canResendInvite && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  title="Re-issue this invitation"
                  onClick={() => onResendInvite(member)}
                >
                  <Send aria-hidden />
                  Resend
                </Button>
              )}
              {actions.canChangeStatus &&
                (suspended ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title="Reinstate"
                    onClick={() => onToggleStatus(member)}
                  >
                    <RotateCcw aria-hidden />
                    Reinstate
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1.5"
                    disabled={busy}
                    title="Suspend"
                    aria-label={`Suspend ${name}`}
                    onClick={() => onToggleStatus(member)}
                  >
                    <Power aria-hidden />
                  </Button>
                ))}
              {actions.canOffboard && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-1.5"
                  disabled={busy}
                  title={isPendingInvite(member) ? 'Cancel invite' : 'Offboard'}
                  aria-label={
                    isPendingInvite(member)
                      ? `Cancel the invitation for ${name}`
                      : `Offboard ${name}`
                  }
                  onClick={() => onOffboard(member)}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
          );
        },
        skeletonWidth: '5rem',
      },
    ],
    [
      busyMemberId,
      capabilities,
      onChangeRole,
      onOffboard,
      onResendInvite,
      onToggleStatus,
      roles,
      viewerId,
    ]
  );

  return (
    <DataTable
      columns={columns}
      rows={visible}
      getRowId={(member) => member.user_id}
      getRowLabel={(member) => memberDisplayName(member)}
      caption="Members of this workspace"
      scrollX
      loading={loading}
      loadingLabel="Loading members…"
      error={error}
      onRetry={onRetry}
      sort={sort}
      onSortChange={setSort}
      onRowActivate={onOpenMember}
      rowClassName={(member) => (isPendingInvite(member) ? 'mbr-row--pending' : undefined)}
      data-testid="members-table"
      toolbar={
        <>
          <DataTableSearch
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name or email…"
            aria-label="Filter members"
          />
          {MEMBER_FACETS.map((entry) => (
            <DataTableFilterChip
              key={entry}
              active={facet === entry}
              count={counts[entry]}
              onClick={() => setFacet(entry)}
            >
              {entry === 'admins' && <Shield aria-hidden />}
              {MEMBER_FACET_LABELS[entry]}
            </DataTableFilterChip>
          ))}
          <DataTableToolbarSpacer />
        </>
      }
      empty={
        narrowed ? (
          <EmptyState
            variant="compact"
            icon={<Users aria-hidden />}
            title="No members match these filters"
            description="Clear the search box or pick a different facet."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setFacet('all');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<Users aria-hidden />}
            title="No members yet"
            description="Invite teammates by email and pick a role — they get access as soon as they accept."
            action={
              canInviteNow ? (
                <Button onClick={onInvite}>
                  <UserPlus aria-hidden />
                  Invite member
                </Button>
              ) : undefined
            }
          />
        )
      }
      footer={
        <span className="text-xs text-fg-muted" data-testid="members-summary">
          {describeMemberBreakdown(summary)}
        </span>
      }
    />
  );
}
