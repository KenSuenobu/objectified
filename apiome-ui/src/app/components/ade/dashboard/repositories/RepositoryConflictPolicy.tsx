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
import { GitBranch, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent } from '@/app/components/ui/Card';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import {
  CONFLICT_POLICIES,
  POLICY_COPY,
  POLICY_TONE_BADGE,
  type ConflictPolicy,
  type ConflictPolicyResponse,
  asConflictPolicy,
  conflictPolicySummary,
  parseConflictPolicyResponse,
} from '@/app/components/ade/dashboard/repositories/repositoryConflictPolicy';

/**
 * One selectable policy: the label, the consequence of choosing it, and the radio that picks
 * it.
 *
 * The card *is* the `<label>` here, unlike the Map & import wizard's target cards
 * (HIVE-7.5): this one contains nothing that can be pressed, so wrapping it is the right
 * shape — the whole rectangle is the hit area and the browser owns the arrow keys.
 *
 * @param props.policy Which policy this row offers.
 * @param props.selected Whether it is the repository's current policy.
 * @param props.disabled Whether a write is in flight.
 * @param props.onSelect Choose it.
 * @returns The choice row.
 */
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
  const mark = POLICY_TONE_BADGE[copy.tone];
  return (
    <label
      className="repo-set-policy"
      data-testid={`conflict-policy-option-${policy}`}
      data-selected={selected ? 'true' : 'false'}
    >
      <input
        type="radio"
        name="repository-conflict-policy"
        value={policy}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(policy)}
      />
      <span className="repo-set-policy__body">
        <span className="repo-set-policy__title">
          {copy.label}
          {mark ? <Badge variant={mark.tone}>{mark.label}</Badge> : null}
        </span>
        <span className="repo-set-policy__desc">{copy.detail}</span>
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
      <Card data-testid="conflict-policy-loading">
        <CardContent className="flex flex-col gap-2">
          <h3 className="repo-det-card__title">Refresh conflicts</h3>
          <p className="repo-det-note">Loading conflict policy…</p>
        </CardContent>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <ErrorState
        data-testid="conflict-policy-error"
        title="Refresh conflicts"
        description={error}
        onRetry={() => void load()}
      />
    );
  }

  if (!data) return null;

  return (
    <Card data-testid="conflict-policy">
      <CardContent
        className="flex flex-col gap-4"
        role="group"
        aria-label="Refresh conflict policy"
      >
        <div className="flex flex-col gap-1">
          <h3 className="repo-det-card__title">Refresh conflicts</h3>
          <p className="repo-det-note">
            When auto-refresh re-imports a file whose version was edited in Apiome after the
            original import, this decides what happens.
          </p>
          <p className="text-xs font-medium text-fg" data-testid="conflict-policy-summary">
            {conflictPolicySummary(data.policy, data.overrides.length)}
          </p>
        </div>

        <fieldset className="flex flex-col gap-2" disabled={saving}>
          <legend className="repo-det-caps">Repository policy</legend>
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

        <div className="flex flex-col gap-3">
          <h4 className="repo-det-caps flex items-center gap-2">
            <GitBranch className="size-3.5 shrink-0" aria-hidden />
            Per-file overrides
          </h4>

          {data.overrides.length === 0 ? (
            <p className="repo-det-note" data-testid="conflict-policy-no-overrides">
              No exceptions — every file follows the repository policy.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="conflict-policy-overrides">
              {data.overrides.map((o) => (
                <li key={`${o.branch}:${o.path}`} className="repo-det-row">
                  <span className="mono min-w-0 truncate text-xs">{o.path}</span>
                  <span className="repo-det-note truncate">
                    {o.branch} · {POLICY_COPY[o.policy].label}
                  </span>
                  <span className="repo-det-row__end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => clearOverride(o.branch, o.path)}
                      aria-label={`Remove override for ${o.path}`}
                    >
                      <Trash2 aria-hidden />
                      Clear
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="repo-set-override-form">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conflict-override-branch">Branch</Label>
              <Input
                id="conflict-override-branch"
                value={overrideBranch}
                disabled={saving}
                onChange={(e) => setOverrideBranch(e.target.value)}
                className="mono"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conflict-override-path">File path</Label>
              <Input
                id="conflict-override-path"
                value={overridePath}
                placeholder="specs/petstore.yaml"
                disabled={saving}
                onChange={(e) => setOverridePath(e.target.value)}
                className="mono"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conflict-override-policy">Policy</Label>
              <Select
                value={overridePolicy}
                disabled={saving}
                onValueChange={(value) => setOverridePolicy(asConflictPolicy(value))}
              >
                <SelectTrigger id="conflict-override-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONFLICT_POLICIES.map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {POLICY_COPY[policy].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => void addOverride()}
              >
                <Plus aria-hidden />
                Save file override
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
