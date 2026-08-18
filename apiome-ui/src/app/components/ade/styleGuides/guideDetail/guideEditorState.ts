'use client';

/**
 * The three drafts a style-guide page holds — HIVE-5.7 (#5310).
 *
 * ### Why the drafts live here rather than in the tabs
 *
 * The ticket's fourth acceptance criterion is that **unsaved changes survive tab switches
 * within the page**. In the screen this replaces they did not: each tab was a component
 * that fetched on mount and held its own draft, so switching away unmounted it and threw
 * the draft on the floor with no warning at all — the "dirty state is easy to lose" in the
 * problem statement.
 *
 * The fix is not to keep all three tabs mounted (that would make an unopened tab cost three
 * network round-trips on arrival). It is to move the *state* up to the page, where it
 * outlives any panel, and leave the tabs presentational. These three hooks are that state.
 * The page calls all three on every render — hooks cannot be called conditionally — and each
 * one takes an `active` flag that decides when it may *load*, latching the first time it is
 * true. So an unopened tab still fetches nothing, and an opened one keeps its draft for as
 * long as the page is on screen.
 *
 * Everything a component needs in order to draw a tab is on the returned object; everything
 * pure that decides what to draw is in {@link ./guideDetailModel}.
 */

import * as React from 'react';

import {
  DEFAULT_BREAKING_PUBLISH_POLICY,
  DEFAULT_GUIDE_CI_OUTCOMES,
  fetchProjectOptions,
  fetchVersionOptions,
  styleGuidesApi,
  styleGuidesApiWithValidation,
  type BreakingPublishPolicyLevel,
  type CustomRulesPreviewResult,
  type GuideCiOutcomes,
  type GuideCustomRulesView,
  type GuidePolicySettings,
  type GuidePolicyVersion,
  type GuidePolicyVersionList,
  type GuideRulesView,
  type ProjectOption,
  type VersionOption,
} from '@/app/ade/dashboard/style-guides/api';
import {
  parseValidationDetail,
  type ServerValidationDetail,
} from '@/app/ade/dashboard/style-guides/customRuleYamlMarkers';

import {
  enabledRuleCount,
  modifiedRuleIds,
  toRuleStateMap,
  type RuleState,
  type RuleStateMap,
} from './guideDetailModel';

/**
 * Turn a caught failure into the sentence to show.
 *
 * @param error Whatever was caught.
 * @param fallback What to say when the failure carried no message.
 * @returns The sentence.
 */
function describeFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Latch a flag on, once.
 *
 * A tab is loaded when it is *first* shown and stays loaded after that: the read is what
 * costs, not the mounted markup, and re-fetching on every return to a tab would throw away
 * exactly the draft this module exists to keep.
 *
 * @param active Whether the tab is showing now.
 * @returns True from the first render on which `active` was true.
 */
function useLatched(active: boolean): boolean {
  const [latched, setLatched] = React.useState(active);
  React.useEffect(() => {
    if (active) setLatched(true);
  }, [active]);
  return latched || active;
}

// ---------------------------------------------------------------------------------------
// The rule catalog
// ---------------------------------------------------------------------------------------

/** What the rule catalog tab is handed. */
export interface RuleCatalogState {
  /** The merged registry + guide payload, or `null` when the guide was not found. */
  view: GuideRulesView | null;
  /** Rule id → the state the reader has now. */
  draft: RuleStateMap;
  /** Rule id → the state the server last confirmed. */
  baseline: RuleStateMap;
  /** Whether the first read is still in flight. */
  loading: boolean;
  /** Whether a save is in flight. */
  saving: boolean;
  /** Why the read or the write failed, or `''`. */
  error: string;
  /** The ids whose draft differs from the baseline. */
  modifiedIds: readonly string[];
  /** Whether anything differs. */
  dirty: boolean;
  /** How many rules the draft has switched on. */
  enabled: number;
  /** Change one rule. */
  setRuleState: (ruleId: string, patch: Partial<RuleState>) => void;
  /** Throw the draft away. */
  discard: () => void;
  /** PUT the whole rule set and re-baseline from the response. */
  save: () => Promise<boolean>;
  /** Read it again — the retry beside a failed load. */
  reload: () => void;
  /** Dismiss the error banner. */
  clearError: () => void;
}

