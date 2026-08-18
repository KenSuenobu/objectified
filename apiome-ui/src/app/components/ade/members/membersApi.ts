/**
 * The members screen's calls into the access proxy — HIVE-5.2 (#5305).
 *
 * `/api/access/*` forwards to apiome-rest `/v1/access/{tenantSlug}/*`, resolving the tenant
 * from the session server-side, and answers in a `{success, data | error, code?}` envelope.
 * The screen this replaced unwrapped that envelope with a `fetch` written inline in the
 * component, which meant the one thing the envelope carries that matters — the stable
 * machine `code` on a licence refusal — was preserved by a comment rather than by a type.
 *
 * The unwrapping itself now lives in {@link ../access/accessApi}, shared with the Roles
 * screen (HIVE-5.3, #5306), together with the two reads both screens make. What is left here
 * is what is genuinely the members surface's: one read of the roster and the five writes
 * against it, each a named function whose return type is the record
 * {@link ./membersModel} works in.
 */

import { accessApi, JSON_HEADERS } from '../access/accessApi';
import type { AccessAuditRecord, MemberRecord, MemberStatus } from './membersModel';

// The roles list and the viewer's own grants are read by both access screens, so they are
// declared once in the shared module and re-exported here — every members call site imports
// them from the barrel, and which module they are declared in is not its concern.
export { fetchRoles, fetchMyPermissions } from '../access/accessApi';

/**
 * Read the tenant's members.
 *
 * @returns Every member, ordered by display name as the API returns them.
 */
export async function fetchMembers(): Promise<MemberRecord[]> {
  return (await accessApi<MemberRecord[]>('members')) ?? [];
}

/**
 * Read the tenant's access ledger.
 *
 * Fetched only when the detail drawer opens: it is the drawer's "recent activity" section and
 * nothing on the list needs it, so the page's first paint should not wait for it.
 *
 * Unfiltered rather than `?filter=member`, because the rows that concern one person are not
 * only the `member.*` ones — a role assigned to them is written as `role.assigned` with their
 * id as the target. {@link ./membersModel.memberActivity} does the narrowing, by subject
 * rather than by action prefix.
 *
 * @param limit How many rows to read, newest first.
 * @returns The ledger rows.
 */
export async function fetchAccessAudit(limit = 200): Promise<AccessAuditRecord[]> {
  return (
    (await accessApi<AccessAuditRecord[]>(`audit?filter=all&limit=${encodeURIComponent(limit)}`)) ??
    []
  );
}

/**
 * Invite an account into the tenant, optionally with a role.
 *
 * @param input.email The address as typed; the API canonicalises it.
 * @param input.roleId The role to assign, or empty for the tenant's default.
 */
export async function inviteMember(input: { email: string; roleId?: string }): Promise<void> {
  await accessApi('members', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      email: input.email,
      ...(input.roleId ? { role_id: input.roleId } : {}),
    }),
  });
}

/**
 * Assign a member's role.
 *
 * @param userId The member.
 * @param roleId The role to assign.
 */
export async function assignMemberRole(userId: string, roleId: string): Promise<void> {
  await accessApi(`members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ role_id: roleId }),
  });
}

/**
 * Move a member through the lifecycle — suspend, or reinstate.
 *
 * Reinstating consumes a licence seat, so this is one of the calls that can come back with
 * the `license-seats-exhausted` code.
 *
 * @param userId The member.
 * @param status The status to move them to.
 */
export async function setMemberStatus(userId: string, status: MemberStatus): Promise<void> {
  await accessApi(`members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ status }),
  });
}

/**
 * Re-issue an outstanding invitation (HIVE-5.2).
 *
 * Apiome does not mail invitations — the invitee already holds an account and their pending
 * membership activates on their next sign-in — so this renews the invitation and records the
 * renewal in the access ledger rather than sending anything. See the endpoint's own docstring
 * in `apiome-rest/src/app/access_routes.py`.
 *
 * @param userId The invited member.
 */
export async function resendMemberInvite(userId: string): Promise<void> {
  await accessApi(`members/${encodeURIComponent(userId)}/resend-invite`, { method: 'POST' });
}

/**
 * Offboard a member, or cancel an outstanding invitation.
 *
 * Both are the same call: an invitation is a membership row, so cancelling one is removing
 * it. The dialogs differ in what they say, not in what they do.
 *
 * @param userId The member.
 */
export async function offboardMember(userId: string): Promise<void> {
  await accessApi(`members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}
