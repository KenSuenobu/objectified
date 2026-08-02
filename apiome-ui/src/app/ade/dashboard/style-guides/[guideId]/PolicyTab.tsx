'use client';

/**
 * Guide editor — policy tab (CLX-1.3, #4850)
 *
 * Edits draft policy gates on a custom style guide: quality axis min grade, required coverage,
 * and CI outcome toggles. Saving PUTs settings and snapshots an immutable policy pack version.
 * Historical versions are listed read-only below the form.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Switch } from '@/app/components/ui/Switch';
import {
  buildGovernanceDocsHref,
  POLICY_DOCS_PAGE,
} from '@/app/utils/lint-axis-ui';
import {
  BREAKING_PUBLISH_POLICY_OPTIONS,
  DEFAULT_BREAKING_PUBLISH_POLICY,
  DEFAULT_GUIDE_CI_OUTCOMES,
  POLICY_COVERAGE_AXES,
  POLICY_GRADE_OPTIONS,
  styleGuidesApi,
  truncatePolicyFingerprint,
  type BreakingPublishPolicyLevel,
  type GuideCiOutcomes,
  type GuidePolicySettings,
  type GuidePolicyVersion,
  type GuidePolicyVersionList,
} from '../api';

const inputClasses =
  'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white';

interface PolicyDraft {
  axisGates: GuidePolicySettings['axisGates'];
  requiredCoverage: string[];
  ciOutcomes: GuideCiOutcomes;
  breakingPublishPolicy: BreakingPublishPolicyLevel;
}

/** Normalize API policy settings into editable draft state. */
function toDraft(settings: GuidePolicySettings): PolicyDraft {
  return {
    axisGates: { ...settings.axisGates },
    requiredCoverage: [...settings.requiredCoverage],
    ciOutcomes: { ...DEFAULT_GUIDE_CI_OUTCOMES, ...settings.ciOutcomes },
    breakingPublishPolicy: settings.breakingPublishPolicy ?? DEFAULT_BREAKING_PUBLISH_POLICY,
  };
}

/** Compare two coverage lists regardless of order. */
function coverageEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/** Detect unsaved policy edits against the loaded baseline. */
function isDraftDirty(draft: PolicyDraft, baseline: PolicyDraft): boolean {
  const qualityGrade = draft.axisGates.quality?.minGrade ?? '';
  const baselineGrade = baseline.axisGates.quality?.minGrade ?? '';
  if (qualityGrade !== baselineGrade) return true;
  if (!coverageEqual(draft.requiredCoverage, baseline.requiredCoverage)) return true;
  if (draft.breakingPublishPolicy !== baseline.breakingPublishPolicy) return true;
  return (
    draft.ciOutcomes.failOnUnwaivedErrors !== baseline.ciOutcomes.failOnUnwaivedErrors ||
    draft.ciOutcomes.failOnRequiredCoverage !== baseline.ciOutcomes.failOnRequiredCoverage ||
    draft.ciOutcomes.failOnAxisGates !== baseline.ciOutcomes.failOnAxisGates
  );
}

