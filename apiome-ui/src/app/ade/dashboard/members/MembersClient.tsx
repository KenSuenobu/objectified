'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Users,
  UserPlus,
  Shield,
  Power,
  RotateCcw,
  Trash2,
  AlertCircle,
  RefreshCw,
  KeySquare,
  KeyRound,
} from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { Meter } from '@/app/components/ui/metrics';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { destructiveConfirm } from '@/app/components/dialogs/destructiveConfirm';
import { fetchTenantLicense, type TenantLicenseSeats } from '../tenants/licenseApi';
import { describeLicenseError, LICENSE_SEATS_EXHAUSTED_CODE } from '../tenants/licenseErrors';
import {
  formatSeatUsage,
  seatMeterAppearance,
  seatsExhausted,
  seatsUnlimited,
} from '../tenants/licenseSeats';

interface Member {
  user_id: string;
  name: string;
  email: string;
  status: 'active' | 'pending' | 'suspended';
  member_since: string;
  role_id: string;
  role_name: string;
  role_slug: string;
  is_admin: boolean;
}

interface Role {
  id: string;
  slug: string;
  name: string;
  is_builtin: boolean;
}

interface MyPermissions {
  is_admin: boolean;
  permissions: string[];
}

async function accessApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/access/${path}`, init);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!json.success) {
    const message = json.error || 'Request failed';
    // The access proxy surfaces a stable machine code (e.g. the OLO-5.3
    // `license-seats-exhausted` 403) as a top-level `code`. Keep it in the
    // thrown message — mirroring licenseApi.readProxyJson — so callers can run
    // the error through `describeLicenseError` for friendly upgrade guidance.
    const code = typeof json.code === 'string' ? json.code : undefined;
    throw new Error(code ? `${message} [${code}]` : message);
  }
  return json.data as T;
}

const STATUS_BADGE: Record<Member['status'], string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  suspended: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};

export default function MembersClient() {
  const { confirm } = useDialog();
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<MyPermissions | null>(null);
  const [seats, setSeats] = useState<TenantLicenseSeats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState('');

  const canInvite = !!perms && (perms.is_admin || perms.permissions.includes('members:create'));
  const canEdit = !!perms && (perms.is_admin || perms.permissions.includes('members:edit'));
  const canDelete = !!perms && (perms.is_admin || perms.permissions.includes('members:delete'));

  const pendingCount = useMemo(() => members.filter((m) => m.status === 'pending').length, [members]);
  // At-capacity is surfaced proactively so the OLO-5.3 invite 403 never comes as
  // a surprise; unlimited (Sponsor) plans are never at capacity.
  const atCapacity = !!seats && seatsExhausted(seats);
  const seatMeter = seats ? seatMeterAppearance(seats.used, seats.max) : null;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [membersData, rolesData, permsData, licenseData] = await Promise.all([
        accessApi<Member[]>('members'),
        accessApi<Role[]>('roles'),
        accessApi<MyPermissions>('permissions/me'),
        // Seat usage is best-effort context for the invite control: a license
        // read failure must not blank the member roster, so swallow it to null.
        fetchTenantLicense().catch(() => null),
      ]);
      setMembers(membersData || []);
      setRoles(rolesData || []);
      setPerms(permsData);
      setSeats(licenseData?.seats ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleInvite = async (event: FormEvent) => {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email) {
      setError('Please enter an email address');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await accessApi('members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, ...(inviteRoleId ? { role_id: inviteRoleId } : {}) }),
      });
      setInviteEmail('');
      setInviteRoleId('');
      await loadData();
    } catch (e) {
      // Render the OLO-5.3 seats-exhausted 403 as friendly upgrade guidance
      // rather than the raw API error; fall back to the message otherwise.
      const friendly = describeLicenseError(e);
      setError(friendly ?? (e instanceof Error ? e.message : 'Failed to invite member'));
    } finally {
      setBusy(false);
    }
  };

  const handleChangeRole = async (member: Member, roleId: string) => {
    if (roleId === member.role_id) return;
    setBusy(true);
    setError('');
    try {
      await accessApi(`members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: roleId }),
      });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change role');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleStatus = async (member: Member) => {
    const nextStatus = member.status === 'suspended' ? 'active' : 'suspended';
    setBusy(true);
    setError('');
    try {
      await accessApi(`members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update status');
    } finally {
      setBusy(false);
    }
  };

  const handleOffboard = async (member: Member) => {
    const confirmed = await confirm(
      destructiveConfirm({
        action: 'Offboard',
        name: member.name || member.email,
        consequence:
          'They lose all access to this tenant immediately and their seat is returned to the licence. Their account and the work they authored are kept.',
        confirmLabel: 'Offboard member',
      })
    );
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await accessApi(`members/${member.user_id}`, { method: 'DELETE' });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to offboard member');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-6 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Users className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Members &amp; Identity</h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
              {members.length} {members.length === 1 ? 'member' : 'members'}
              {pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
            </p>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950">
        <div className="space-y-8">
          {error && (
            <div
              data-testid="members-error"
              className="p-4 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300 flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* Seat usage — surfaced proactively (OLO-6.3) so the OLO-5.3 invite
              403 is anticipated, not a surprise. Best-effort: hidden when the
              license read failed. */}
          {seats && (
            <div
              data-testid="member-seat-usage"
              className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                  <Users className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  Member seats
                </p>
                <p className={`text-sm font-semibold ${seatMeter?.countClass ?? ''}`}>
                  {formatSeatUsage(seats)}
                </p>
              </div>
              {seatsUnlimited(seats) ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  This plan includes unlimited member seats.
                </p>
              ) : (
                seatMeter && (
                  <Meter
                    label="Member seats used"
                    value={seats.used}
                    max={seats.max}
                    valueText={formatSeatUsage(seats)}
                    showValue={false}
                  />
                )
              )}
              {atCapacity && (
                <div className="mt-3">
                  <Alert variant="warning">
                    {describeLicenseError({ code: LICENSE_SEATS_EXHAUSTED_CODE })}
                  </Alert>
                </div>
              )}
            </div>
          )}

          {/* Invite control */}
          {canInvite && (
            <form
              onSubmit={handleInvite}
              data-testid="members-invite-form"
              className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 flex flex-col sm:flex-row gap-3 sm:items-end"
            >
              <div className="flex-1">
                <label htmlFor="inviteEmail" className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Email address
                </label>
                <input
                  id="inviteEmail"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="person@example.com"
                  disabled={busy || atCapacity}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                />
              </div>
              <div className="sm:w-56">
                <label htmlFor="inviteRole" className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Role
                </label>
                <select
                  id="inviteRole"
                  value={inviteRoleId}
                  onChange={(e) => setInviteRoleId(e.target.value)}
                  disabled={busy || atCapacity}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  <option value="">Default role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={busy || atCapacity}
                aria-disabled={busy || atCapacity}
                title={atCapacity ? 'All member seats are in use — upgrade the plan to add more.' : undefined}
                className="flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <UserPlus className="w-4 h-4" />
                Invite member
              </button>
            </form>
          )}

          {/* Members table */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
              {members.length === 0 ? (
                <div className="p-12 text-center">
                  <Users className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-500 dark:text-gray-400 text-sm">No members yet.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/80">
                      <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        <th className="px-6 py-3">User</th>
                        <th className="px-3 py-3">Role</th>
                        <th className="px-3 py-3">Status</th>
                        <th className="px-3 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {members.map((member) => (
                        <tr
                          key={member.user_id}
                          data-testid="member-row"
                          data-member-email={member.email}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          <td className="px-6 py-4">
                            <div className="font-medium text-gray-900 dark:text-white">{member.name || member.email}</div>
                            <div className="text-xs text-gray-400 font-mono">{member.email}</div>
                          </td>
                          <td className="px-3 py-4">
                            {canEdit ? (
                              <select
                                aria-label={`Role for ${member.name || member.email}`}
                                value={member.role_id}
                                onChange={(e) => handleChangeRole(member, e.target.value)}
                                disabled={busy}
                                className="px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              >
                                {roles.map((role) => (
                                  <option key={role.id} value={role.id}>
                                    {role.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                                {member.role_name}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-4">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_BADGE[member.status]}`}
                              >
                                {member.status}
                              </span>
                              {member.is_admin && (
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                                  <Shield className="w-3 h-3" />
                                  Admin
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-4 text-right">
                            <div className="flex justify-end gap-1">
                              {canEdit && (
                                <button
                                  type="button"
                                  onClick={() => handleToggleStatus(member)}
                                  disabled={busy}
                                  title={member.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                                  className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
                                >
                                  {member.status === 'suspended' ? (
                                    <RotateCcw className="w-4 h-4" />
                                  ) : (
                                    <Power className="w-4 h-4" />
                                  )}
                                </button>
                              )}
                              {canDelete && (
                                <button
                                  type="button"
                                  onClick={() => handleOffboard(member)}
                                  disabled={busy}
                                  title="Offboard"
                                  className="p-2 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-900/20 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* SSO / SCIM — Coming soon (disabled, non-functional) */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 opacity-70">
              <div className="flex items-center gap-2 mb-3">
                <KeySquare className="w-4 h-4 text-amber-500" />
                <h3 className="font-semibold text-gray-900 dark:text-white">Single Sign-On (OIDC/SAML)</h3>
                <span className="ml-auto text-2xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  Coming soon
                </span>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Enforce sign-in through your identity provider and map IdP groups to Apiome roles.
              </p>
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="mt-4 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-gray-400 cursor-not-allowed"
              >
                Configure SSO
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 opacity-70">
              <div className="flex items-center gap-2 mb-3">
                <KeyRound className="w-4 h-4 text-indigo-500" />
                <h3 className="font-semibold text-gray-900 dark:text-white">SCIM 2.0 provisioning</h3>
                <span className="ml-auto text-2xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  Coming soon
                </span>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Automatically create, update, and deactivate members from your identity provider.
              </p>
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="mt-4 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-gray-400 cursor-not-allowed"
              >
                Enable SCIM
              </button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
