'use client';

/**
 * Governance → Evidence-backed verification policy — ECA-3.1 (#4734)
 *
 * Tenant-level publish/deploy gate over ECA-1.3 evidence and CTG-3.1 whole-spec breaking
 * severity. Lives beside the import/export quality policy. The UI only edits and displays
 * what the REST API returns — it never re-scores evidence.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RefreshCw, Shield } from 'lucide-react';
import {
  isVerificationPolicyBlocking,
  verificationPolicyApi,
  type VerificationPolicy,
  type VerificationPolicyVersionList,
} from './verification-policy-api';

const inputClasses =
  'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 ' +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-white';

interface PolicyDraft {
  requiredSuiteDigests: string;
  maxEvidenceAgeSeconds: string;
  requiredTargetNetworkClass: '' | 'public' | 'private';
  purpose: 'publish' | 'deploy' | 'both';
  breakingChangeAction: 'ignore' | 'warn' | 'block';
  enforcement: 'advisory' | 'block';
}

function toDraft(policy: VerificationPolicy): PolicyDraft {
  return {
    requiredSuiteDigests: (policy.requiredSuiteDigests ?? []).join('\n'),
    maxEvidenceAgeSeconds:
      policy.maxEvidenceAgeSeconds != null ? String(policy.maxEvidenceAgeSeconds) : '',
    requiredTargetNetworkClass: policy.requiredTargetNetworkClass ?? '',
    purpose: policy.purpose,
    breakingChangeAction: policy.breakingChangeAction,
    enforcement: policy.enforcement,
  };
}

function parseDigests(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

function formatInstant(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export default function VerificationPolicyPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [policy, setPolicy] = useState<VerificationPolicy | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [versions, setVersions] = useState<VerificationPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [current, history] = await Promise.all([
        verificationPolicyApi<VerificationPolicy>(''),
        verificationPolicyApi<VerificationPolicyVersionList>('versions'),
      ]);
      if (current) {
        setPolicy(current);
        setDraft(toDraft(current));
      }
      setVersions(history?.versions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load verification policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    policy && draft
      ? JSON.stringify(draft) !== JSON.stringify(toDraft(policy))
      : false;

  const handleSave = async () => {
    if (!draft || readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const maxAgeRaw = draft.maxEvidenceAgeSeconds.trim();
      const body: Record<string, unknown> = {
        requiredSuiteDigests: parseDigests(draft.requiredSuiteDigests),
        purpose: draft.purpose,
        breakingChangeAction: draft.breakingChangeAction,
        enforcement: draft.enforcement,
      };
      if (maxAgeRaw === '') {
        body.clearMaxEvidenceAgeSeconds = true;
      } else {
        body.maxEvidenceAgeSeconds = Number(maxAgeRaw);
      }
      if (draft.requiredTargetNetworkClass === '') {
        body.clearRequiredTargetNetworkClass = true;
      } else {
        body.requiredTargetNetworkClass = draft.requiredTargetNetworkClass;
      }
      const saved = await verificationPolicyApi<VerificationPolicy>('', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (saved) {
        setPolicy(saved);
        setDraft(toDraft(saved));
      }
      const history = await verificationPolicyApi<VerificationPolicyVersionList>('versions');
      setVersions(history?.versions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save verification policy');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <Shield className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden />
            Verification publish &amp; deploy policy
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Require recent passing contract evidence (suite digests) and set whole-spec breaking
            posture before publish or deploy. Decisions cite exact evidence run IDs. Consumer-aware
            breaking acknowledgment lands with #4479.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-gray-300 dark:hover:bg-slate-900"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {loading && !draft ? (
        <p className="mt-4 text-sm text-gray-500">Loading policy…</p>
      ) : draft && policy ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {policy.isDefault ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                Default (advisory)
              </span>
            ) : (
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200">
                v{policy.versionNumber}
              </span>
            )}
            {isVerificationPolicyBlocking(policy) ? (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-950 dark:text-rose-200">
                Blocking
              </span>
            ) : (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                Advisory
              </span>
            )}
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
              Required suite digests (one per line)
            </span>
            <textarea
              className={`${inputClasses} w-full font-mono`}
              rows={3}
              disabled={readOnly || saving}
              value={draft.requiredSuiteDigests}
              onChange={(e) => setDraft({ ...draft, requiredSuiteDigests: e.target.value })}
              placeholder="sha256:…"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Max evidence age (seconds)
              </span>
              <input
                type="number"
                min={1}
                className={`${inputClasses} w-full`}
                disabled={readOnly || saving}
                value={draft.maxEvidenceAgeSeconds}
                onChange={(e) => setDraft({ ...draft, maxEvidenceAgeSeconds: e.target.value })}
                placeholder="No limit"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Required target network class
              </span>
              <select
                className={`${inputClasses} w-full`}
                disabled={readOnly || saving}
                value={draft.requiredTargetNetworkClass}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    requiredTargetNetworkClass: e.target.value as PolicyDraft['requiredTargetNetworkClass'],
                  })
                }
              >
                <option value="">Any</option>
                <option value="public">public</option>
                <option value="private">private</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Purpose</span>
              <select
                className={`${inputClasses} w-full`}
                disabled={readOnly || saving}
                value={draft.purpose}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    purpose: e.target.value as PolicyDraft['purpose'],
                  })
                }
              >
                <option value="both">both</option>
                <option value="publish">publish</option>
                <option value="deploy">deploy</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Breaking-change action (whole-spec)
              </span>
              <select
                className={`${inputClasses} w-full`}
                disabled={readOnly || saving}
                value={draft.breakingChangeAction}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    breakingChangeAction: e.target.value as PolicyDraft['breakingChangeAction'],
                  })
                }
              >
                <option value="ignore">ignore</option>
                <option value="warn">warn</option>
                <option value="block">block</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Enforcement
              </span>
              <select
                className={`${inputClasses} w-full`}
                disabled={readOnly || saving}
                value={draft.enforcement}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    enforcement: e.target.value as PolicyDraft['enforcement'],
                  })
                }
              >
                <option value="advisory">advisory</option>
                <option value="block">block</option>
              </select>
            </label>
          </div>

          {!readOnly && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!dirty || saving}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save new version'}
              </button>
            </div>
          )}

          {versions.length > 0 && (
            <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Version history
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-300">
                {versions.slice(0, 8).map((v) => (
                  <li key={v.policyVersionId ?? v.versionNumber} className="flex justify-between gap-2">
                    <span>
                      v{v.versionNumber} · {v.enforcement} · {v.breakingChangeAction}
                    </span>
                    <span className="text-xs text-gray-400">{formatInstant(v.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
