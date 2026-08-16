'use client';

/**
 * Guide editor — rule catalog tab (GOV-2.2, #4434) and custom rules tab (GOV-2.3, #4435)
 *
 * Lets tenant admins tailor a style guide's built-in rules — the most common governance
 * action after GOV-2.1 gave them the guides themselves:
 *  - Every GOV-1.2 registry rule, grouped by category, with its rationale and default
 *    severity (one `GET /api/style-guides/{id}/rules` payload — registry merged with the
 *    guide's `style_guide_rules` state server-side).
 *  - Per-rule enable switch and severity select (error / warning / info).
 *  - Search + category filter and a live enabled-rule count.
 *  - Dirty-state save bar: edits stay local until Save PUTs the full rule set back;
 *    Discard reverts; leaving the page with unsaved changes warns first.
 *
 * The built-in "Apiome Recommended" guide and non-admin sessions render read-only —
 * the REST layer enforces both; the UI disables the controls and explains why.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  BookOpenCheck,
  Lock,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Switch } from '@/app/components/ui/Switch';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { cn } from '@lib/utils';
import { useDialog } from '@/app/components/providers/DialogProvider';
import {
  fetchMyPermissions,
  styleGuidesApi,
  type GuideRule,
  type GuideRulesView,
  type RuleSeverity,
} from '../api';
import CustomRulesTab from './CustomRulesTab';
import PolicyTab from './PolicyTab';

type GuideEditorTab = 'catalog' | 'custom' | 'policy';

/** The editable half of a rule row — what the save bar diffs and the PUT persists. */
interface RuleState {
  enabled: boolean;
  severity: RuleSeverity;
}

