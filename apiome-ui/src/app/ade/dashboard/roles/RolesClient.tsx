'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Grid3x3,
  Plus,
  Copy,
  Save,
  Trash2,
  Info,
  AlertCircle,
  RefreshCw,
  Check,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Permission-matrix vocabulary (must match the REST guard exactly)
// ---------------------------------------------------------------------------
const RESOURCES: { key: string; label: string }[] = [
  { key: 'projects', label: 'Projects' },
  { key: 'versions', label: 'Versions' },
  { key: 'classes', label: 'Classes' },
  { key: 'properties', label: 'Properties' },
  { key: 'paths', label: 'Paths' },
  { key: 'types', label: 'Primitives / Types' },
  { key: 'imports', label: 'Imports' },
  { key: 'members', label: 'Members' },
  { key: 'api_keys', label: 'API Keys' },
  { key: 'billing', label: 'Billing' },
  { key: 'lint_findings', label: 'Lint Findings' },
  { key: 'verification_targets', label: 'Verification Targets' },
];

const ACTIONS: { key: string; label: string }[] = [
  { key: 'view', label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
  { key: 'publish', label: 'Publish' },
];

interface PermissionCell {
  resource: string;
  action: string;
}

interface Role {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_builtin: boolean;
  member_count: number;
  permissions: PermissionCell[];
}

interface MyPermissions {
  is_admin: boolean;
  permissions: string[];
}

async function accessApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/access/${path}`, init);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Request failed');
  return json.data as T;
}

function cellKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

export default function RolesClient() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<MyPermissions | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Local editable state for the selected role
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftGrid, setDraftGrid] = useState<Set<string>>(new Set());

  const canMutate = useMemo(() => {
    if (!perms) return false;
    if (perms.is_admin) return true;
    return (
      perms.permissions.includes('members:edit') ||
      perms.permissions.includes('members:create') ||
      perms.permissions.includes('members:delete')
    );
  }, [perms]);

  const canCreate = !!perms && (perms.is_admin || perms.permissions.includes('members:create'));
  const canDelete = !!perms && (perms.is_admin || perms.permissions.includes('members:delete'));

  const selectedRole = roles.find((r) => r.id === selectedId) || null;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rolesData, permsData] = await Promise.all([
        accessApi<Role[]>('roles'),
        accessApi<MyPermissions>('permissions/me'),
      ]);
      const list = rolesData || [];
      // Built-in roles first, then custom, preserving order within each group.
      const sorted = [...list].sort((a, b) => {
        if (a.is_builtin === b.is_builtin) return 0;
        return a.is_builtin ? -1 : 1;
      });
      setRoles(sorted);
      setPerms(permsData);
      setSelectedId((prev) => {
        if (prev && sorted.some((r) => r.id === prev)) return prev;
        return sorted.length > 0 ? sorted[0].id : null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Sync the draft state whenever the selected role changes.
  useEffect(() => {
    if (!selectedRole) {
      setDraftName('');
      setDraftDescription('');
      setDraftGrid(new Set());
      return;
    }
    setDraftName(selectedRole.name);
    setDraftDescription(selectedRole.description || '');
    setDraftGrid(new Set(selectedRole.permissions.map((p) => cellKey(p.resource, p.action))));
  }, [selectedId, selectedRole]);

  const toggleCell = (resource: string, action: string) => {
    if (!canMutate) return;
    setDraftGrid((prev) => {
      const next = new Set(prev);
      const key = cellKey(resource, action);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const gridToPermissions = (): PermissionCell[] => {
    const cells: PermissionCell[] = [];
    for (const r of RESOURCES) {
      for (const a of ACTIONS) {
        if (draftGrid.has(cellKey(r.key, a.key))) {
          cells.push({ resource: r.key, action: a.key });
        }
      }
    }
    return cells;
  };

  const handleNewRole = async () => {
    const name = window.prompt('Name for the new role');
    if (!name || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const role = await accessApi<Role>('roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: '', permissions: [] }),
      });
      await loadData();
      if (role) setSelectedId(role.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create role');
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!selectedRole) return;
    const name = window.prompt('Name for the duplicated role', `${selectedRole.name} (copy)`);
    if (!name || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const role = await accessApi<Role>(`roles/${selectedRole.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadData();
      if (role) setSelectedId(role.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to duplicate role');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (!selectedRole) return;
    setSaving(true);
    setError('');
    try {
      await accessApi<Role>(`roles/${selectedRole.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draftName.trim(),
          description: draftDescription,
          permissions: gridToPermissions(),
        }),
      });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedRole || selectedRole.is_builtin) return;
    if (!window.confirm(`Delete the role "${selectedRole.name}"? This cannot be undone.`)) return;
    setSaving(true);
    setError('');
    try {
      await accessApi(`roles/${selectedRole.id}`, { method: 'DELETE' });
      setSelectedId(null);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete role');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center">
              <Grid3x3 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Roles &amp; Permissions</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">Tenant access control</p>
            </div>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={handleNewRole}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors shrink-0 disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              New role
            </button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950">
        {error && (
          <div className="mb-6 p-4 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
          </div>
        ) : roles.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
            <Grid3x3 className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500 dark:text-gray-400 text-sm">No roles defined yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-8">
            {/* Role list */}
            <aside className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Roles</h3>
              {roles.map((role) => {
                const active = role.id === selectedId;
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => setSelectedId(role.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                      active
                        ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-900/20'
                        : 'border-slate-200 hover:border-indigo-300 dark:border-slate-800 dark:hover:border-indigo-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">{role.name}</span>
                      <span className="text-xs font-mono text-gray-400">{role.member_count}</span>
                    </div>
                    <span
                      className={`mt-1 inline-block text-[11px] ${
                        role.is_builtin
                          ? 'text-gray-500 dark:text-gray-400'
                          : 'text-indigo-600 dark:text-indigo-400'
                      }`}
                    >
                      {role.is_builtin ? 'Built-in' : 'Custom'}
                    </span>
                  </button>
                );
              })}
            </aside>

            {/* Permission matrix editor */}
            <section>
              {selectedRole ? (
                <>
                  <div className="flex items-start justify-between gap-4 mb-5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {selectedRole.is_builtin ? (
                          <h3 className="text-xl font-bold text-gray-900 dark:text-white">{draftName}</h3>
                        ) : (
                          <input
                            aria-label="Role name"
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            disabled={!canMutate}
                            className="text-xl font-bold text-gray-900 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none dark:hover:border-slate-700"
                          />
                        )}
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full ${
                            selectedRole.is_builtin
                              ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                              : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                          }`}
                        >
                          {selectedRole.is_builtin ? 'Built-in' : 'Custom'}
                        </span>
                      </div>
                      <textarea
                        aria-label="Role description"
                        value={draftDescription}
                        onChange={(e) => setDraftDescription(e.target.value)}
                        disabled={!canMutate}
                        rows={2}
                        placeholder="Describe what this role can do…"
                        className="mt-2 w-full text-sm text-gray-600 dark:text-gray-300 bg-transparent rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                      />
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {canMutate && (
                        <button
                          type="button"
                          onClick={handleDuplicate}
                          disabled={saving}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-gray-700 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          Duplicate
                        </button>
                      )}
                      {canMutate && (
                        <button
                          type="button"
                          onClick={handleSave}
                          disabled={saving}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium disabled:opacity-50"
                        >
                          <Save className="w-3.5 h-3.5" />
                          Save changes
                        </button>
                      )}
                      {canDelete && !selectedRole.is_builtin && (
                        <button
                          type="button"
                          onClick={handleDelete}
                          disabled={saving}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 disabled:opacity-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Delete
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-[11px] uppercase tracking-wider text-gray-400">
                          <th className="px-4 py-3 font-semibold">Resource</th>
                          {ACTIONS.map((a) => (
                            <th key={a.key} className="px-3 py-3 font-semibold text-center">
                              {a.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {RESOURCES.map((r) => (
                          <tr key={r.key}>
                            <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{r.label}</td>
                            {ACTIONS.map((a) => {
                              const on = draftGrid.has(cellKey(r.key, a.key));
                              return (
                                <td key={a.key} className="px-3 py-2.5 text-center">
                                  <button
                                    type="button"
                                    aria-label={`${r.label} ${a.label}`}
                                    aria-pressed={on}
                                    onClick={() => toggleCell(r.key, a.key)}
                                    disabled={!canMutate}
                                    className={`w-6 h-6 rounded-md border flex items-center justify-center mx-auto transition-colors ${
                                      on
                                        ? 'bg-emerald-500 border-emerald-500 text-white'
                                        : 'border-slate-300 dark:border-slate-600 text-transparent'
                                    } ${canMutate ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}
                                  >
                                    <Check className="w-3 h-3" strokeWidth={3} />
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <p className="text-[11px] text-gray-400 mt-3 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" />
                    Cells map to a central permission guard (e.g.{' '}
                    <code className="font-mono">version:publish</code>) checked on every REST route,
                    replacing scattered <code className="font-mono">is_user_tenant_admin</code> checks.
                  </p>
                </>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
                  <p className="text-gray-500 dark:text-gray-400 text-sm">Select a role to edit its permissions.</p>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}
