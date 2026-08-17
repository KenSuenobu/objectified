'use client';

import * as React from 'react';
import { ArrowUpRight, Power, RotateCcw, Send, Shield, ShieldCheck, UserMinus } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/app/components/ui/Drawer';
import { Spinner } from '@/app/components/ui/Spinner';

import {
  formatMemberDate,
  formatMemberRelative,
  isPendingInvite,
  memberActivity,
  memberDisplayName,
  memberPermissionPreview,
  memberRowActions,
  memberStatusLabel,
  NO_TIMESTAMP,
  type AccessAuditRecord,
  type MemberCapabilities,
  type MemberRecord,
  type RoleRecord,
} from './membersModel';

/**
 * The member detail drawer — HIVE-5.2 (#5305).
 *
 * Authority: `docs/mockups/workspace/members.html` `#member-drawer`; DESIGN.md §5.4.
 *
 * The screen this replaces had no detail surface at all: a row was four cells, and everything
 * else about a person — when they joined, what their role actually grants, what they have
 * done in this workspace — was either absent or somewhere else entirely. This is the "quick
 * look" the roadmap asks for, and every field in it is real:
 *
 * * **Membership** reads the row (`joined_at`, `member_since`, `last_active`,
 *   `two_factor_enabled`), three of which this ticket added to the API.
 * * **Effective permissions** are the assigned role's own grid, from `GET /api/access/roles` —
 *   not a fixture, and not a second opinion about what a role means.
 * * **Recent activity** is the tenant's access ledger, narrowed to rows this person is the
 *   actor or the subject of. Five rows and a link out: HIVE-5.5 owns the audit surface, and a
 *   second one here would be a fork of it.
 *
 * Three of the mockup's fields are deliberately absent, all for the same reason: nothing
 * stores them. There is no `invited_by` on a membership, no linked-provider list scoped to a
 * tenant, and no "last active on *what*" — `users.last_login_at` is an instant, not a place.
 * A drawer that invented them would be the most convincing wrong screen in the product.
 */

/** Props for {@link MemberDetailDrawer}. */
export interface MemberDetailDrawerProps {
  /** The member being looked at; `null` closes the drawer. */
  member: MemberRecord | null;
  /** Called with `false` when the sheet is dismissed. */
  onOpenChange: (open: boolean) => void;
  /** The tenant's roles, for the role select and the permission grid. */
  roles: readonly RoleRecord[];
  /** What the viewer may do. */
  capabilities: MemberCapabilities;
  /** The session's user id, so the viewer's own membership stays read-only. */
  viewerId: string | null | undefined;
  /** The tenant's access ledger, or `null` while it is still loading. */
  auditRows: readonly AccessAuditRecord[] | null;
  /** True while the ledger is being read. */
  auditLoading?: boolean;
  /** Why the ledger could not be read, if it could not. */
  auditError?: string | null;
  /** True while a write about this member is in flight. */
  busy?: boolean;
  /** Assign a role. */
  onChangeRole: (member: MemberRecord, roleId: string) => void;
  /** Suspend or reinstate. */
  onToggleStatus: (member: MemberRecord) => void;
  /** Offboard, or cancel the invitation. */
  onOffboard: (member: MemberRecord) => void;
  /** Re-issue an outstanding invitation. */
  onResendInvite: (member: MemberRecord) => void;
  /** Where the Roles page lives, for the permissions section's link. */
  rolesHref: string;
  /** Where the access audit lives, for the activity section's link. */
  auditHref: string;
}

/**
 * One `<dt>`/`<dd>` pair of the membership list.
 *
 * @param props.label The term.
 * @param props.children The value.
 * @returns The pair.
 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * A section of the sheet: a caps heading and its content.
 *
 * @param props.title The heading.
 * @param props.children The content.
 * @returns The section.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mbr-caps mb-2">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The member detail sheet.
 *
 * @param props See {@link MemberDetailDrawerProps}.
 * @returns The drawer.
 */