/** Severity options offered by the per-rule select. */
const SEVERITIES: { value: RuleSeverity; label: string }[] = [
  { value: 'error', label: 'Error' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

const inputClasses =
  'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white';

/** Map rule id -> editable state from a rules payload (the dirty-diff baseline shape). */
function toStateMap(rules: GuideRule[]): Record<string, RuleState> {
  const map: Record<string, RuleState> = {};
  for (const rule of rules) {
    map[rule.ruleId] = { enabled: rule.enabled, severity: rule.severity };
  }
  return map;
}

/** Severity badge colors, keyed by severity (shared by the default-severity chip). */
const severityBadgeClasses: Record<RuleSeverity, string> = {
  error: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  info: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
};

export default function GuideEditorClient({ guideId }: { guideId: string }) {
  const router = useRouter();
  const { confirm } = useDialog();

  const [view, setView] = useState<GuideRulesView | null>(null);
  const [draft, setDraft] = useState<Record<string, RuleState>>({});
  const [baseline, setBaseline] = useState<Record<string, RuleState>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [activeTab, setActiveTab] = useState<GuideEditorTab>('catalog');

  const readOnly = !isAdmin || view?.source === 'builtin';

  const loadData = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [rulesView, perms] = await Promise.all([
        styleGuidesApi<GuideRulesView>(`${guideId}/rules`),
        fetchMyPermissions(),
      ]);
      if (rulesView) {
        setView(rulesView);
        const state = toStateMap(rulesView.rules);
        setBaseline(state);
        setDraft(state);
      }
      setIsAdmin(!!perms?.is_admin);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the style guide');
    } finally {
      setLoading(false);
    }
  }, [guideId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // The rule ids whose draft state differs from the saved baseline.
  const dirtyIds = useMemo(
    () =>
      Object.keys(draft).filter(
        (id) =>
          draft[id].enabled !== baseline[id]?.enabled ||
          draft[id].severity !== baseline[id]?.severity,
      ),
    [draft, baseline],
  );
  const dirty = dirtyIds.length > 0;

  // Warn on tab close / hard navigation while changes are unsaved (in-app back navigation
  // goes through handleBack below, which asks via the dialog provider instead).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const enabledCount = useMemo(
    () => Object.values(draft).filter((s) => s.enabled).length,
    [draft],
  );

  const categories = useMemo(
    () => Array.from(new Set((view?.rules ?? []).map((r) => r.category))).sort(),
    [view],
  );

  // Search matches rule id, rationale, or category; the category filter narrows on top.
  const visibleRules = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (view?.rules ?? []).filter((rule) => {
      if (category !== 'all' && rule.category !== category) return false;
      if (!term) return true;
      return (
        rule.ruleId.toLowerCase().includes(term) ||
        rule.rationale.toLowerCase().includes(term) ||
        rule.category.toLowerCase().includes(term)
      );
    });
  }, [view, search, category]);

  /** Visible rules grouped by category, categories sorted, rules already sorted by id. */
  const groupedRules = useMemo(() => {
    const groups = new Map<string, GuideRule[]>();
    for (const rule of visibleRules) {
      const list = groups.get(rule.category) ?? [];
      list.push(rule);
      groups.set(rule.category, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [visibleRules]);

  const setRuleState = (ruleId: string, patch: Partial<RuleState>) => {
    setDraft((prev) => ({ ...prev, [ruleId]: { ...prev[ruleId], ...patch } }));
  };

  const handleDiscard = () => setDraft(baseline);

  const handleSave = async () => {
    if (!view) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        rules: view.rules.map((rule) => ({
          ruleId: rule.ruleId,
          enabled: draft[rule.ruleId].enabled,
          severity: draft[rule.ruleId].severity,
        })),
      };
      const saved = await styleGuidesApi<GuideRulesView>(`${guideId}/rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (saved) {
        setView(saved);
        const state = toStateMap(saved.rules);
        setBaseline(state);
        setDraft(state);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save rule changes');
    } finally {
      setSaving(false);
    }
  };

  /** In-app back navigation: confirm first when changes would be lost. */
  const handleBack = async () => {
    if (dirty) {
      const leave = await confirm({
        title: 'Discard unsaved changes?',
        message:
          `You have unsaved changes to ${dirtyIds.length} rule${dirtyIds.length === 1 ? '' : 's'}. ` +
          'Leaving this page discards them.',
        confirmLabel: 'Discard and leave',
      });
      if (!leave) return;
    }
    router.push('/ade/dashboard/style-guides');
  };

  return (
    <>
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-6 pt-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleBack}
                aria-label="Back to style guides"
                className="rounded-lg border border-slate-200 p-2 text-gray-500 hover:bg-slate-100 dark:border-slate-700 dark:text-gray-400 dark:hover:bg-slate-800"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600">
                <BookOpenCheck className="h-5 w-5 text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                    {view?.guideName ?? 'Style guide'}
                  </h2>
                  {view?.source === 'builtin' && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-2xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      Built-in
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Tailor which built-in rules apply and how severely they score
                </p>
              </div>
            </div>
            {view && (
              <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                {enabledCount} of {view.count} rules enabled
              </span>
            )}
          </div>
          {/* Tab strip: rule catalog (GOV-2.2) and custom rules (GOV-2.3). */}
          <nav role="tablist" aria-label="Guide editor tabs" className={cn(TAB_LIST_CLASS, 'mt-4')}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'catalog'}
              onClick={() => setActiveTab('catalog')}
              className={tabTriggerClass({ active: activeTab === 'catalog' })}
            >
              Rule catalog
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'custom'}
              onClick={() => setActiveTab('custom')}
              className={tabTriggerClass({ active: activeTab === 'custom' })}
            >
              Custom rules
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'policy'}
              onClick={() => setActiveTab('policy')}
              className={tabTriggerClass({ active: activeTab === 'policy' })}
            >
              Policy
            </button>
          </nav>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950">
        {activeTab === 'custom' ? (
          <CustomRulesTab guideId={guideId} />
        ) : activeTab === 'policy' ? (
          <PolicyTab guideId={guideId} readOnly={readOnly} />
        ) : (
          <>
        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {view && readOnly && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-100 p-4 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <Lock className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <p className="text-sm">
              {view.source === 'builtin'
                ? 'The built-in “Apiome Recommended” guide is read-only. Duplicate it from the Style Guides list to customize its rules.'
                : 'Only tenant administrators can change style guide rules. You can browse the catalog.'}
            </p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : !view ? (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
            <BookOpenCheck className="mx-auto mb-4 h-12 w-12 text-gray-400" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Style guide not found.</p>
            <Link
              href="/ade/dashboard/style-guides"
              className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Back to style guides
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="relative min-w-64 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="search"
                  aria-label="Search rules"
                  placeholder="Search rules by id, rationale, or category…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={`${inputClasses} w-full pl-9`}
                />
              </div>
              <select
                aria-label="Filter by category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={inputClasses}
              >
                <option value="all">All categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {groupedRules.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  No rules match your search.
                </p>
              </div>
            ) : (
              <div className="space-y-6 pb-24">
                {groupedRules.map(([cat, rules]) => (
                  <section
                    key={cat}
                    aria-label={`${cat} rules`}
                    className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                  >
                    <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-gray-400">
                      {cat}
                      <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
                        {rules.filter((r) => draft[r.ruleId]?.enabled).length} of {rules.length} on
                      </span>
                    </h3>
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                      {rules.map((rule) => {
                        const state = draft[rule.ruleId];
                        const changed =
                          state.enabled !== baseline[rule.ruleId]?.enabled ||
                          state.severity !== baseline[rule.ruleId]?.severity;
                        return (
                          <li key={rule.ruleId} className="flex items-center gap-4 px-4 py-3">
                            <Switch
                              aria-label={`Enable ${rule.ruleId}`}
                              checked={state.enabled}
                              disabled={readOnly || saving}
                              onCheckedChange={(checked) =>
                                setRuleState(rule.ruleId, { enabled: checked })
                              }
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <code className="text-sm font-medium text-gray-900 dark:text-white">
                                  {rule.ruleId}
                                </code>
                                <span
                                  className={`rounded-full px-2 py-0.5 text-2xs font-medium ${severityBadgeClasses[rule.defaultSeverity]}`}
                                >
                                  default: {rule.defaultSeverity}
                                </span>
                                {changed && (
                                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-2xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                                    modified
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                                {rule.rationale}
                              </p>
                            </div>
                            <select
                              aria-label={`Severity for ${rule.ruleId}`}
                              value={state.severity}
                              disabled={readOnly || saving || !state.enabled}
                              onChange={(e) =>
                                setRuleState(rule.ruleId, {
                                  severity: e.target.value as RuleSeverity,
                                })
                              }
                              className={`${inputClasses} shrink-0 disabled:opacity-50`}
                            >
                              {SEVERITIES.map((s) => (
                                <option key={s.value} value={s.value}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
          </>
        )}
      </main>

      {/* Dirty-state save bar: fixed above the content while unsaved catalog changes exist. */}
      {activeTab === 'catalog' && dirty && (
        <div
          role="status"
          className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-amber-300 bg-amber-50 px-6 py-3 dark:border-amber-700 dark:bg-amber-900/30"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
            <BadgeCheck className="h-4 w-4" />
            {dirtyIds.length} unsaved rule change{dirtyIds.length === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={saving}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-gray-700 hover:bg-white disabled:opacity-50 dark:border-slate-600 dark:text-gray-200 dark:hover:bg-slate-800"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
