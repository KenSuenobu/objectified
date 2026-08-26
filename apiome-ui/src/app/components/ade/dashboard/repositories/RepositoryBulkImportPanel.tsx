'use client';

/**
 * Import several ticked repository files as one batch (BLK-1.5).
 *
 * The Files tab's *Map & import* wizard maps **one** specification at a time — a version, a
 * project and a set of naming conventions are per-file decisions. That is the right shape for
 * one file and the wrong shape for twelve, and until now ticking twelve rows opened the wizard
 * on the first one and told the reader to "re-select the rest afterward".
 *
 * This is the other shape. It calls the bulk endpoints (MFI-29.5) with the ticked paths on the
 * repository selector, so the server partitions the selection, reconciles each item against the
 * projects the tenant already has (BLK-1.2), and starts one ordinary import job per item.
 *
 * ### Two panes, because a batch is verified before it is run
 *
 * 1. **The plan.** One row per independent spec, leading with what would actually happen to it
 *    — append a version to a project that already exists, or create a new one — and the version
 *    label it would take. Nothing is written to produce this.
 * 2. **The run.** Delegated to {@link CatalogBulkImportPanel}, which is the same submit-and-poll
 *    surface the catalog wizard uses. A batch started here is not a second kind of batch.
 *
 * The panel owns no import logic: it renders what the endpoints return.
 */

import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, GitBranch, Layers, Loader2, Plus } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent } from '@/app/components/ui/Card';
import { Dialog, DialogContent } from '@/app/components/ui/Dialog';
import {
  ImportWizardBody,
  ImportWizardHead,
} from '@/app/components/ade/import/ImportWizardChrome';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { Skeleton } from '@/app/components/ui/Skeleton';
import {
  CatalogBulkImportPanel,
  type BulkPlan,
  type BulkPlanItem,
} from '@/app/components/ade/dashboard/catalog/CatalogBulkImportPanel';

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

/** What a resolution reads as in the plan table. */
const RESOLUTION_COPY: Record<string, { label: string; tone: string; icon: 'append' | 'create' }> =
  {
    'append-version': {
      label: 'New version',
      tone: 'border-ok bg-ok-soft text-ok-fg',
      icon: 'append',
    },
    'create-project': {
      label: 'New project',
      tone: 'border-border bg-subtle text-fg',
      icon: 'create',
    },
    unresolved: {
      label: 'Needs a choice',
      tone: 'border-warn bg-warn-soft text-warn-fg',
      icon: 'create',
    },
  };

/** Human copy for each match basis, so the table explains itself rather than asserting. */
const BASIS_COPY: Record<string, string> = {
  'repository-provenance': 'imported from this path before',
  slug: 'an existing project uses this slug',
  'spec-identity': 'an existing project has this title',
};

/**
 * The one-line summary a reader leads with: how many items, and what would happen to them.
 *
 * @param plan The fetched plan.
 * @returns The sentence, or `''` when the server returned no reconciliation counts.
 */
export function bulkPlanSummaryLine(plan: BulkPlan): string {
  const counts = plan.summary?.by_resolution;
  if (!counts || Object.keys(counts).length === 0) return '';
  const parts: string[] = [];
  const append = counts['append-version'] ?? 0;
  const create = counts['create-project'] ?? 0;
  const unresolved = counts['unresolved'] ?? 0;
  if (append) parts.push(`${append} new version${append === 1 ? '' : 's'}`);
  if (create) parts.push(`${create} new project${create === 1 ? '' : 's'}`);
  if (unresolved) parts.push(`${unresolved} needing a choice`);
  if (parts.length === 0) return '';
  return `${plan.summary.items} spec${plan.summary.items === 1 ? '' : 's'} · ${parts.join(' · ')}`;
}

