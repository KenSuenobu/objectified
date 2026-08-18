'use client';

import * as React from 'react';
import { Shield, UserPlus } from 'lucide-react';

import { useAuthSession } from '@lib/auth/session-client';
import type { ShortcutBinding } from '@lib/shortcuts';
import { useShortcuts } from '@/app/hooks/useShortcuts';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import {
  fetchAccessAudit,
  fetchMembers,
  fetchMyPermissions,
  fetchRoles,
  assignMemberRole,
  inviteMember,
  offboardMember,
  resendMemberInvite,
  setMemberStatus,
  IdentityProviderCards,
  InviteMemberDialog,
  MemberDetailDrawer,
  MemberSeatsCard,
  MembersTable,
  OffboardMemberDialog,
  SuspendMemberDialog,
  describeMemberCount,
  inviteBlockedBySeats,
  memberCapabilities,
  nextMemberStatus,
  summariseMembers,
  SEATS_EXHAUSTED_TITLE,
  type AccessAuditRecord,
  type MemberRecord,
  type MyPermissions,
  type RoleRecord,
} from '@/app/components/ade/members';
import { fetchTenantLicense } from '../tenants/licenseApi';
import { describeLicenseError } from '../tenants/licenseErrors';
import type { TenantLicensePlan, TenantLicenseSeats } from '../tenants/licenseApi';

/**
 * Members — `/ade/dashboard/members` (HIVE-5.2, #5305).
 *
 * Authority: `docs/mockups/workspace/members.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §5.4 (drawer), §8 (list).
 *
 * ### What this page owns
 *
 * The data and the writes, and nothing about how either is drawn. The seat meter is
 * {@link MemberSeatsCard}, the roster is {@link MembersTable}, one person is
 * {@link MemberDetailDrawer}, and the three decisions are their own dialogs. What is left here
 * is what genuinely belongs to a page: one load, five mutations, and which overlay is open.
 *
 * ### The three things this rewrite closes
 *
 * 1. **Suspending had no confirm.** The power glyph in a row suspended a colleague on the
 *    first click. It now opens {@link SuspendMemberDialog}, which the mockup calls the
 *    redesign's convenience and which is really a safety rail.
 * 2. **A pending invitation looked exactly like a member.** Same avatar, same row, a status
 *    chip in a colour nothing else used. Invitations are now tinted rows with an envelope
 *    mark, an "Invited {date}" line, and the two actions that only make sense for them.
 * 3. **The screen could offboard the viewer.** Nothing stopped an owner removing their own
 *    membership and losing the workspace. `memberRowActions` now closes every write on the
 *    viewer's own row, in one place rather than at six call sites.
 *
 * ### Errors are the page's, results are the caller's
 *
 * Every write returns `string | null` to the dialog that asked for it, so a failure is shown
 * *in* the dialog, beside the control that caused it, rather than in a banner behind an
 * overlay the reader cannot see past. The page-level banner is for the load and for the
 * writes that have no dialog — the inline role select and Resend.
 */

/** The breadcrumb's first step, and the drawer's link out. */
const HOME_ROUTE = '/ade/dashboard';

/** Where the Roles page lives — the permissions section's link and the header's secondary. */
const ROLES_ROUTE = '/ade/dashboard/roles';

/** Where the access audit lives. */
const AUDIT_ROUTE = '/ade/dashboard/audit';

/** Which overlay, if any, is open over the page. */
type MemberOverlay = 'none' | 'invite' | 'suspend' | 'offboard';

/**
 * The page's own `N`.
 *
 * The mockup prints a `N` chip on the header's primary, and HIVE-3.7's registry is explicit
 * that a list page owning a better `N` registers over the shell's generic one for as long as
 * it is mounted. Declared here rather than in `lib/shortcuts.ts` because it means nothing
 * anywhere else, and registered only while inviting is actually possible — a chip that
 * promises a chord which does not fire is the one thing the registry exists to prevent.
 */
