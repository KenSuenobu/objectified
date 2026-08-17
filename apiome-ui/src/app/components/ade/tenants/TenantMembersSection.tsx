'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Pencil, Shield, Trash2, UserPlus, Users, X } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { DataTable, type DataTableColumn } from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Input } from '@/app/components/ui/Input';

import {
  filterTenantMembers,
  sortTenantMembers,
  summariseTenantMembers,
  type TenantMember,
} from './tenantsModel';

/**
 * The manage drawer's Members section — HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `[data-tab-panel="m-members"]`.
 *
 * ### The bug this section exists to fix
 *
 * On the screen this replaces, the filter box's value and the section's expanded flag were
 * two `useState`s in the page component, shared by every tenant's panel at once — so typing
 * into one tenant's filter filtered every other tenant's members, and expanding one
 * expanded all of them. This component holds the filter itself, one instance per drawer,
 * and a drawer is scoped to one tenant. That is the whole fix, and it is structural rather
 * than a matter of remembering to key the state by tenant id.
 *
 * The list itself is not filtered here either — {@link filterTenantMembers} and
 * {@link sortTenantMembers} take the members as an argument, so there is no ambient state
 * for a second tenant to read.
 */

/** Props for {@link TenantMembersSection}. */
export interface TenantMembersSectionProps {
  /** Everyone in this tenant, merged from both join tables and unfiltered. */
  members: readonly TenantMember[];
  /** The tenant's name, for the empty state's sentence. */
  tenantName: string;
  /** The viewer, so their own row's destructive actions can be withheld. */
  currentUserId: string | null | undefined;
  /** True while the page is (re)loading the tenant lists. */
  loading?: boolean;
  /** Open the Add member dialog. */
  onAddMember: () => void;
  /** Open Edit member roles for one person. */
  onEditMember: (member: TenantMember) => void;
  /** Open the Remove member confirm for one person. */
  onRemoveMember: (member: TenantMember) => void;
  /** Where the drawer's "Open members & roles" link goes. */
  membersPageHref: string;
}

/** Why a row's edit and remove buttons are withheld. */
const SELF_ROW_TITLE = 'You cannot edit your own membership';

/**
 * The members table, its filter, and the Add member action.
 *
 * @param props See {@link TenantMembersSectionProps}.
 * @returns The section.
 */
export default function TenantMembersSection({
  members,
  tenantName,
  currentUserId,
  loading = false,
  onAddMember,
  onEditMember,
  onRemoveMember,
  membersPageHref,
}: TenantMembersSectionProps) {
  /** This drawer's filter. One instance per tenant, which is the point. */
  const [filter, setFilter] = React.useState('');

  const visible = React.useMemo(
    () => sortTenantMembers(filterTenantMembers(members, filter)),
    [members, filter]
  );
  // Counted against the whole tenant, not the filter: the foot describes the tenant.
  const summary = React.useMemo(() => summariseTenantMembers(members), [members]);
  const filtering = filter.trim().length > 0;

  const columns = React.useMemo<DataTableColumn<TenantMember>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        cell: (member) => (
          <div className="flex items-center gap-2">
            <Avatar name={member.name} seed={member.userId} size="xs" />
            <span className="truncate font-medium text-fg">{member.name}</span>
            {member.userId === currentUserId && (
              <span className="shrink-0 text-xs text-fg-muted">(you)</span>
            )}
          </div>
        ),
        skeletonWidth: '9rem',
      },
      {
        id: 'email',
        header: 'Email',
        cell: (member) => (
          <span className="truncate font-mono text-xs text-fg-muted">{member.email}</span>
        ),
        skeletonWidth: '11rem',
      },
      {
        id: 'role',
        header: 'Role',
        cell: (member) => (
          <span className="flex flex-wrap items-center gap-1">
            {member.isAdmin && (
              <Badge variant="violet">
                <Shield aria-hidden />
                Admin
              </Badge>
            )}
            {member.isMember && (
              <Badge variant="accent">
                <Users aria-hidden />
                Member
              </Badge>
            )}
          </span>
        ),
        skeletonWidth: '5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        cell: (member) => {
          const isSelf = member.userId === currentUserId;
          return (
            <div
              className="flex items-center justify-end gap-0.5"
              title={isSelf ? SELF_ROW_TITLE : undefined}
            >
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5"
                onClick={() => onEditMember(member)}
                disabled={isSelf}
                aria-label={`Edit roles for ${member.name}`}
              >
                <Pencil aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5"
                onClick={() => onRemoveMember(member)}
                disabled={isSelf}
                aria-label={`Remove ${member.name}`}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          );
        },
        skeletonWidth: '3rem',
      },
    ],
    [currentUserId, onEditMember, onRemoveMember]
  );

  return (
    <section aria-labelledby="tnt-members-heading" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="tnt-members-heading" className="tnt-section-title">
            Members
          </h3>
          <p className="tnt-section-desc">
            Administrators can manage tenant members and settings.
          </p>
        </div>
        <Button size="sm" onClick={onAddMember}>
          <UserPlus aria-hidden />
          Add member
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={visible}
        getRowId={(member) => member.userId}
        getRowLabel={(member) => member.name}
        caption={`Members of ${tenantName}`}
        dense
        loading={loading}
        loadingLabel="Loading members…"
        className="shadow-[inset_0_0_0_1px_var(--border)]"
        toolbar={
          <>
            <div className="relative flex min-w-0 flex-1 items-center sm:max-w-[20rem]">
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by name or email…"
                aria-label="Filter members"
                className="h-[var(--control-h-sm)] pr-8 text-sm"
              />
              {filtering && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-0.5 px-1.5"
                  onClick={() => setFilter('')}
                  aria-label="Clear filter"
                >
                  <X aria-hidden />
                </Button>
              )}
            </div>
            <span className="ml-auto shrink-0 text-xs text-fg-muted">
              Admins first, then name
            </span>
          </>
        }
        empty={
          filtering ? (
            <EmptyState
              variant="compact"
              icon={<Users aria-hidden />}
              title="No members match the filter"
              description="Clear the filter to see everyone in this tenant."
              action={
                <Button variant="outline" size="sm" onClick={() => setFilter('')}>
                  Clear filter
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="compact"
              icon={<Users aria-hidden />}
              title="No members yet"
              description={`Add someone to ${tenantName} to start working together.`}
              action={
                <Button size="sm" onClick={onAddMember}>
                  <UserPlus aria-hidden />
                  Add member
                </Button>
              }
            />
          )
        }
        footer={
          <>
            <span className="text-xs text-fg-muted">
              {summary.total} {summary.total === 1 ? 'member' : 'members'} · {summary.admins}{' '}
              {summary.admins === 1 ? 'admin' : 'admins'}
            </span>
            <Link
              href={membersPageHref}
              className="ml-auto inline-flex items-center gap-1 text-xs text-accent-fg transition-colors hover:text-accent"
            >
              Open members &amp; roles
              <ArrowRight className="size-[var(--icon-button)]" aria-hidden />
            </Link>
          </>
        }
      />
    </section>
  );
}
