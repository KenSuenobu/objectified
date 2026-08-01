'use client';

/**
 * Repository refresh conflict-policy panel (RAR-4.5, #3531).
 *
 * Auto-refresh re-imports a changed repository file using the spec the user originally chose
 * (RAR-4.1). When the version that import produced has been hand-edited in Apiome since, the
 * divergence guard (RAR-4.4) stops and asks. This panel is where a team answers that question
 * ahead of time — once for the repository, and per file where one file needs to differ.
 *
 * Three things drive the design:
 *
 *  * **The consequence is stated, not the name.** "Overwrite" is a word; "the repository
 *    version replaces the edits made in Apiome" is the decision. Each option carries its
 *    consequence next to it, because the cost of picking the wrong one is lost work.
 *  * **The exceptions are visible from the default.** A repository set to overwrite with four
 *    files held back is a different setup from one with none, so the summary line counts the
 *    overrides and the table lists them — no expanding required to see what deviates.
 *  * **Clearing an override is a first-class action.** Removing an exception returns the file
 *    to whatever the repository says *next*, which is why it is a delete rather than a stored
 *    copy of today's repository policy.
 *
 * Reads and writes go through `/api/repositories/{id}/conflict-policy`, which proxies to the
 * REST surface; every mutation re-renders from the projection the server returns, so the panel
 * cannot drift from stored state.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@lib/utils';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import {
  CONFLICT_POLICIES,
  POLICY_COPY,
  POLICY_TONE_CLASSES,
  type ConflictPolicy,
  type ConflictPolicyResponse,
  asConflictPolicy,
  conflictPolicySummary,
  parseConflictPolicyResponse,
} from '@/app/components/ade/dashboard/repositories/repositoryConflictPolicy';

/** Shared shell for the panel's cards, matching the surrounding settings tab. */
const panelClass =
  'space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800';

const sectionHeadingClass =
  'border-b border-gray-100 pb-2 text-sm font-semibold dark:border-gray-700 dark:text-gray-100';

const fieldLabelClass =
  'text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400';

const mutedTextClass = 'text-xs text-gray-500 dark:text-gray-400';

/** One selectable policy: the label, its consequence, and the radio that picks it. */
function PolicyOption({
  policy,
  selected,
  disabled,
  onSelect,
}: {
  policy: ConflictPolicy;
  selected: boolean;
  disabled: boolean;
  onSelect: (policy: ConflictPolicy) => void;
}) {
  const copy = POLICY_COPY[policy];
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors',
        selected
          ? POLICY_TONE_CLASSES[copy.tone]
          : 'border-gray-200 text-gray-700 dark:border-gray-700 dark:text-gray-300',
        selected && 'bg-gray-50 dark:bg-gray-900/40',
        disabled && 'cursor-not-allowed opacity-60'
      )}
      data-testid={`conflict-policy-option-${policy}`}
      data-selected={selected ? 'true' : 'false'}
    >
      <input
        type="radio"
        name="repository-conflict-policy"
        className="mt-1 h-4 w-4 shrink-0"
        value={policy}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(policy)}
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium">{copy.label}</span>
        <span className={cn('block', mutedTextClass)}>{copy.detail}</span>
      </span>
    </label>
  );
}

