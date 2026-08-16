'use client';

/**
 * Governance → Import & export quality policy — IXH-2.3 (#5098)
 *
 * The tenant-level gate that decides what may enter the catalog and what may leave it. It lives
 * beside the style guides because the two answer the same question at different moments: a guide
 * decides *how* a document is scored, this policy decides *what score is good enough*.
 *
 * Each scope (import / export) carries three independent floors — minimum grade, minimum score,
 * and a severity that must not appear — plus an enforcement mode: `advisory` reports a shortfall
 * without stopping anyone, `block` refuses the operation. Below that sits the override contract:
 * whether a blocked user may proceed by recording a waiver, which roles may, and how long a
 * waiver lives.
 *
 * Saving appends an immutable version (the REST layer rejects a non-admin), so the version list
 * under the form is the change history each verdict names. The active waiver ledger is shown
 * beside it, because a policy without visibility of what has been waived is not governance.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { Switch } from '@/app/components/ui/Switch';
import {
  DEFAULT_QUALITY_THRESHOLDS,
  QUALITY_GRADE_OPTIONS,
  QUALITY_SEVERITY_OPTIONS,
  isBlockingConfiguration,
  qualityPolicyApi,
  type QualityPolicy,
  type QualityPolicyVersionList,
  type QualityThresholds,
  type QualityWaiver,
  type QualityWaiverList,
} from './quality-policy-api';

const inputClasses =
  'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 ' +
  'dark:border-slate-700 dark:bg-slate-900 dark:text-white';

/** The editable policy body — everything a PUT can change. */
interface PolicyDraft {
  importPolicy: QualityThresholds;
  exportPolicy: QualityThresholds;
  allowOverride: boolean;
  overrideRoles: string;
  waiverTtlHours: number;
}

/** Role slugs a tenant can name as permitted to waive (the built-in RBAC roles). */
const ROLE_OPTIONS = ['owner', 'admin', 'editor', 'viewer'] as const;

/** Normalize the API policy into editable draft state. */
function toDraft(policy: QualityPolicy): PolicyDraft {
  return {
    importPolicy: { ...DEFAULT_QUALITY_THRESHOLDS, ...policy.import },
    exportPolicy: { ...DEFAULT_QUALITY_THRESHOLDS, ...policy.export },
    allowOverride: policy.allowOverride,
    overrideRoles: (policy.overrideRoles ?? []).join(', '),
    waiverTtlHours: policy.waiverTtlHours,
  };
}

/** Parse the comma-separated role field into the slug list the API stores. */
export function parseRoleList(value: string): string[] {
  return value
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter((role) => role.length > 0);
}

/** Detect unsaved edits against the loaded baseline. */
function isDraftDirty(draft: PolicyDraft, baseline: PolicyDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(baseline);
}

/** Format an ISO timestamp for the version and waiver lists. */
function formatInstant(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** One scope's editor: the three floors plus the enforcement mode. */
function ScopeFields({
  scope,
  thresholds,
  disabled,
  onChange,
}: {
  scope: 'import' | 'export';
  thresholds: QualityThresholds;
  disabled: boolean;
  onChange: (next: QualityThresholds) => void;
}) {
  const blocking = isBlockingConfiguration(thresholds);
  return (
    <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <legend className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {scope === 'import' ? 'Import intake' : 'Export delivery'}
        <span
          data-testid={`quality-policy-${scope}-mode`}
          className={
            blocking
              ? 'rounded-full bg-rose-100 px-2 py-0.5 text-2xs font-medium normal-case text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
              : 'rounded-full bg-slate-100 px-2 py-0.5 text-2xs font-medium normal-case text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          }
        >
          {blocking ? 'Blocking' : 'Advisory'}
        </span>
      </legend>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label
            htmlFor={`${scope}-min-grade`}
            className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            Minimum grade
          </label>
          <select
            id={`${scope}-min-grade`}
            aria-label={`${scope} minimum grade`}
            value={thresholds.minGrade ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...thresholds, minGrade: e.target.value || null })}
            className={`${inputClasses} w-full`}
          >
            <option value="">No floor</option>
            {QUALITY_GRADE_OPTIONS.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={`${scope}-min-score`}
            className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            Minimum score
          </label>
          <input
            id={`${scope}-min-score`}
            aria-label={`${scope} minimum score`}
            type="number"
            min={0}
            max={100}
            value={thresholds.minScore ?? ''}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...thresholds,
                minScore: e.target.value === '' ? null : Number(e.target.value),
              })
            }
            className={`${inputClasses} w-full`}
          />
        </div>

        <div>
          <label
            htmlFor={`${scope}-block-severity`}
            className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            Refuse findings at
          </label>
          <select
            id={`${scope}-block-severity`}
            aria-label={`${scope} blocking severity`}
            value={thresholds.blockOnSeverity ?? ''}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...thresholds,
                blockOnSeverity: (e.target.value || null) as QualityThresholds['blockOnSeverity'],
              })
            }
            className={`${inputClasses} w-full`}
          >
            <option value="">Not gated</option>
            {QUALITY_SEVERITY_OPTIONS.map((severity) => (
              <option key={severity} value={severity}>
                {severity} or worse
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <label
          htmlFor={`${scope}-enforcement`}
          className="text-sm text-gray-900 dark:text-white"
        >
          Refuse the {scope} when a floor is missed
        </label>
        <Switch
          id={`${scope}-enforcement`}
          aria-label={`Block ${scope} on policy failure`}
          checked={thresholds.enforcement === 'block'}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ ...thresholds, enforcement: checked ? 'block' : 'advisory' })
          }
        />
      </div>
    </fieldset>
  );
}

