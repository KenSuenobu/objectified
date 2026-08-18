/**
 * The members screen's calls into the access proxy — HIVE-5.2 (#5305).
 *
 * `/api/access/*` forwards to apiome-rest `/v1/access/{tenantSlug}/*`, resolving the tenant
 * from the session server-side, and answers in a `{success, data | error, code?}` envelope.
 * The screen this replaces unwrapped that envelope with a `fetch` written inline in the
 * component, which meant the one thing the envelope carries that matters — the stable
 * machine `code` on a licence refusal — was preserved by a comment rather than by a type.
 *
 * Here the unwrapping happens once, the code is kept in the thrown message the way
 * {@link ../../../ade/dashboard/tenants/licenseApi} keeps it (so `describeLicenseError` can
 * still recognise it), and each endpoint is a named function whose return type is the record
 * {@link ./membersModel} works in.
 */

import type {
  AccessAuditRecord,
  MemberRecord,
  MemberStatus,
  MyPermissions,
  RoleRecord,
} from './membersModel';

/**
 * Call the access proxy and unwrap its envelope.
 *
 * @param path The path under `/api/access/`, already encoded.
 * @param init Fetch options; a JSON body must be stringified by the caller.
 * @returns The `data` payload, or `null` for a 204.
 * @throws Error whose message ends in `[code]` when the proxy reported a stable machine code
 *   (e.g. the OLO-5.3 `license-seats-exhausted` 403), so callers can run it through
 *   `describeLicenseError` for friendly upgrade guidance.
 */
async function accessApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/access/${path}`, init);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!json.success) {
    const message = json.error || 'Request failed';
    const code = typeof json.code === 'string' ? json.code : undefined;
    throw new Error(code ? `${message} [${code}]` : message);
  }
  return json.data as T;
}

/** JSON request headers, stated once rather than at each of the four write call sites. */
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * Read the tenant's members.
 *
 * @returns Every member, ordered by display name as the API returns them.
 */
export async function fetchMembers(): Promise<MemberRecord[]> {
  return (await accessApi<MemberRecord[]>('members')) ?? [];
}

/**
 * Read the tenant's roles, with the permission grid each one grants.
 *
 * @returns Every role, built-in first.
 */
export async function fetchRoles(): Promise<RoleRecord[]> {
  return (await accessApi<RoleRecord[]>('roles')) ?? [];
}

/**
 * Read the viewer's own effective permissions, which drive the screen's gates.
 *
 * @returns The `permissions/me` payload.
 */
export async function fetchMyPermissions(): Promise<MyPermissions | null> {
  return accessApi<MyPermissions>('permissions/me');
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