export function RepositoryConflictPolicy({
  repositoryId,
  defaultBranch,
}: {
  /** The repository whose policy this panel configures. */
  repositoryId: string;
  /** Pre-fills the branch field when adding an override; the usual case is one branch. */
  defaultBranch: string;
}) {
  const [data, setData] = useState<ConflictPolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overrideBranch, setOverrideBranch] = useState(defaultBranch);
  const [overridePath, setOverridePath] = useState('');
  const [overridePolicy, setOverridePolicy] = useState<ConflictPolicy>('hold-for-review');

  const api = `/api/repositories/${encodeURIComponent(repositoryId)}/conflict-policy`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api, { credentials: 'include' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : res.statusText);
      }
      setData(parseConflictPolicyResponse(body));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the conflict policy.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!repositoryId) return;
    void load();
  }, [repositoryId, load]);

  useEffect(() => {
    setOverrideBranch(defaultBranch);
  }, [defaultBranch]);

  /**
   * Send one mutation and re-render from the projection the server returns.
   *
   * @param path Sub-path under the conflict-policy route ('' for the repository policy).
   * @param body The request payload.
   * @param success Toast shown when the write lands.
   */
  const mutate = async (path: string, body: unknown, success: string) => {
    setSaving(true);
    try {
      const res = await fetch(`${api}${path}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(typeof parsed.error === 'string' ? parsed.error : res.statusText);
      }
      setData(parseConflictPolicyResponse(parsed));
      setError(null);
      toast.success(success);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the conflict policy.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const selectPolicy = (policy: ConflictPolicy) => {
    if (!data || policy === data.policy) return;
    void mutate('', { policy }, `Conflict policy set to “${POLICY_COPY[policy].label}”.`);
  };

  const addOverride = async () => {
    const branch = overrideBranch.trim();
    const path = overridePath.trim();
    if (!branch || !path) {
      toast.error('A branch and a file path are required.');
      return;
    }
    const ok = await mutate(
      '/file',
      { branch, path, policy: overridePolicy },
      `Override saved for ${path}.`
    );
    if (ok) setOverridePath('');
  };

  const clearOverride = (branch: string, path: string) => {
    void mutate('/file', { branch, path, policy: null }, `${path} now follows the repository.`);
  };

  if (loading && !data) {
    return (
      <div className={panelClass} data-testid="conflict-policy-loading">
        <h3 className={sectionHeadingClass}>Refresh conflicts</h3>
        <p className={mutedTextClass}>Loading conflict policy…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className={panelClass} data-testid="conflict-policy-error">
        <h3 className={sectionHeadingClass}>Refresh conflicts</h3>
        <p className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          {error}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <section className={panelClass} aria-label="Refresh conflict policy" data-testid="conflict-policy">
      <h3 className={sectionHeadingClass}>Refresh conflicts</h3>
      <p className={mutedTextClass}>
        When auto-refresh re-imports a file whose version was edited in Apiome after the original
        import, this decides what happens. Files with their own policy are listed below.
      </p>
      <p className="text-xs font-medium text-gray-700 dark:text-gray-200" data-testid="conflict-policy-summary">
        {conflictPolicySummary(data.policy, data.overrides.length)}
      </p>

      <fieldset className="space-y-2" disabled={saving}>
        <legend className={fieldLabelClass}>Repository policy</legend>
        {CONFLICT_POLICIES.map((policy) => (
          <PolicyOption
            key={policy}
            policy={policy}
            selected={data.policy === policy}
            disabled={saving}
            onSelect={selectPolicy}
          />
        ))}
      </fieldset>

      <div className="space-y-3 border-t border-gray-100 pt-4 dark:border-gray-700">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-300">
          <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Per-file overrides
        </h4>

        {data.overrides.length === 0 ? (
          <p className={mutedTextClass} data-testid="conflict-policy-no-overrides">
            No exceptions — every file follows the repository policy.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="conflict-policy-overrides">
            {data.overrides.map((o) => (
              <li
                key={`${o.branch}:${o.path}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700"
              >
                <span className="min-w-0 space-y-0.5">
                  <span className="block truncate font-mono text-xs text-gray-800 dark:text-gray-100">
                    {o.path}
                  </span>
                  <span className={cn('block', mutedTextClass)}>
                    {o.branch} · {POLICY_COPY[o.policy].label}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => clearOverride(o.branch, o.path)}
                  aria-label={`Remove override for ${o.path}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Clear
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={fieldLabelClass} htmlFor="conflict-override-branch">
              Branch
            </label>
            <Input
              id="conflict-override-branch"
              value={overrideBranch}
              disabled={saving}
              onChange={(e) => setOverrideBranch(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div>
            <label className={fieldLabelClass} htmlFor="conflict-override-path">
              File path
            </label>
            <Input
              id="conflict-override-path"
              value={overridePath}
              placeholder="specs/petstore.yaml"
              disabled={saving}
              onChange={(e) => setOverridePath(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div>
            <label className={fieldLabelClass} htmlFor="conflict-override-policy">
              Policy
            </label>
            <select
              id="conflict-override-policy"
              value={overridePolicy}
              disabled={saving}
              onChange={(e) => setOverridePolicy(asConflictPolicy(e.target.value))}
              className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-100"
            >
              {CONFLICT_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {POLICY_COPY[policy].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => void addOverride()}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Save file override
        </Button>
      </div>
    </section>
  );
}