/**
 * Load and edit a guide's built-in rule catalog.
 *
 * @param guideId The guide.
 * @returns Everything the catalog tab draws and every write it makes.
 */
export function useRuleCatalog(guideId: string): RuleCatalogState {
  const [view, setView] = React.useState<GuideRulesView | null>(null);
  const [draft, setDraft] = React.useState<Record<string, RuleState>>({});
  const [baseline, setBaseline] = React.useState<RuleStateMap>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const load = React.useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const rulesView = await styleGuidesApi<GuideRulesView>(`${guideId}/rules`);
      setView(rulesView ?? null);
      const state = toRuleStateMap(rulesView?.rules ?? []);
      setBaseline(state);
      setDraft(state);
    } catch (e) {
      setView(null);
      setError(describeFailure(e, 'Failed to load the style guide'));
    } finally {
      setLoading(false);
    }
  }, [guideId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const modifiedIds = React.useMemo(
    () => modifiedRuleIds(draft, baseline),
    [draft, baseline]
  );

  const setRuleState = React.useCallback((ruleId: string, patch: Partial<RuleState>) => {
    setDraft((prev) => {
      const current = prev[ruleId];
      if (!current) return prev;
      return { ...prev, [ruleId]: { ...current, ...patch } };
    });
  }, []);

  const discard = React.useCallback(() => setDraft({ ...baseline }), [baseline]);

  const save = React.useCallback(async () => {
    if (!view) return false;
    setSaving(true);
    setError('');
    try {
      const saved = await styleGuidesApi<GuideRulesView>(`${guideId}/rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The whole set, not the diff: the endpoint replaces the guide's rule state, and
          // sending only what changed would silently reset everything else to its default.
          rules: view.rules.map((rule) => ({
            ruleId: rule.ruleId,
            enabled: draft[rule.ruleId]?.enabled ?? rule.enabled,
            severity: draft[rule.ruleId]?.severity ?? rule.severity,
          })),
        }),
      });
      if (saved) {
        setView(saved);
        const state = toRuleStateMap(saved.rules);
        setBaseline(state);
        setDraft(state);
      }
      return true;
    } catch (e) {
      setError(describeFailure(e, 'Failed to save rule changes'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, guideId, view]);

  return {
    view,
    draft,
    baseline,
    loading,
    saving,
    error,
    modifiedIds,
    dirty: modifiedIds.length > 0,
    enabled: enabledRuleCount(draft),
    setRuleState,
    discard,
    save,
    reload: () => void load(),
    clearError: () => setError(''),
  };
}

// ---------------------------------------------------------------------------------------
// Custom rules
// ---------------------------------------------------------------------------------------

/** What the last dry run cost, for the line beside Run. */
export interface PreviewRunMeta {
  /** When it finished, as a local clock time. */
  at: string;
  /** How long it took, in seconds to one decimal. */
  seconds: string;
  /** Which project and version it ran against. */
  target: string;
}

/** What the custom-rules tab is handed. */
export interface CustomRulesState {
  /** The saved document, or `null` when the guide was not found. */
  view: GuideCustomRulesView | null;
  /** The YAML the reader has now. */
  draft: string;
  /** The YAML the server last confirmed. */
  baseline: string;
  /** Whether the first read is still in flight. */
  loading: boolean;
  /** Whether a save is in flight. */
  saving: boolean;
  /** Whether a dry run is in flight. */
  previewing: boolean;
  /** Why a call failed in a way that is not about the document, or `''`. */
  error: string;
  /** The server's own complaint about the document, with the pointer to mark. */
  validation: ServerValidationDetail | null;
  /** Whether the draft differs from the baseline. */
  dirty: boolean;
  /** Projects the dry run can be aimed at. */
  projects: readonly ProjectOption[];
  /** Versions of the chosen project. */
  versions: readonly VersionOption[];
  /** The chosen project. */
  projectId: string;
  /** The chosen version record. */
  versionRecordId: string;
  /** The last dry run's results, or `null` before the first. */
  preview: CustomRulesPreviewResult | null;
  /** What that run cost. */
  runMeta: PreviewRunMeta | null;
  /** Replace the draft. */
  setDraft: (yaml: string) => void;
  /** Aim the dry run at another project. */
  setProjectId: (projectId: string) => void;
  /** Aim it at another version. */
  setVersionRecordId: (versionRecordId: string) => void;
  /** Throw the draft away, along with anything said about it. */
  discard: () => void;
  /** PUT the document. */
  save: () => Promise<boolean>;
  /** Run the draft against the chosen version without saving anything. */
  runPreview: () => Promise<void>;
  /** Dismiss the error banner. */
  clearError: () => void;
}

/**
 * Load and edit a guide's custom-rules document.
 *
 * @param guideId The guide.
 * @param active Whether the custom-rules tab has been opened. Latched: the first `true`
 *   starts the read, and the draft survives every later `false`.
 * @returns Everything the custom-rules tab draws and every write it makes.
 */
export function useCustomRules(guideId: string, active: boolean): CustomRulesState {
  const wanted = useLatched(active);

  const [view, setView] = React.useState<GuideCustomRulesView | null>(null);
  const [draft, setDraft] = React.useState('');
  const [baseline, setBaseline] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [error, setError] = React.useState('');
  const [validation, setValidation] = React.useState<ServerValidationDetail | null>(null);

  const [projects, setProjects] = React.useState<ProjectOption[]>([]);
  const [versions, setVersions] = React.useState<VersionOption[]>([]);
  const [projectId, setProjectId] = React.useState('');
  const [versionRecordId, setVersionRecordId] = React.useState('');
  const [preview, setPreview] = React.useState<CustomRulesPreviewResult | null>(null);
  const [runMeta, setRunMeta] = React.useState<PreviewRunMeta | null>(null);

  React.useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    setError('');
    setLoading(true);
    // The project list is for the dry-run picker only: a tenant with no projects still has
    // a document to edit, so its failure must not cost the reader their editor.
    void Promise.all([
      styleGuidesApi<GuideCustomRulesView>(`${guideId}/custom-rules`),
      fetchProjectOptions().catch(() => [] as ProjectOption[]),
    ])
      .then(([customView, projectList]) => {
        if (cancelled) return;
        setView(customView ?? null);
        setDraft(customView?.yaml ?? '');
        setBaseline(customView?.yaml ?? '');
        setProjects(projectList);
        setProjectId((prev) => prev || projectList[0]?.id || '');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setView(null);
        setError(describeFailure(e, 'Failed to load custom rules'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guideId, wanted]);

  React.useEffect(() => {
    if (!projectId) {
      setVersions([]);
      setVersionRecordId('');
      return;
    }
    let cancelled = false;
    void fetchVersionOptions(projectId).then((list) => {
      if (cancelled) return;
      setVersions(list);
      setVersionRecordId(list[0]?.id ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const discard = React.useCallback(() => {
    setDraft(baseline);
    setValidation(null);
    setPreview(null);
    setRunMeta(null);
  }, [baseline]);

  const save = React.useCallback(async () => {
    setSaving(true);
    setError('');
    setValidation(null);
    try {
      const saved = await styleGuidesApiWithValidation<GuideCustomRulesView>(
        `${guideId}/custom-rules`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ yaml: draft }),
        }
      );
      if (saved) {
        setView(saved);
        setBaseline(saved.yaml);
        setDraft(saved.yaml);
      }
      return true;
    } catch (e) {
      // A 422 is the server telling the reader something about *their document*, and it
      // carries the pointer that says where. Anything else is a failure of the request and
      // belongs in the error banner instead.
      const detail = parseValidationDetail((e as Error & { detail?: unknown }).detail ?? e);
      if (detail?.message) setValidation(detail);
      else setError(describeFailure(e, 'Failed to save custom rules'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, guideId]);

  const runPreview = React.useCallback(async () => {
    if (!projectId || !versionRecordId) return;
    setPreviewing(true);
    setError('');
    setValidation(null);
    const startedAt = Date.now();
    try {
      const result = await styleGuidesApiWithValidation<CustomRulesPreviewResult>(
        `${guideId}/custom-rules/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ yaml: draft, projectId, versionRecordId }),
        }
      );
      setPreview(result);
      setRunMeta({
        at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        seconds: ((Date.now() - startedAt) / 1000).toFixed(1),
        target: [
          projects.find((p) => p.id === projectId)?.name,
          versions.find((v) => v.id === versionRecordId)?.label,
        ]
          .filter(Boolean)
          .join(' '),
      });
    } catch (e) {
      const detail = parseValidationDetail((e as Error & { detail?: unknown }).detail ?? e);
      if (detail?.message) setValidation(detail);
      else setError(describeFailure(e, 'Preview failed'));
      setPreview(null);
      setRunMeta(null);
    } finally {
      setPreviewing(false);
    }
  }, [draft, guideId, projectId, projects, versionRecordId, versions]);

  return {
    view,
    draft,
    baseline,
    loading: wanted ? loading : true,
    saving,
    previewing,
    error,
    validation,
    dirty: draft !== baseline,
    projects,
    versions,
    projectId,
    versionRecordId,
    preview,
    runMeta,
    setDraft,
    setProjectId,
    setVersionRecordId,
    discard,
    save,
    runPreview,
    clearError: () => setError(''),
  };
}