const INVITE_SHORTCUT_ID = 'members-invite';

/**
 * Turn a caught write failure into the sentence to show.
 *
 * Licence refusals (OLO-5.3) arrive as a stable machine code and are worth friendlier copy
 * than the server's own message; everything else is shown as the API said it. One reader so
 * the five call sites cannot each pick a different fallback.
 *
 * @param error Whatever was caught.
 * @param fallback What to say when the failure carried no message.
 * @returns The sentence.
 */
function describeWriteFailure(error: unknown, fallback: string): string {
  return (
    describeLicenseError(error) ?? (error instanceof Error ? error.message : fallback)
  );
}

/**
 * The members page.
 *
 * @returns The page header, the seat meter, the roster, the drawer and the three dialogs.
 */
export default function MembersClient() {
  const { data: session } = useAuthSession();

  const [members, setMembers] = React.useState<MemberRecord[]>([]);
  const [roles, setRoles] = React.useState<RoleRecord[]>([]);
  const [perms, setPerms] = React.useState<MyPermissions | null>(null);
  const [seats, setSeats] = React.useState<TenantLicenseSeats | null>(null);
  const [plan, setPlan] = React.useState<TenantLicensePlan | null>(null);
  const [loading, setLoading] = React.useState(true);
  /**
   * Why the roster could not be read.
   *
   * Kept apart from {@link error} because the two belong in different places. A load failure
   * leaves the table with nothing to draw, and a table with nothing to draw says "No members
   * yet" — which is a claim about the workspace, not about the request. It therefore goes
   * *into* the card, as `DataTable`'s own error state with a retry beside it. A write failure
   * has a table full of rows behind it and belongs in a banner.
   */
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');

  /** The member a write is running against, so only that row's controls go inert. */
  const [busyMemberId, setBusyMemberId] = React.useState<string | null>(null);
  const [overlay, setOverlay] = React.useState<MemberOverlay>('none');
  /** Who the open overlay is about; independent of the drawer, which can be open behind it. */
  const [overlayMemberId, setOverlayMemberId] = React.useState<string | null>(null);
  /** Whose detail drawer is open. An id rather than the record, so a reload refreshes it. */
  const [openMemberId, setOpenMemberId] = React.useState<string | null>(null);

  const [auditRows, setAuditRows] = React.useState<AccessAuditRecord[] | null>(null);
  const [auditLoading, setAuditLoading] = React.useState(false);
  const [auditError, setAuditError] = React.useState<string | null>(null);

  const sessionUser = session?.user as { user_id?: string } | undefined;
  const viewerId = sessionUser?.user_id ?? null;

  const capabilities = React.useMemo(() => memberCapabilities(perms), [perms]);
  const summary = React.useMemo(() => summariseMembers(members), [members]);
  const atCapacity = inviteBlockedBySeats(seats);
  const canInviteNow = capabilities.canInvite && !atCapacity;

  const inviteShortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      canInviteNow
        ? [
            {
              id: INVITE_SHORTCUT_ID,
              scope: 'list',
              description: 'Invite member',
              chord: { key: 'n' },
              run: () => setOverlay('invite'),
            },
          ]
        : [],
    [canInviteNow]
  );
  useShortcuts(inviteShortcuts);

  const openMember = React.useMemo(
    () => members.find((member) => member.user_id === openMemberId) ?? null,
    [members, openMemberId]
  );
  const overlayMember = React.useMemo(
    () => members.find((member) => member.user_id === overlayMemberId) ?? null,
    [members, overlayMemberId]
  );

  // ---- load -----------------------------------------------------------------------------

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [membersData, rolesData, permsData, licenseData] = await Promise.all([
        fetchMembers(),
        fetchRoles(),
        fetchMyPermissions(),
        // Seat usage is best-effort context for the invite control: a licence read failure
        // must not blank the roster, so it is swallowed to `null` and the card hides itself.
        fetchTenantLicense().catch(() => null),
      ]);
      setMembers(membersData);
      setRoles(rolesData);
      setPerms(permsData);
      setSeats(licenseData?.seats ?? null);
      setPlan(licenseData?.plan ?? null);
    } catch (e) {
      setMembers([]);
      setLoadError(e instanceof Error ? e.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  // The ledger is the drawer's alone, so it is read when the drawer first opens and kept for
  // the rest of the visit — reading it again for the next member would re-fetch the same
  // 200 rows to narrow them differently.
  //
  // The latch is what makes that safe. Guarding on `auditLoading` instead would deadlock: the
  // effect sets it, the state change re-runs the effect, the *first* run's cleanup fires and
  // sets `cancelled`, and the in-flight answer is then thrown away with the flag still true —
  // a spinner that never stops. `auditWanted` flips once and never again, so this effect runs
  // exactly once and its cleanup only fires on unmount.
  const [auditWanted, setAuditWanted] = React.useState(false);

  React.useEffect(() => {
    if (openMemberId) setAuditWanted(true);
  }, [openMemberId]);

  React.useEffect(() => {
    if (!auditWanted) return;
    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);
    fetchAccessAudit()
      .then((rows) => {
        if (!cancelled) setAuditRows(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          setAuditError(
            e instanceof Error ? e.message : 'The access ledger could not be read.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auditWanted]);

  // ---- writes ---------------------------------------------------------------------------

  /**
   * Run one write against one member, then reload.
   *
   * Every mutation on this page has the same shape — mark the row busy, call, reload on
   * success, hand the failure back as a sentence — and stating it once is what keeps the five
   * of them from drifting into five different error behaviours.
   *
   * @param member The member the write is about.
   * @param fallback What to say if the failure carried no message.
   * @param write The call.
   * @returns `null` on success, or the sentence to show.
   */
  const runWrite = React.useCallback(
    async (
      member: MemberRecord,
      fallback: string,
      write: () => Promise<void>
    ): Promise<string | null> => {
      setBusyMemberId(member.user_id);
      try {
        await write();
        await loadData();
        return null;
      } catch (e) {
        return describeWriteFailure(e, fallback);
      } finally {
        setBusyMemberId(null);
      }
    },
    [loadData]
  );

  const handleInvite = React.useCallback(
    async (input: { email: string; roleId: string }): Promise<string | null> => {
      try {
        await inviteMember({ email: input.email, roleId: input.roleId || undefined });
        await loadData();
        return null;
      } catch (e) {
        return describeWriteFailure(e, 'Failed to invite member');
      }
    },
    [loadData]
  );

  const handleChangeRole = React.useCallback(
    async (member: MemberRecord, roleId: string) => {
      if (!roleId || roleId === member.role_id) return;
      setError('');
      // The inline select has nowhere to put an error of its own, so this one write reports
      // to the page banner.
      const failure = await runWrite(member, 'Failed to change role', () =>
        assignMemberRole(member.user_id, roleId)
      );
      if (failure) setError(failure);
    },
    [runWrite]
  );

  const handleResendInvite = React.useCallback(
    async (member: MemberRecord) => {
      setError('');
      const failure = await runWrite(member, 'Failed to re-issue the invitation', () =>
        resendMemberInvite(member.user_id)
      );
      if (failure) setError(failure);
    },
    [runWrite]
  );

  const handleToggleStatus = React.useCallback(
    (member: MemberRecord) =>
      runWrite(member, 'Failed to update status', () =>
        setMemberStatus(member.user_id, nextMemberStatus(member))
      ),
    [runWrite]
  );

  const handleOffboard = React.useCallback(
    async (member: MemberRecord) => {
      const failure = await runWrite(member, 'Failed to offboard member', () =>
        offboardMember(member.user_id)
      );
      // The drawer, if it was open on this person, is now about somebody who is not there.
      if (!failure && openMemberId === member.user_id) setOpenMemberId(null);
      return failure;
    },
    [openMemberId, runWrite]
  );

  // ---- overlay helpers ------------------------------------------------------------------

  const openOverlayFor = React.useCallback((next: MemberOverlay, memberId: string) => {
    setOverlayMemberId(memberId);
    setOverlay(next);
  }, []);

  const closeOverlay = React.useCallback(() => setOverlay('none'), []);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Workspace' },
          { label: 'Members' },
        ]}
        title="Members"
        description="Who can sign in to this workspace, and what they may do."
        actions={
          <>
            <span className="text-xs text-fg-muted">{describeMemberCount(summary)}</span>
            <Button variant="outline" asChild>
              <a href={ROLES_ROUTE}>
                <Shield aria-hidden />
                Roles
              </a>
            </Button>
            {capabilities.canInvite && (
              <Button
                kbd={canInviteNow ? 'N' : undefined}
                data-testid="members-invite"
                disabled={atCapacity}
                aria-disabled={atCapacity}
                title={atCapacity ? SEATS_EXHAUSTED_TITLE : undefined}
                onClick={() => setOverlay('invite')}
              >
                <UserPlus aria-hidden />
                Invite member
              </Button>
            )}
          </>
        }
      />

      <PageBody>
        {error && (
          <Alert
            variant="error"
            data-testid="members-error"
            onClose={() => setError('')}
            actions={
              <Button variant="outline" size="sm" onClick={() => void loadData()}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        <MemberSeatsCard seats={seats} plan={plan} />

        <MembersTable
          members={members}
          roles={roles}
          capabilities={capabilities}
          viewerId={viewerId}
          loading={loading}
          error={loadError}
          busyMemberId={busyMemberId}
          onRetry={() => void loadData()}
          onOpenMember={(member) => setOpenMemberId(member.user_id)}
          onChangeRole={(member, roleId) => void handleChangeRole(member, roleId)}
          onToggleStatus={(member) => openOverlayFor('suspend', member.user_id)}
          onOffboard={(member) => openOverlayFor('offboard', member.user_id)}
          onResendInvite={(member) => void handleResendInvite(member)}
          onInvite={() => setOverlay('invite')}
          canInviteNow={canInviteNow}
        />

        <IdentityProviderCards />
      </PageBody>

      <MemberDetailDrawer
        member={openMember}
        onOpenChange={(open) => {
          if (!open) setOpenMemberId(null);
        }}
        roles={roles}
        capabilities={capabilities}
        viewerId={viewerId}
        auditRows={auditRows}
        auditLoading={auditLoading}
        auditError={auditError}
        busy={busyMemberId !== null}
        onChangeRole={(member, roleId) => void handleChangeRole(member, roleId)}
        onToggleStatus={(member) => openOverlayFor('suspend', member.user_id)}
        onOffboard={(member) => openOverlayFor('offboard', member.user_id)}
        onResendInvite={(member) => void handleResendInvite(member)}
        rolesHref={ROLES_ROUTE}
        auditHref={AUDIT_ROUTE}
      />

      <InviteMemberDialog
        open={overlay === 'invite'}
        onOpenChange={(open) => !open && closeOverlay()}
        roles={roles}
        seats={seats}
        atCapacity={atCapacity}
        onSubmit={handleInvite}
      />

      <SuspendMemberDialog
        open={overlay === 'suspend'}
        onOpenChange={(open) => !open && closeOverlay()}
        member={overlayMember}
        tenantName="this workspace"
        onConfirm={handleToggleStatus}
      />

      <OffboardMemberDialog
        open={overlay === 'offboard'}
        onOpenChange={(open) => !open && closeOverlay()}
        member={overlayMember}
        members={members}
        tenantName="this workspace"
        onConfirm={handleOffboard}
      />
    </Page>
  );
}