export default function QualityPolicyPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [policy, setPolicy] = useState<QualityPolicy | null>(null);
  const [baseline, setBaseline] = useState<PolicyDraft | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [versions, setVersions] = useState<QualityPolicy[]>([]);
  const [waivers, setWaivers] = useState<QualityWaiver[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Load the policy in force, its version history, and the active waiver ledger. */
  const loadData = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [current, versionList, waiverList] = await Promise.all([
        qualityPolicyApi<QualityPolicy>(''),
        qualityPolicyApi<QualityPolicyVersionList>('versions'),
        qualityPolicyApi<QualityWaiverList>('waivers'),
      ]);
      if (current) {
        setPolicy(current);
        const next = toDraft(current);
        setBaseline(next);
        setDraft(next);
      }
      setVersions(versionList?.versions ?? []);
      setWaivers(waiverList?.waivers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the quality policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const dirty = useMemo(
    () => (draft && baseline ? isDraftDirty(draft, baseline) : false),
    [draft, baseline],
  );

  /** Persist the draft as a new immutable version and refresh from the response. */
  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const saved = await qualityPolicyApi<QualityPolicy>('', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          import: draft.importPolicy,
          export: draft.exportPolicy,
          allowOverride: draft.allowOverride,
          overrideRoles: parseRoleList(draft.overrideRoles),
          waiverTtlHours: draft.waiverTtlHours,
        }),
      });
      if (saved) {
        setPolicy(saved);
        const next = toDraft(saved);
        setBaseline(next);
        setDraft(next);
      }
      const versionList = await qualityPolicyApi<QualityPolicyVersionList>('versions');
      setVersions(versionList?.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the quality policy');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="quality-policy-loading">
        <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  const disabled = readOnly || saving;

  return (
    <div className="space-y-6" data-testid="quality-policy-panel">
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/50">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
              <ShieldCheck className="h-4 w-4 text-indigo-500" aria-hidden />
              Import &amp; export quality policy
            </h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Applied when a document is imported and when an artifact is delivered. Resolution is
              per-format override → tenant → default.
            </p>
          </div>
          {policy?.isDefault ? (
            <span
              data-testid="quality-policy-default-badge"
              className="whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-2xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              Not configured — advisory
            </span>
          ) : (
            <span
              data-testid="quality-policy-version-badge"
              className="whitespace-nowrap rounded-full bg-indigo-100 px-2 py-0.5 text-2xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
            >
              v{policy?.versionNumber}
            </span>
          )}
        </div>

        {draft && (
          <div className="space-y-6 p-4">
            <ScopeFields
              scope="import"
              thresholds={draft.importPolicy}
              disabled={disabled}
              onChange={(importPolicy) => setDraft({ ...draft, importPolicy })}
            />
            <ScopeFields
              scope="export"
              thresholds={draft.exportPolicy}
              disabled={disabled}
              onChange={(exportPolicy) => setDraft({ ...draft, exportPolicy })}
            />

            <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Overrides
              </legend>
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="allow-override" className="text-sm text-gray-900 dark:text-white">
                  Allow a blocked user to proceed by recording a waiver
                </label>
                <Switch
                  id="allow-override"
                  aria-label="Allow overrides"
                  checked={draft.allowOverride}
                  disabled={disabled}
                  onCheckedChange={(checked) => setDraft({ ...draft, allowOverride: checked })}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="override-roles"
                    className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
                  >
                    Roles permitted to waive
                  </label>
                  <input
                    id="override-roles"
                    aria-label="Roles permitted to waive"
                    value={draft.overrideRoles}
                    disabled={disabled || !draft.allowOverride}
                    onChange={(e) => setDraft({ ...draft, overrideRoles: e.target.value })}
                    placeholder={ROLE_OPTIONS.join(', ')}
                    className={`${inputClasses} w-full`}
                  />
                  <p className="mt-1 text-2xs text-gray-500 dark:text-gray-400">
                    Comma-separated role slugs ({ROLE_OPTIONS.join(', ')}). Tenant administrators
                    resolve to <code>owner</code>. An empty list means nobody may waive.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="waiver-ttl"
                    className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
                  >
                    Waiver lifetime (hours)
                  </label>
                  <input
                    id="waiver-ttl"
                    aria-label="Waiver lifetime in hours"
                    type="number"
                    min={1}
                    max={8760}
                    value={draft.waiverTtlHours}
                    disabled={disabled || !draft.allowOverride}
                    onChange={(e) =>
                      setDraft({ ...draft, waiverTtlHours: Number(e.target.value) || 1 })
                    }
                    className={`${inputClasses} w-full`}
                  />
                  <p className="mt-1 text-2xs text-gray-500 dark:text-gray-400">
                    A waiver is honoured until it expires; the waiver-expiry sweep warns before it
                    lapses.
                  </p>
                </div>
              </div>
            </fieldset>

            {/* Per-format overrides are read-only here: they are a rarely-edited, deeply nested
                map, and a save carries them forward untouched. They are shown so a surprising
                verdict whose `source` is `format_override` can be traced to the rule that caused
                it. Edit them through PUT /api/quality-policy. */}
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Per-format overrides
              </h4>
              {Object.keys(policy?.formatOverrides ?? {}).length === 0 ? (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  None. Every format uses the tenant floors above.
                </p>
              ) : (
                <ul className="mt-2 space-y-1" data-testid="quality-policy-format-overrides">
                  {Object.entries(policy?.formatOverrides ?? {}).map(([format, block]) => (
                    <li key={format} className="text-xs text-gray-700 dark:text-gray-300">
                      <code className="font-medium">{format}</code>{' '}
                      <span className="text-gray-500 dark:text-gray-400">
                        {JSON.stringify(block)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-2xs text-gray-500 dark:text-gray-400">
                Resolution is format override → tenant → default; the pre-flight verdict names the
                tier that won.
              </p>
            </div>

            {!readOnly && (
              <div className="flex justify-end border-t border-slate-100 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving || !dirty}
                  data-testid="quality-policy-save"
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save policy'}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/50">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Policy versions</h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Immutable snapshots; every verdict names the version it applied.
            </p>
          </div>
          {versions.length === 0 ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
              No policy has been saved yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {versions.map((version) => (
                <li
                  key={version.policyVersionId ?? version.versionNumber}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 text-sm"
                >
                  <span className="font-medium text-gray-900 dark:text-white">
                    v{version.versionNumber}
                  </span>
                  <code
                    className="text-xs text-gray-500 dark:text-gray-400"
                    title={version.contentFingerprint}
                  >
                    {version.contentFingerprint.slice(0, 12)}…
                  </code>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatInstant(version.createdAt)}
                  </span>
                  {version.actorLabel && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {version.actorLabel}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/50">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Active waivers</h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Accepted risk with a deadline, recorded when someone proceeded against this policy.
            </p>
          </div>
          {waivers.length === 0 ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">No active waivers.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {waivers.map((waiver) => (
                <li key={waiver.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium text-gray-900 dark:text-white">
                      {waiver.subjectLabel || waiver.subjectKey.slice(0, 12)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-2xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {waiver.scope}
                      {waiver.formatKey ? ` · ${waiver.formatKey}` : ''}
                    </span>
                    {waiver.grade && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        graded {waiver.grade}
                        {typeof waiver.score === 'number' ? ` (${waiver.score})` : ''}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">{waiver.reason}</p>
                  <p className="mt-0.5 text-2xs text-gray-500 dark:text-gray-400">
                    {waiver.actorLabel ?? 'unknown actor'}
                    {waiver.actorRole ? ` (${waiver.actorRole})` : ''} · expires{' '}
                    {formatInstant(waiver.expiresAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