// ---------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------

/** The editable half of a guide's policy. */
export interface PolicyDraft {
  /** Per-axis floors; only `quality` has a UI today. */
  axisGates: GuidePolicySettings['axisGates'];
  /** Axes that must carry evidence at all. */
  requiredCoverage: string[];
  /** What `GET …/lint/gate` reports as failed. */
  ciOutcomes: GuideCiOutcomes;
  /** What a breaking publish without a major bump does. */
  breakingPublishPolicy: BreakingPublishPolicyLevel;
}

/**
 * Normalize API policy settings into editable draft state.
 *
 * @param settings The payload.
 * @returns The draft.
 */
export function toPolicyDraft(settings: GuidePolicySettings): PolicyDraft {
  return {
    axisGates: { ...settings.axisGates },
    requiredCoverage: [...settings.requiredCoverage],
    ciOutcomes: { ...DEFAULT_GUIDE_CI_OUTCOMES, ...settings.ciOutcomes },
    breakingPublishPolicy: settings.breakingPublishPolicy ?? DEFAULT_BREAKING_PUBLISH_POLICY,
  };
}

/**
 * Whether a policy draft differs from what was loaded.
 *
 * Coverage is compared as a *set*: the checkbox list appends and removes, so two equal
 * selections can disagree on order and a plain deep compare would call an untouched form
 * dirty.
 *
 * @param draft What the reader has now.
 * @param baseline What was loaded.
 * @returns True when they differ.
 */
