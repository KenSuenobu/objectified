'use client';

/**
 * Import selected — the repository batch wizard (BLK-1.4, #5526; extends BLK-1.5).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Import selected — batch wizard.
 *
 * The Files tab's *Map & import* wizard maps **one** specification at a time — a version, a
 * project and a set of naming conventions are per-file decisions. That is the right shape for
 * one file and the wrong shape for forty, and until BLK-1.5 ticking forty rows opened the
 * wizard on the first one and told the reader to "re-select the rest afterward". This is the
 * other shape: one wizard covering every ticked row, in three steps.
 *
 * 1. **Review.** The BLK-1.2 plan as a table — one row per independent spec, stating what
 *    would happen to it (*New version of Payments API* / *New project payments-api*), the
 *    version it would create, and why. A per-row control overrides the target, feeding the
 *    BLK-1.3 overrides. Files the batch will not import are listed as excluded with their
 *    reason rather than hidden.
 * 2. **Verify.** An explicit BLK-1.3 `dry_run`: the same rows, each with its validation
 *    outcome, and nothing written. Apply is unreachable until this has run or the reader
 *    deliberately skips it.
 * 3. **Apply.** One import job per item, with per-item progress and each item's realized
 *    destination. The run is the same {@link CatalogBulkImportPanel} the catalog wizard uses,
 *    and a row's own job draws the shared `ImportExecutionPanel` / `ImportCompletePanel` — the
 *    two wizards stay one object rather than growing a second execution surface.
 *
 * The reviewed plan's fingerprint rides on both runs, so a workspace that changed underneath
 * the batch produces a named-drift refusal and a *Re-plan* rather than a silent substitution.
 *
 * ### It is an overlay
 *
 * A `dialog--full` beside the Files tab rather than instead of it — the HIVE-7.5 guarantee —
 * so closing it returns the reader to their branch, filters, page and selection.
 *
 * ### The per-row target control
 *
 * A native `<select>` in its own cell, labelled by the row's path. It sits in no `<label>` and
 * wraps no control of its own, which is the HIVE-2.1 scoped choice-control rule read the other
 * way round: a control inside a table cell needs no card around it, so nothing is nested.
 *
 * Every rule here — what a row says, what an override means, what the header counts, what the
 * footer offers — is `repositoryBatchImportModel`, tested without a DOM. The panel renders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderPlus, GitBranch, Layers, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Dialog, DialogContent } from '@/app/components/ui/Dialog';
import {
  ImportWizardBody,
  ImportWizardFooter,
  ImportWizardHead,
  ImportWizardSteps,
} from '@/app/components/ade/import/ImportWizardChrome';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { Skeleton } from '@/app/components/ui/Skeleton';
import {
  CatalogBulkImportPanel,
  type BulkPlan,
  type BulkPlanDrift,
  type BulkResultRow,
} from '@/app/components/ade/dashboard/catalog/CatalogBulkImportPanel';
import {
  BATCH_APPLY_NOTE,
  BATCH_IMPORT_DESCRIPTION,
  BATCH_IMPORT_STEPS,
  BATCH_IMPORT_STEPS_LABEL,
  BATCH_OVERRIDE_NOTE,
  BATCH_STALE_PLAN_TITLE,
  BATCH_TARGET_PLAN,
  BATCH_VERIFY_NOTE,
  BATCH_VERIFY_SKIPPED_NOTE,
  batchExcludedRows,
  batchFooterFor,
  batchHeaderCounts,
  batchHeaderSummary,
  batchImportTitle,
  batchOffersSkipVerify,
  batchOverridesForRequest,
  batchPolicyLine,
  batchRowTarget,
  batchTargetOptions,
  batchUndecidedKeys,
  type BatchImportStep,
  type BatchProjectOption,
} from '@/app/components/ade/repositories/repositoryBatchImportModel';

/** Why a ticked file produced no item of its own — another item already compiles it. */
export const NOT_AN_ITEM_ROOT = 'not-an-item-root';

