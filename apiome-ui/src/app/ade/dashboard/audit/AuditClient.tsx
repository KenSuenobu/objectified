'use client';

import { useCallback, useEffect, useState } from 'react';
import { ScrollText, Download, Lock, AlertCircle, RefreshCw } from 'lucide-react';

type AuditFilter = 'all' | 'role' | 'permission' | 'member' | 'admin';

interface AuditEvent {
  id: string;
  actor_id: string;
  actor_label: string;
  action: string;
  target: string;
  source: string;
  detail: string;
  created_at: string;
}

const FILTERS: { key: AuditFilter; label: string }[] = [
  { key: 'all', label: 'All events' },
  { key: 'role', label: 'Role changes' },
  { key: 'permission', label: 'Permissions' },
  { key: 'member', label: 'Members' },
  { key: 'admin', label: 'Admin overrides' },
];

async function accessApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/access/${path}`, init);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Request failed');
  return json.data as T;
}

// Map an event action to a badge color family by its prefix.
function badgeClass(action: string): string {
  const prefix = action.split('.')[0];
  switch (prefix) {
    case 'role':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'permission':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300';
    case 'member':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
    case 'admin':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300';
    case 'sso':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    default:
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

function formatWhen(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AuditClient() {
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async (activeFilter: AuditFilter) => {
    setLoading(true);
    setError('');
    try {
      const data = await accessApi<AuditEvent[]>(`audit?filter=${activeFilter}`);
      setEvents(data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData(filter);
  }, [filter, loadData]);

  return (
    <>
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500 flex items-center justify-center">
              <ScrollText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Access Audit</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
                Immutable record of every access &amp; permission change
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              window.location.href = '/api/access/audit/export';
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 text-gray-700 dark:text-gray-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950">
        {/* Filter tabs */}
        <div className="flex flex-wrap gap-2 mb-5 text-xs">
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
                  active
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                    : 'border border-slate-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mb-5 p-4 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            {events.length === 0 ? (
              <div className="p-12 text-center">
                <ScrollText className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400 text-sm">No audit events for this filter.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 dark:border-slate-800 text-left text-2xs uppercase tracking-wider text-gray-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">When</th>
                      <th className="px-3 py-3 font-semibold">Actor</th>
                      <th className="px-3 py-3 font-semibold">Event</th>
                      <th className="px-3 py-3 font-semibold">Target</th>
                      <th className="px-3 py-3 font-semibold">Source</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {events.map((ev) => (
                      <tr key={ev.id}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {formatWhen(ev.created_at)}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-gray-700 dark:text-gray-200">
                          {ev.actor_label || ev.actor_id}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`font-mono text-xs px-2 py-0.5 rounded ${badgeClass(ev.action)}`}>
                            {ev.action}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-gray-600 dark:text-gray-300">{ev.target || ev.detail}</td>
                        <td className="px-3 py-3 text-xs text-gray-400">{ev.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <p className="text-2xs text-gray-400 mt-3 flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5" />
          Entries are append-only and hash-chained; they cannot be edited or deleted, satisfying
          SOC 2 / ISO 27001 access-review evidence.
        </p>
      </main>
    </>
  );
}