export function isPolicyDirty(draft: PolicyDraft, baseline: PolicyDraft): boolean {
  if ((draft.axisGates.quality?.minGrade ?? '') !== (baseline.axisGates.quality?.minGrade ?? '')) {
    return true;
  }
  if (draft.breakingPublishPolicy !== baseline.breakingPublishPolicy) return true;
  const coverage = [...draft.requiredCoverage].sort();
  const savedCoverage = [...baseline.requiredCoverage].sort();
  if (coverage.length !== savedCoverage.length) return true;
  if (coverage.some((axis, index) => axis !== savedCoverage[index])) return true;
  return (
    draft.ciOutcomes.failOnUnwaivedErrors !== baseline.ciOutcomes.failOnUnwaivedErrors ||
    draft.ciOutcomes.failOnRequiredCoverage !== baseline.ciOutcomes.failOnRequiredCoverage ||
    draft.ciOutcomes.failOnAxisGates !== baseline.ciOutcomes.failOnAxisGates
  );
}

/** What the policy tab is handed. */
export interface GuidePolicyState {
  /** The settings the reader has now, or `null` when there are none to show. */
  draft: PolicyDraft | null;
  /** Whether the first read is still in flight. */
  loading: boolean;
  /** Whether a save is in flight. */
  saving: boolean;
  /** Why a call failed, or `''`. */
  error: string;
  /** Whether the draft differs from what was loaded. */
  dirty: boolean;
  /** The immutable snapshots, newest first as the API returns them. */
  versions: readonly GuidePolicyVersion[];
  /** Change the quality axis floor; `''` removes it. */
  setQualityMinGrade: (minGrade: string) => void;
  /** Require, or stop requiring, evidence for one axis. */
  toggleCoverage: (axis: string, required: boolean) => void;
  /** Change the breaking-publish guardrail. */
  setBreakingPublishPolicy: (level: BreakingPublishPolicyLevel) => void;
  /** Change one CI outcome switch. */
  setCiOutcome: (key: keyof GuideCiOutcomes, fail: boolean) => void;
  /** Throw the draft away. */
  discard: () => void;
  /** PUT the settings, snapshotting a new immutable version. */
  save: () => Promise<boolean>;
  /** Dismiss the error banner. */
  clearError: () => void;
}