export interface RepositoryBulkImportPanelProps {
  /** Registered repository, so the server resolves the stored credential for a private read. */
  repositoryId: string;
  /** Repository web URL (`https://github.com/owner/repo`), the selector's `repo_url`. */
  repoUrl: string | null;
  /** Branch to read — the batch is anchored to the commit that branch points at. */
  branch: string;
  /** Repository-relative paths the reader ticked in the Files tab. */
  paths: readonly string[];
  /** Whether the overlay is showing. */
  open: boolean;
  /** Close the overlay. */
  onOpenChange: (open: boolean) => void;
  /** Called once the batch finished and at least one item imported. */
  onImported?: () => void;
}

/** The badge tone for each kind of row target. */
const TARGET_TONE: Record<'append' | 'create' | 'unresolved', 'ok' | 'neutral' | 'warn'> = {
  append: 'ok',
  create: 'neutral',
  unresolved: 'warn',
};

/** The review table's columns, in order. */
const REVIEW_COLUMNS = ['Path', 'Kind', 'Resolution', 'Version', 'Why', 'Target'] as const;

/**
 * Read the workspace's projects, for the per-row target control.
 *
 * @param payload The `/api/projects` body's `projects`.
 * @returns The projects that carry an id, sorted by name.
 */
function parseProjects(payload: unknown): BatchProjectOption[] {
  if (!Array.isArray(payload)) return [];
  const out: BatchProjectOption[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = String(o.id ?? '').trim();
    if (!id) continue;
    const name = String(o.name ?? 'Untitled').trim() || 'Untitled';
    const slug = String(o.slug ?? '').trim() || name.toLowerCase().replace(/\s+/g, '-');
    out.push({ id, name, slug });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

export function RepositoryBulkImportPanel({
  repositoryId,
  repoUrl,
  branch,
  paths,
  open,
  onOpenChange,
  onImported,
}: RepositoryBulkImportPanelProps) {
  const [plan, setPlan] = useState<BulkPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<BatchProjectOption[]>([]);
  /** Each row's target control value, keyed by item key. Absent means "apply the plan". */
  const [choices, setChoices] = useState<Record<string, string>>({});

  const [step, setStep] = useState<BatchImportStep>('review');
  const [running, setRunning] = useState(false);
  // A run is mounted by bumping its key; the runner starts itself on mount. Zero means
  // "not started", and a re-run after a stale plan gets a fresh key rather than a stale panel.
  const [verifyRun, setVerifyRun] = useState(0);
  const [verified, setVerified] = useState(false);
  const [verifySkipped, setVerifySkipped] = useState(false);
  const [verifyRows, setVerifyRows] = useState<BulkResultRow[] | null>(null);
  const [applyRun, setApplyRun] = useState(0);
  const [applied, setApplied] = useState(false);
  const [stale, setStale] = useState<BulkPlanDrift[] | null>(null);

  // The exact body both calls share. The submit endpoint re-plans it server-side, so the plan
  // a reader approved and the batch that runs are provably the same selection.
  const source: Record<string, unknown> | null = useMemo(
    () =>
      repoUrl
        ? {
            git: {
              repo_url: repoUrl,
              ref: branch,
              repository_id: repositoryId,
              paths: [...paths],
            },
          }
        : null,
    // `paths` is a fresh array each render; its content is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoUrl, branch, repositoryId, paths.join('\n')],
  );

  const resetRuns = useCallback(() => {
    setStep('review');
    setRunning(false);
    setVerifyRun(0);
    setVerified(false);
    setVerifySkipped(false);
    setVerifyRows(null);
    setApplyRun(0);
    setApplied(false);
    setStale(null);
  }, []);

  const loadPlan = useCallback(async () => {
    if (!source) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/catalog/import/bulk/plan', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(source),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: BulkPlan;
        error?: string;
      };
      if (!res.ok || json.success === false) {
        throw new Error(typeof json.error === 'string' ? json.error : res.statusText);
      }
      const body = (json.data ?? (json as unknown)) as BulkPlan;
      if (!body || !Array.isArray(body.items)) throw new Error('Invalid plan from server');
      setPlan(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not plan the batch');
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, [source]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects', { credentials: 'include' });
      const json = (await res.json().catch(() => ({}))) as { projects?: unknown };
      if (!res.ok) return;
      setProjects(parseProjects(json.projects));
    } catch {
      // The control still offers "new project" and the row's own match without the list.
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setPlan(null);
      setError(null);
      setChoices({});
      resetRuns();
      return;
    }
    void loadPlan();
    void loadProjects();
  }, [open, loadPlan, loadProjects, resetRuns]);

  /** Re-plan after a stale-plan refusal: the same selection, read again, reviewed again. */
  const replan = () => {
    setChoices({});
    resetRuns();
    void loadPlan();
  };

  const importable = useMemo(() => (plan?.items ?? []).filter((item) => item.importable), [plan]);
  const counts = plan ? batchHeaderCounts(plan, choices) : null;
  const summaryLine = counts ? batchHeaderSummary(counts) : '';
  const policyLine = plan ? batchPolicyLine(plan) : '';
  const excluded = plan ? batchExcludedRows(plan) : [];
  const undecided = plan ? batchUndecidedKeys(plan, choices) : [];
  const planReady = Boolean(plan && importable.length > 0 && !loading && !error);

  const footerState = {
    step,
    planReady,
    running,
    verified,
    verifySkipped,
    applied,
    itemCount: importable.length,
  };
  const footer = batchFooterFor(footerState);

  /** The BLK-1.3 half of the submit body, shared by verify and apply so the two agree. */
  const requestFor = (dryRun: boolean): Record<string, unknown> => {
    const request: Record<string, unknown> = { dry_run: dryRun };
    const overrides = plan ? batchOverridesForRequest(plan, choices) : [];
    if (overrides.length > 0) request.overrides = overrides;
    if (plan?.plan_fingerprint) request.plan_fingerprint = plan.plan_fingerprint;
    return request;
  };

  const startVerify = () => {
    setStale(null);
    setVerified(false);
    setVerifyRows(null);
    setRunning(true);
    setVerifyRun((n) => n + 1);
  };

  const startApply = () => {
    setStale(null);
    setRunning(true);
    setApplyRun((n) => n + 1);
  };

  const onPrimary = () => {
    if (step === 'review') {
      setStep('verify');
      return;
    }
    if (step === 'verify') {
      if (verified || verifySkipped) setStep('apply');
      else startVerify();
      return;
    }
    if (!applied) startApply();
  };

  const onBack = () => {
    if (step === 'verify') setStep('review');
    else if (step === 'apply') setStep('verify');
  };

  const onStalePlan = (drift: BulkPlanDrift[]) => {
    setStale(drift);
    setVerified(false);
    setVerifySkipped(false);
  };

  const stepBody = () => {
    if (!plan) return null;
    if (step === 'review') {
      return (
        <>
          {undecided.length > 0 ? (
            <Alert variant="warn" data-testid="repository-batch-undecided">
              {undecided.length} row{undecided.length === 1 ? '' : 's'} still need
              {undecided.length === 1 ? 's' : ''} a target — the policy in force leaves the
              choice to you. Pick one in the Target column, or the row fails on its own when
              the batch runs.
            </Alert>
          ) : null}

          {plan.truncated ? (
            <Alert variant="warn" data-testid="repository-batch-truncated">
              Only the first {plan.items.length} of {plan.total_items} specs can be imported in
              one batch (limit {plan.max_items}); the rest are listed as excluded.
            </Alert>
          ) : null}

          <div className="repo-det-table-wrap">
            <div className="repo-det-table-scroll">
              <table
                className="repo-det-table repo-batch-table table-density table-dense"
                data-testid="repository-batch-table"
              >
                <thead>
                  <tr>
                    {REVIEW_COLUMNS.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {importable.length === 0 ? (
                    <tr>
                      <td
                        colSpan={REVIEW_COLUMNS.length}
                        className="repo-det-table__state"
                        data-testid="repository-batch-empty"
                      >
                        None of the selected files is the root of an importable spec.
                      </td>
                    </tr>
                  ) : null}
                  {importable.map((item) => {
                    const choice = choices[item.key] ?? BATCH_TARGET_PLAN;
                    const target = batchRowTarget(item, choice, projects);
                    const options = batchTargetOptions(item, projects);
                    const extra = item.members.length - 1;
                    return (
                      <tr
                        key={item.key}
                        data-testid={`repository-batch-row-${item.key}`}
                        data-overridden={target.overridden ? 'true' : undefined}
                      >
                        <td className="repo-batch-table__path">
                          <span className="mono">{item.root_path}</span>
                          {extra > 0 ? (
                            <span className="repo-batch-table__members text-muted">
                              {' '}
                              +{extra} file{extra === 1 ? '' : 's'}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <FormatPill format={item.format ?? undefined} />
                        </td>
                        <td>
                          <Badge
                            variant={TARGET_TONE[target.kind]}
                            data-testid={`repository-batch-resolution-${item.key}`}
                          >
                            {target.kind === 'append' ? (
                              <Layers aria-hidden />
                            ) : (
                              <FolderPlus aria-hidden />
                            )}
                            {target.label}
                          </Badge>
                        </td>
                        <td className="mono repo-det-quiet-cell">
                          {target.version ? (
                            `v${target.version}`
                          ) : (
                            <span title="Decided when the batch is verified">—</span>
                          )}
                        </td>
                        <td className="repo-det-quiet-cell">{target.basis ?? '—'}</td>
                        <td>
                          <select
                            className="hive-control repo-batch-select"
                            aria-label={`Target for ${item.root_path}`}
                            value={choice}
                            onChange={(event) =>
                              setChoices((prev) => ({ ...prev, [item.key]: event.target.value }))
                            }
                            data-testid={`repository-batch-target-${item.key}`}
                          >
                            {options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className="repo-det-note">{BATCH_OVERRIDE_NOTE}</p>

          {excluded.length > 0 ? (
            <section className="repo-batch-excluded" data-testid="repository-batch-excluded">
              <h3 className="repo-det-card__title">
                Excluded ({excluded.length})
              </h3>
              <ul className="repo-batch-excluded__list">
                {excluded.map((row) => (
                  <li key={row.path}>
                    <span className="mono">{row.path}</span>
                    <span className="text-muted"> — {row.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      );
    }

    if (step === 'verify') {
      return (
        <>
          <p className="repo-bulk-note" data-testid="repository-batch-verify-note">
            <ShieldCheck aria-hidden />
            <span>{verifySkipped ? BATCH_VERIFY_SKIPPED_NOTE : BATCH_VERIFY_NOTE}</span>
          </p>
          {stale ? (
            <div className="flex flex-col gap-2" data-testid="repository-batch-stale">
              <p className="repo-det-note">{BATCH_STALE_PLAN_TITLE}</p>
              <div>
                <Button type="button" variant="outline" size="sm" onClick={replan}>
                  <RefreshCw aria-hidden />
                  Re-plan
                </Button>
              </div>
            </div>
          ) : null}
          {verifyRun > 0 && source ? (
            <CatalogBulkImportPanel
              key={`verify-${verifyRun}`}
              plan={plan}
              source={source}
              request={requestFor(true)}
              onFinished={(rows) => {
                setVerifyRows(rows);
                setVerified(true);
              }}
              onSettled={() => setRunning(false)}
              onStalePlan={onStalePlan}
            />
          ) : null}
        </>
      );
    }

    return (
      <>
        <p className="repo-bulk-note" data-testid="repository-batch-apply-note">
          <Layers aria-hidden />
          <span>
            {BATCH_APPLY_NOTE}
            {verifyRows ? (
              <>
                {' '}
                Verify validated {verifyRows.filter((row) => row.state === 'completed').length} of{' '}
                {verifyRows.length}.
              </>
            ) : null}
          </span>
        </p>
        {stale ? (
          <div className="flex flex-col gap-2" data-testid="repository-batch-stale">
            <p className="repo-det-note">{BATCH_STALE_PLAN_TITLE}</p>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={replan}>
                <RefreshCw aria-hidden />
                Re-plan
              </Button>
            </div>
          </div>
        ) : null}
        {applyRun > 0 && source ? (
          <CatalogBulkImportPanel
            key={`apply-${applyRun}`}
            plan={plan}
            source={source}
            request={requestFor(false)}
            onSuccess={onImported}
            onFinished={() => setApplied(true)}
            onSettled={() => setRunning(false)}
            onStalePlan={onStalePlan}
          />
        ) : null}
      </>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `imp-wizard` zeroes the dialog's own padding and hands scrolling to `__body`, so the
          head, steps, body and footer components are the frame here — without them the content
          sits flush against the dialog edge and nothing scrolls. */}
      <DialogContent size="full" className="imp-wizard">
        <ImportWizardHead title={batchImportTitle(paths.length)} description={BATCH_IMPORT_DESCRIPTION} />
        <ImportWizardSteps
          steps={BATCH_IMPORT_STEPS}
          current={step}
          complete={applied}
          label={BATCH_IMPORT_STEPS_LABEL}
        />

        <ImportWizardBody
          className="flex flex-col gap-4"
          data-testid="repository-bulk-import"
          data-step={step}
        >
          <div className="repo-batch-lead">
            <p className="repo-bulk-note">
              <GitBranch aria-hidden />
              <span>
                Reading <span className="mono">{branch}</span> at the commit it points at now,
                plus any document these files reference.
              </span>
            </p>
            {summaryLine ? (
              <p className="repo-batch-summary" data-testid="repository-batch-summary">
                <Layers aria-hidden />
                <span>{summaryLine}</span>
              </p>
            ) : null}
            {policyLine ? (
              <p className="repo-bulk-note" data-testid="repository-batch-policy">
                <ShieldCheck aria-hidden />
                <span>{policyLine}</span>
              </p>
            ) : null}
          </div>

          {!repoUrl ? (
            <Alert variant="warn" data-testid="repository-bulk-no-url">
              This repository has no GitHub web URL recorded, so a batch cannot be read from it.
              Import these files one at a time with Map &amp; import.
            </Alert>
          ) : null}

          {loading ? (
            <>
              <div className="flex flex-col gap-2" aria-hidden>
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
              <p className="repo-bulk-note">
                <Loader2 className="animate-spin" aria-hidden />
                <span>Planning the batch…</span>
              </p>
            </>
          ) : null}

          {error ? (
            <Alert variant="danger" data-testid="repository-bulk-error">
              <div className="flex flex-wrap items-center gap-2">
                <span>{error}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void loadPlan()}>
                  Try again
                </Button>
              </div>
            </Alert>
          ) : null}

          {stepBody()}
        </ImportWizardBody>

        <ImportWizardFooter
          footer={footer}
          onBack={onBack}
          onCancel={() => onOpenChange(false)}
          onPrimary={onPrimary}
          extra={
            batchOffersSkipVerify(footerState) ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setVerifySkipped(true)}
                data-testid="repository-batch-skip-verify"
              >
                Skip verify
              </Button>
            ) : null
          }
        />
      </DialogContent>
    </Dialog>
  );
}

export default RepositoryBulkImportPanel;