/** The row's destination cell: the project it lands in, or that it makes a new one. */
function DestinationCell({ item }: { item: BulkPlanItem }) {
  const matched = item.matched_project;
  if (!matched) {
    return (
      <span className="repo-bulk-row__target">
        <FolderPlus aria-hidden />
        <span className="mono">{item.suggested_slug}</span>
      </span>
    );
  }
  return (
    <span className="repo-bulk-row__target">
      <Layers aria-hidden />
      <span>{matched.name}</span>
      <span className="mono text-muted">({matched.slug})</span>
    </span>
  );
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
  const [running, setRunning] = useState(false);

  // The exact body both calls share. The submit endpoint re-plans it server-side, so the plan
  // a reader approved and the batch that runs are provably the same selection.
  const source: Record<string, unknown> | null = repoUrl
    ? {
        git: {
          repo_url: repoUrl,
          ref: branch,
          repository_id: repositoryId,
          paths: [...paths],
        },
      }
    : null;

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
    // `source` is rebuilt each render; the identity that matters is what it is built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId, repoUrl, branch, paths.join('\n')]);

  useEffect(() => {
    if (!open) {
      setPlan(null);
      setRunning(false);
      setError(null);
      return;
    }
    void loadPlan();
  }, [open, loadPlan]);

  const notRoots = (plan?.skipped ?? []).filter((entry) => entry.reason === NOT_AN_ITEM_ROOT);
  const summaryLine = plan ? bulkPlanSummaryLine(plan) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `imp-wizard` zeroes the dialog's own padding and hands scrolling to `__body`, so the
          head and body components are not decoration here — without them the content sits
          flush against the dialog edge and nothing scrolls. */}
      <DialogContent size="full" className="imp-wizard">
        <ImportWizardHead
          title={`Import ${paths.length} selected file${paths.length === 1 ? '' : 's'}`}
          description="Each specification becomes its own import job, so one failure never costs you the rest."
        />

        <ImportWizardBody
          className="flex flex-col gap-4"
          data-testid="repository-bulk-import"
        >
          <p className="repo-bulk-note">
            <GitBranch aria-hidden />
            <span>
              Reading <span className="mono">{branch}</span> at the commit it points at now,
              plus any document these files reference.
            </span>
          </p>

          {!repoUrl ? (
            <Alert variant="warn" data-testid="repository-bulk-no-url">
              This repository has no GitHub web URL recorded, so a batch cannot be read from it.
              Import these files one at a time with Map &amp; import.
            </Alert>
          ) : null}

          {loading ? (
            <div className="flex flex-col gap-2" aria-hidden>
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          ) : null}

          {error ? (
            <Alert variant="danger" data-testid="repository-bulk-error">
              {error}
            </Alert>
          ) : null}

          {plan && !running ? (
            <>
              {summaryLine ? (
                <p className="repo-bulk-note" data-testid="repository-bulk-summary">
                  <Layers aria-hidden />
                  <span>
                    {summaryLine}
                    {plan.version_policy && plan.version_policy !== 'append-when-matched' ? (
                      <span className="text-muted">
                        {' '}
                        · policy <span className="mono">{plan.version_policy}</span>
                      </span>
                    ) : null}
                  </span>
                </p>
              ) : null}

              {notRoots.length > 0 ? (
                <Alert variant="info" data-testid="repository-bulk-not-roots">
                  {notRoots.length} selected file{notRoots.length === 1 ? '' : 's'} already
                  compile into another spec here, so{' '}
                  {notRoots.length === 1 ? 'it is' : 'they are'} imported as part of it rather
                  than on {notRoots.length === 1 ? 'its' : 'their'} own:{' '}
                  <span className="mono">{notRoots.map((e) => e.path).join(', ')}</span>
                </Alert>
              ) : null}

              <Card variant="flat">
                <CardContent className="flex flex-col gap-2">
                  {plan.items.length === 0 ? (
                    <p className="repo-det-note">
                      None of the selected files is the root of an importable spec.
                    </p>
                  ) : (
                    plan.items.map((item) => {
                      const copy = RESOLUTION_COPY[item.resolution ?? 'create-project'];
                      return (
                        <div
                          key={item.key}
                          className="repo-bulk-row"
                          data-testid={`repository-bulk-row-${item.key}`}
                        >
                          <span className="repo-bulk-row__path mono truncate">
                            {item.root_path}
                          </span>
                          <FormatPill format={item.format ?? undefined} />
                          <Badge className={copy?.tone}>
                            {copy?.icon === 'append' ? <Layers aria-hidden /> : <Plus aria-hidden />}
                            {copy?.label ?? 'New project'}
                          </Badge>
                          <DestinationCell item={item} />
                          {item.proposed_version ? (
                            <span className="mono repo-bulk-row__version">
                              v{item.proposed_version.version_id}
                            </span>
                          ) : null}
                          {item.match_basis ? (
                            <span className="repo-bulk-row__why text-muted">
                              {BASIS_COPY[item.match_basis] ?? item.match_basis}
                            </span>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={plan.items.length === 0}
                  onClick={() => setRunning(true)}
                  data-testid="repository-bulk-start"
                >
                  <Layers aria-hidden />
                  Import {plan.items.length} spec{plan.items.length === 1 ? '' : 's'}
                </Button>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : null}

          {plan && running && source ? (
            <CatalogBulkImportPanel plan={plan} source={source} onSuccess={onImported} />
          ) : null}

          {loading ? (
            <p className="repo-bulk-note">
              <Loader2 className="animate-spin" aria-hidden />
              <span>Planning the batch…</span>
            </p>
          ) : null}
        </ImportWizardBody>
      </DialogContent>
    </Dialog>
  );
}

export default RepositoryBulkImportPanel;