/**
 * Load and edit a guide's policy gates.
 *
 * @param guideId The guide.
 * @param active Whether the policy tab has been opened. Latched, as {@link useCustomRules}.
 * @returns Everything the policy tab draws and every write it makes.
 */
export function useGuidePolicy(guideId: string, active: boolean): GuidePolicyState {
  const wanted = useLatched(active);

  const [draft, setDraft] = React.useState<PolicyDraft | null>(null);
  const [baseline, setBaseline] = React.useState<PolicyDraft | null>(null);
  const [versions, setVersions] = React.useState<GuidePolicyVersion[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    setError('');
    setLoading(true);
    void Promise.all([
      styleGuidesApi<GuidePolicySettings>(`${guideId}/policy`),
      styleGuidesApi<GuidePolicyVersionList>(`${guideId}/policy-versions`),
    ])
      .then(([settings, versionList]) => {
        if (cancelled) return;
        const next = settings ? toPolicyDraft(settings) : null;
        setBaseline(next);
        setDraft(next);
        setVersions(versionList?.versions ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(describeFailure(e, 'Failed to load policy settings'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guideId, wanted]);

  const patch = React.useCallback((change: (prev: PolicyDraft) => PolicyDraft) => {
    setDraft((prev) => (prev ? change(prev) : prev));
  }, []);

  const setQualityMinGrade = React.useCallback(
    (minGrade: string) =>
      patch((prev) => {
        const axisGates = { ...prev.axisGates };
        if (minGrade) axisGates.quality = { ...axisGates.quality, minGrade };
        else delete axisGates.quality;
        return { ...prev, axisGates };
      }),
    [patch]
  );

  const toggleCoverage = React.useCallback(
    (axis: string, required: boolean) =>
      patch((prev) => {
        const set = new Set(prev.requiredCoverage);
        if (required) set.add(axis);
        else set.delete(axis);
        return { ...prev, requiredCoverage: Array.from(set) };
      }),
    [patch]
  );

  const setBreakingPublishPolicy = React.useCallback(
    (level: BreakingPublishPolicyLevel) =>
      patch((prev) => ({ ...prev, breakingPublishPolicy: level })),
    [patch]
  );

  const setCiOutcome = React.useCallback(
    (key: keyof GuideCiOutcomes, fail: boolean) =>
      patch((prev) => ({ ...prev, ciOutcomes: { ...prev.ciOutcomes, [key]: fail } })),
    [patch]
  );

  const save = React.useCallback(async () => {
    if (!draft) return false;
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
        const next = toPolicyDraft(saved);
        setBaseline(next);
        setDraft(next);
      }
      const versionList = await styleGuidesApi<GuidePolicyVersionList>(
        `${guideId}/policy-versions`
      );
      setVersions(versionList?.versions ?? []);
      return true;
    } catch (e) {
      setError(describeFailure(e, 'Failed to save policy settings'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, guideId]);

  return {
    draft,
    loading: wanted ? loading : true,
    saving,
    error,
    dirty: draft && baseline ? isPolicyDirty(draft, baseline) : false,
    versions,
    setQualityMinGrade,
    toggleCoverage,
    setBreakingPublishPolicy,
    setCiOutcome,
    discard: () => setDraft(baseline),
    save,
    clearError: () => setError(''),
  };
}