/** Format an ISO timestamp for the version history list. */
function formatVersionDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function PolicyTab({ guideId, readOnly }: { guideId: string; readOnly: boolean }) {
  const [baseline, setBaseline] = useState<PolicyDraft | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [versions, setVersions] = useState<GuidePolicyVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Load draft policy settings and immutable version history. */
  const loadData = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [settings, versionList] = await Promise.all([
        styleGuidesApi<GuidePolicySettings>(`${guideId}/policy`),
        styleGuidesApi<GuidePolicyVersionList>(`${guideId}/policy-versions`),
      ]);
      if (settings) {
        const next = toDraft(settings);
        setBaseline(next);
        setDraft(next);
      }
      setVersions(versionList?.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load policy settings');
    } finally {
      setLoading(false);
    }
  }, [guideId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const dirty = useMemo(
    () => (draft && baseline ? isDraftDirty(draft, baseline) : false),
    [draft, baseline],
  );

  const qualityMinGrade = draft?.axisGates.quality?.minGrade ?? '';

  const setQualityMinGrade = (minGrade: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const axisGates = { ...prev.axisGates };
      if (minGrade) {
        axisGates.quality = { ...axisGates.quality, minGrade };
      } else {
        delete axisGates.quality;
      }
      return { ...prev, axisGates };
    });
  };

  const toggleCoverage = (axis: string, checked: boolean) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.requiredCoverage);
      if (checked) set.add(axis);
      else set.delete(axis);
      return { ...prev, requiredCoverage: Array.from(set) };
    });
  };

  const setBreakingPublishPolicy = (level: BreakingPublishPolicyLevel) => {
    setDraft((prev) => (prev ? { ...prev, breakingPublishPolicy: level } : prev));
  };

  const setCiOutcome = (key: keyof GuideCiOutcomes, checked: boolean) => {
    setDraft((prev) =>
      prev
        ? { ...prev, ciOutcomes: { ...prev.ciOutcomes, [key]: checked } }
        : prev,
    );
  };

  /** Persist draft settings and refresh baseline + version list from the response. */
  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const saved = await styleGuidesApi<GuidePolicySettings>(`${guideId}/policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          axisGates: draft.axisGates,
          requiredCoverage: draft.requiredCoverage,
          ciOutcomes: draft.ciOutcomes,
          breakingPublishPolicy: draft.breakingPublishPolicy,
          snapshot: true,
        }),
      });
      if (saved) {
        const next = toDraft(saved);
        setBaseline(next);
        setDraft(next);
      }
      const versionList = await styleGuidesApi<GuidePolicyVersionList>(
        `${guideId}/policy-versions`,
      );
      setVersions(versionList?.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save policy settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
        <p className="text-sm text-gray-500 dark:text-gray-400">Policy settings not found.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-12">
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/50">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Policy</h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Gate settings applied when evaluating lint evidence against this guide
          </p>
        </div>

        <div className="space-y-6 p-4">
          <div>
            <label htmlFor="quality-min-grade" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Quality minimum grade
            </label>
            <select
              id="quality-min-grade"
              aria-label="Quality minimum grade"
              value={qualityMinGrade}
              disabled={readOnly || saving}
              onChange={(e) => setQualityMinGrade(e.target.value)}
              className={`${inputClasses} min-w-32 disabled:opacity-50`}
            >
              <option value="">No floor</option>
              {POLICY_GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
              Required coverage
            </legend>
            <ul className="space-y-2">
              {POLICY_COVERAGE_AXES.map((axis) => (
                <li key={axis} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`coverage-${axis}`}
                    aria-label={`Require ${axis} coverage`}
                    checked={draft.requiredCoverage.includes(axis)}
                    disabled={readOnly || saving}
                    onChange={(e) => toggleCoverage(axis, e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                  />
                  <label htmlFor={`coverage-${axis}`} className="text-sm capitalize text-gray-900 dark:text-white">
                    {axis}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <div>
            <label
              htmlFor="breaking-publish-policy"
              className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Breaking-change publishes
            </label>
            <select
              id="breaking-publish-policy"
              aria-label="Breaking-change publish policy"
              value={draft.breakingPublishPolicy}
              disabled={readOnly || saving}
              onChange={(e) =>
                setBreakingPublishPolicy(e.target.value as BreakingPublishPolicyLevel)
              }
              className={`${inputClasses} min-w-48 disabled:opacity-50`}
            >
              {BREAKING_PUBLISH_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {BREAKING_PUBLISH_POLICY_OPTIONS.find(
                (o) => o.value === draft.breakingPublishPolicy,
              )?.description}
            </p>
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
              CI outcomes
            </legend>
            <ul className="space-y-3">
              <li className="flex items-center justify-between gap-4">
                <label htmlFor="ci-fail-unwaived" className="text-sm text-gray-900 dark:text-white">
                  Fail on unwaived errors
                </label>
                <Switch
                  id="ci-fail-unwaived"
                  aria-label="Fail on unwaived errors"
                  checked={draft.ciOutcomes.failOnUnwaivedErrors}
                  disabled={readOnly || saving}
                  onCheckedChange={(checked) => setCiOutcome('failOnUnwaivedErrors', checked)}
                />
              </li>
              <li className="flex items-center justify-between gap-4">
                <label htmlFor="ci-fail-coverage" className="text-sm text-gray-900 dark:text-white">
                  Fail on required coverage
                </label>
                <Switch
                  id="ci-fail-coverage"
                  aria-label="Fail on required coverage"
                  checked={draft.ciOutcomes.failOnRequiredCoverage}
                  disabled={readOnly || saving}
                  onCheckedChange={(checked) => setCiOutcome('failOnRequiredCoverage', checked)}
                />
              </li>
              <li className="flex items-center justify-between gap-4">
                <label htmlFor="ci-fail-axis-gates" className="text-sm text-gray-900 dark:text-white">
                  Fail on axis gates
                </label>
                <Switch
                  id="ci-fail-axis-gates"
                  aria-label="Fail on axis gates"
                  checked={draft.ciOutcomes.failOnAxisGates}
                  disabled={readOnly || saving}
                  onCheckedChange={(checked) => setCiOutcome('failOnAxisGates', checked)}
                />
              </li>
            </ul>
          </fieldset>

          {!readOnly && (
            <div className="flex justify-end border-t border-slate-100 pt-4 dark:border-slate-800">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/50">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Policy versions</h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Immutable snapshots created when policy is saved.{' '}
            <a
              href={buildGovernanceDocsHref(POLICY_DOCS_PAGE)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
              data-testid="policy-docs-link"
            >
              Policy documentation
            </a>
          </p>
        </div>
        {versions.length === 0 ? (
          <p className="p-4 text-sm text-gray-500 dark:text-gray-400">No policy versions yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <span className="font-medium text-gray-900 dark:text-white">v{v.versionNumber}</span>
                <code className="text-xs text-gray-500 dark:text-gray-400" title={v.contentFingerprint}>
                  {truncatePolicyFingerprint(v.contentFingerprint)}
                </code>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {formatVersionDate(v.createdAt)}
                </span>
                {v.actorLabel && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">{v.actorLabel}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