export default function MemberDetailDrawer({
  member,
  onOpenChange,
  roles,
  capabilities,
  viewerId,
  auditRows,
  auditLoading = false,
  auditError = null,
  busy = false,
  onChangeRole,
  onToggleStatus,
  onOffboard,
  onResendInvite,
  rolesHref,
  auditHref,
}: MemberDetailDrawerProps) {
  const open = member !== null;
  const actions = member ? memberRowActions(member, { capabilities, viewerId }) : null;
  const permissions = member ? memberPermissionPreview(member, roles) : null;
  const activity = member && auditRows ? memberActivity(auditRows, member) : [];
  const name = member ? memberDisplayName(member) : '';
  const suspended = member?.status === 'suspended';
  const pending = Boolean(member && isPendingInvite(member));

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        size="default"
        data-testid="member-drawer"
        // Radix points the sheet at a description id whether or not one is rendered; this
        // drawer's sub-line is the identity block, not a `DrawerDescription`, so the
        // reference has to be cleared or it dangles (HIVE-2.2's rule).
        aria-describedby={undefined}
      >
        {member && (
          <>
            <DrawerHeader className="flex-row items-center gap-3">
              <Avatar name={name} seed={member.user_id} size="lg" />
              <div className="min-w-0 flex-1">
                <DrawerTitle className="truncate">{name}</DrawerTitle>
                <p className="truncate font-mono text-xs text-fg-muted">{member.email}</p>
              </div>
            </DrawerHeader>

            <DrawerBody className="space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge status={member.status} dot>
                  {memberStatusLabel(member.status)}
                </Badge>
                <Badge variant="outline">{member.role_name ?? 'No role'}</Badge>
                {member.is_admin && (
                  <Badge variant="violet">
                    <Shield aria-hidden />
                    Admin
                  </Badge>
                )}
              </div>

              <Section title="Membership">
                <dl className="mbr-kv">
                  <Fact label="Role">
                    {actions?.canChangeRole ? (
                      <select
                        className="hive-control mbr-role-select"
                        aria-label={`Role for ${name}`}
                        value={member.role_id ?? ''}
                        disabled={busy}
                        onChange={(event) => onChangeRole(member, event.target.value)}
                      >
                        {member.role_id === null && <option value="">No role</option>}
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{member.role_name ?? 'No role'}</span>
                    )}
                  </Fact>
                  <Fact label="Status">
                    {memberStatusLabel(member.status)}
                    {member.member_since
                      ? ` since ${formatMemberDate(member.member_since)}`
                      : ''}
                  </Fact>
                  <Fact label="Last active">{formatMemberRelative(member.last_active)}</Fact>
                  <Fact label="Joined">{formatMemberDate(member.joined_at)}</Fact>
                  <Fact label="Two-factor">
                    {member.two_factor_enabled ? (
                      <Badge variant="ok">
                        <ShieldCheck aria-hidden />
                        Enabled
                      </Badge>
                    ) : (
                      <Badge variant="outline">Not enabled</Badge>
                    )}
                  </Fact>
                  <Fact label="User id">
                    <span className="font-mono text-xs">{member.user_id}</span>
                  </Fact>
                </dl>
              </Section>

              <Section title="Effective permissions">
                {permissions && permissions.total > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {permissions.shown.map((label) => (
                        <span key={label} className="mbr-tag">
                          {label}
                        </span>
                      ))}
                      {permissions.more > 0 && (
                        <span className="text-xs text-fg-muted">+{permissions.more} more</span>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-fg-muted">
                      From role{' '}
                      {/* Underlined, not merely tinted: a link inside a block of text that is
                          distinguished by colour alone is an axe `link-in-text-block`
                          violation, and unreadable to anyone who cannot see the tint. */}
                      <a
                        className="text-accent-fg underline underline-offset-2 hover:text-accent"
                        href={rolesHref}
                      >
                        {member.role_name}
                      </a>
                      . Change the role to change permissions.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">
                    {member.role_name
                      ? `The ${member.role_name} role grants no permissions yet.`
                      : 'No role is assigned, so they hold no permissions in this workspace.'}
                  </p>
                )}
              </Section>

              <Section title="Recent access activity">
                {auditLoading ? (
                  <p className="flex items-center gap-2 text-sm text-fg-muted">
                    <Spinner size="sm" aria-hidden />
                    Loading the access ledger…
                  </p>
                ) : auditError ? (
                  <p className="text-sm text-fg-muted">{auditError}</p>
                ) : activity.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    Nothing in the access ledger mentions them yet.
                  </p>
                ) : (
                  <div data-testid="member-activity">
                    {activity.map((row) => (
                      <div key={row.id} className="mbr-activity">
                        <span className="mbr-activity__action">{row.action}</span>
                        <span className="mbr-activity__when">
                          {row.created_at ? formatMemberRelative(row.created_at) : NO_TIMESTAMP}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </DrawerBody>

            <DrawerFooter>
              {actions?.canOffboard && (
                <Button
                  variant="danger-soft"
                  className="mr-auto"
                  disabled={busy}
                  onClick={() => onOffboard(member)}
                >
                  <UserMinus aria-hidden />
                  {pending ? 'Cancel invite' : 'Offboard'}
                </Button>
              )}
              {actions?.canResendInvite && (
                <Button variant="outline" disabled={busy} onClick={() => onResendInvite(member)}>
                  <Send aria-hidden />
                  Resend
                </Button>
              )}
              {actions?.canChangeStatus && (
                <Button variant="outline" disabled={busy} onClick={() => onToggleStatus(member)}>
                  {suspended ? <RotateCcw aria-hidden /> : <Power aria-hidden />}
                  {suspended ? 'Reinstate' : 'Suspend'}
                </Button>
              )}
              <a
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-fg transition-colors hover:text-accent"
                href={auditHref}
              >
                Audit trail
                <ArrowUpRight className="size-[var(--icon-button)] shrink-0" aria-hidden />
              </a>
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
