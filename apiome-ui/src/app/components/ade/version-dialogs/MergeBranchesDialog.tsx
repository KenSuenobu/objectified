'use client';

/**
 * Merge two named branches (three-way) with preview + conflict resolution + compat gate.
 *
 * Self-contained: fetches branches on open, runs preview / apply against
 *   /api/projects/{projectId}/version-branches/merge-preview
 *   /api/projects/{projectId}/version-branches/merge
 * Mirrors the dashboard's merge dialog feature set so canvas users don't have to switch
 * to the dashboard for conflict resolution or the tenant-admin compat-gate override.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '../../ui/Dialog';
import { Alert } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Label } from '../../ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/Select';
import { Textarea } from '../../ui/Textarea';
import {
  normalizeMergeConflictRows,
  type MergeConflictResolutionChoice,
} from '@lib/version-merge';
import { VersionMergeConflictList } from '../dashboard/VersionMergeConflictList';
import { CompatibilityReportPanel } from '../dashboard/CompatibilityReportPanel';
import { ExternalCompatEvidencePanel } from '../dashboard/ExternalCompatEvidencePanel';
import { GitMerge, Loader2 } from 'lucide-react';
import { Checkbox } from '../../ui/Checkbox';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import type { VersionBranchRow } from './types';

interface MergePreviewClassification {
  canAutoMerge: boolean;
  conflictPaths: string[];
  addedSchemaNames?: string[];
}

interface MergePreviewData {
  classification?: MergePreviewClassification;
  sourceTipVersionId?: string;
  targetTipVersionId?: string;
  mergeBaseVersionId?: string | null;
  conflicts?: Array<{ path: string; kinds: string[] }>;
  previewSourceBranch?: string;
  previewTargetBranch?: string;
}

import type { CompatibilityFindingRow } from '@lib/compatibility-report-group';

interface CompatState {
  overall: string;
  findings: CompatibilityFindingRow[];
  breakingChangeDocumentationIssueUrl: string | null;
  tenantCompatGateActive: boolean;
  mergeBlockedByCompatGate: boolean;
  ruleHits?: Record<string, number>;
}

export interface MergeBranchesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Pre-select a source branch when the caller knows it (e.g. the current canvas branch). */
  initialSourceBranch?: string;
  initialTargetBranch?: string;
  /** Session is a tenant admin → enables the compat-gate override control. */
  isTenantAdmin?: boolean;
  /** Fired on successful merge so parent can reload its revision list / switch selection. */
  onMerged?: (result: { version?: { id?: string; version_id?: string } }) => void;
}

export function MergeBranchesDialog({
  open,
  onOpenChange,
  projectId,
  initialSourceBranch,
  initialTargetBranch,
  isTenantAdmin = false,
  onMerged,
}: MergeBranchesDialogProps) {
  const [branches, setBranches] = useState<VersionBranchRow[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [sourceBranch, setSourceBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState('');

  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [previewData, setPreviewData] = useState<MergePreviewData | null>(null);
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, MergeConflictResolutionChoice | null>
  >({});

  const [compat, setCompat] = useState<CompatState | null>(null);
  const [compatLoading, setCompatLoading] = useState(false);
  const [compatGateOverride, setCompatGateOverride] = useState(false);
  const [compatGateOverrideReason, setCompatGateOverrideReason] = useState('');

  useEffect(() => {
    if (!open) {
      setSourceBranch('');
      setTargetBranch('');
      setPreviewData(null);
      setConflictResolutions({});
      setCompat(null);
      setCompatGateOverride(false);
      setCompatGateOverrideReason('');
      setPreviewLoading(false);
      setApplyLoading(false);
      return;
    }
    if (!projectId) return;

    let cancelled = false;
    setBranchesLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/projects/${projectId}/version-branches`);
        if (cancelled) return;
        const d = (await r.json()) as { success?: boolean; branches?: VersionBranchRow[] };
        if (d.success && Array.isArray(d.branches)) {
          setBranches(d.branches);
          const src = initialSourceBranch && d.branches.some((b) => b.name === initialSourceBranch)
            ? initialSourceBranch
            : '';
          const tgt = initialTargetBranch && d.branches.some((b) => b.name === initialTargetBranch)
            ? initialTargetBranch
            : '';
          setSourceBranch(src);
          setTargetBranch(tgt);
        }
      } catch {
        /* toasts handled in preview/apply */
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, projectId, initialSourceBranch, initialTargetBranch]);

  const previewMatchesSelection =
    !!previewData?.previewSourceBranch &&
    !!previewData?.previewTargetBranch &&
    previewData.previewSourceBranch === sourceBranch.trim() &&
    previewData.previewTargetBranch === targetBranch.trim();

  const conflictRows = useMemo(
    () =>
      previewData
        ? normalizeMergeConflictRows(
            Array.isArray(previewData.conflicts) ? previewData.conflicts : [],
            Array.isArray(previewData.classification?.conflictPaths)
              ? (previewData.classification?.conflictPaths ?? [])
              : []
          )
        : [],
    [previewData]
  );

  const hasEngineConflicts =
    !!previewData?.classification && !previewData.classification.canAutoMerge;

  const handleResolve = useCallback((path: string, choice: MergeConflictResolutionChoice) => {
    setConflictResolutions((prev) => ({ ...prev, [path]: choice }));
  }, []);

  const handleBulkResolve = useCallback((paths: string[], choice: MergeConflictResolutionChoice) => {
    setConflictResolutions((prev) => {
      const next = { ...prev };
      for (const p of paths) next[p] = choice;
      return next;
    });
  }, []);

  const runPreview = async () => {
    if (!projectId || !sourceBranch.trim() || !targetBranch.trim()) {
      toast.warning('Select source and target branches');
      return;
    }
    if (sourceBranch.trim() === targetBranch.trim()) {
      toast.warning('Source and target must be different branches');
      return;
    }
    setPreviewLoading(true);
    setPreviewData(null);
    setConflictResolutions({});
    setCompat(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/version-branches/merge-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceBranchName: sourceBranch.trim(),
          targetBranchName: targetBranch.trim(),
        }),
      });
      const d = await r.json();
      if (d.success) {
        setPreviewData({
          classification: d.classification,
          sourceTipVersionId: d.sourceTipVersionId,
          targetTipVersionId: d.targetTipVersionId,
          mergeBaseVersionId: d.mergeBaseVersionId ?? null,
          conflicts: Array.isArray(d.conflicts) ? d.conflicts : undefined,
          previewSourceBranch: sourceBranch.trim(),
          previewTargetBranch: targetBranch.trim(),
        });
        if (!d.classification?.canAutoMerge) {
          toast.info('Conflicts detected — choose a resolution for every path before applying.');
        }

        const tgtTip = typeof d.targetTipVersionId === 'string' ? d.targetTipVersionId : '';
        const srcTip = typeof d.sourceTipVersionId === 'string' ? d.sourceTipVersionId : '';
        if (tgtTip && srcTip) {
          setCompatLoading(true);
          try {
            const cr = await fetch(`/api/projects/${projectId}/compatibility`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ baseRevisionId: tgtTip, headRevisionId: srcTip }),
            });
            const cd = await cr.json();
            if (cr.ok && cd.success === true && typeof cd.overall === 'string') {
              setCompat({
                overall: cd.overall,
                findings: Array.isArray(cd.findings) ? (cd.findings as CompatibilityFindingRow[]) : [],
                breakingChangeDocumentationIssueUrl: cd.breakingChangeDocumentationIssueUrl ?? null,
                tenantCompatGateActive: Boolean(cd.tenantCompatGateActive),
                mergeBlockedByCompatGate: Boolean(cd.mergeBlockedByCompatGate),
                ruleHits:
                  cd.ruleHits && typeof cd.ruleHits === 'object' && !Array.isArray(cd.ruleHits)
                    ? (cd.ruleHits as Record<string, number>)
                    : undefined,
              });
            }
          } catch {
            /* compat is informational */
          } finally {
            setCompatLoading(false);
          }
        }
      } else {
        toast.error(typeof d.error === 'string' ? d.error : 'Preview failed');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const runApply = async () => {
    if (!projectId || !sourceBranch.trim() || !targetBranch.trim()) {
      toast.warning('Select source and target branches');
      return;
    }
    if (!previewMatchesSelection) {
      toast.warning('Run Preview for the current source and target branches before applying.');
      return;
    }
    if (hasEngineConflicts) {
      toast.warning('Resolve conflicts before applying.');
      return;
    }
    const target = branches.find((b) => b.name === targetBranch.trim());
    if (!target) {
      toast.error('Target branch not found — refresh branches');
      return;
    }
    const override =
      Boolean(compat?.mergeBlockedByCompatGate) &&
      isTenantAdmin &&
      compatGateOverride &&
      compatGateOverrideReason.trim().length > 0;

    setApplyLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/version-branches/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceBranchName: sourceBranch.trim(),
          targetBranchName: targetBranch.trim(),
          baseRevisionId: target.tip_version_id,
          ...(override
            ? {
                skipCompatGate: true,
                compatGateOverrideReason: compatGateOverrideReason.trim(),
              }
            : {}),
        }),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(`Merged into ${targetBranch.trim()} — new version ${d.version?.version_id ?? ''}`);
        onOpenChange(false);
        onMerged?.({ version: d.version });
      } else {
        const err = typeof d.detail === 'object' && d.detail !== null ? d.detail : d;
        const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: string }).code : undefined;
        const conflictPaths =
          typeof err === 'object' && err && 'conflictPaths' in err
            ? (err as { conflictPaths?: string[] }).conflictPaths
            : undefined;
        const unresolvedCount =
          typeof err === 'object' && err && 'unresolvedCount' in err
            ? Number((err as { unresolvedCount?: unknown }).unresolvedCount)
            : NaN;
        const n = Number.isFinite(unresolvedCount) && unresolvedCount >= 0 ? unresolvedCount : conflictPaths?.length ?? 0;
        if (
          r.status === 409 &&
          (code === 'MERGE_CONFLICT' || code === 'MERGE_UNRESOLVED_CONFLICTS' || code === 'MERGE_BLEND')
        ) {
          toast.error(
            n > 0
              ? `Merge blocked: ${n} unresolved conflict(s). Resolve all conflicts before applying.`
              : 'Merge blocked: unresolved conflicts.'
          );
          const paths = conflictPaths ?? [];
          setPreviewData((prev) => ({
            ...(prev ?? {}),
            classification: {
              canAutoMerge: false,
              conflictPaths: paths,
              addedSchemaNames: prev?.classification?.addedSchemaNames ?? [],
            },
            conflicts: paths.map((p) => ({ path: p, kinds: ['twoWay'] })),
            previewSourceBranch: prev?.previewSourceBranch ?? sourceBranch.trim(),
            previewTargetBranch: prev?.previewTargetBranch ?? targetBranch.trim(),
          }));
        } else {
          const msg =
            typeof err === 'object' && err && 'message' in err
              ? String((err as { message?: string }).message)
              : typeof d.error === 'string'
                ? d.error
                : 'Merge failed';
          toast.error(msg);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Merge failed');
    } finally {
      setApplyLoading(false);
    }
  };

  const applyDisabled =
    applyLoading ||
    previewLoading ||
    compatLoading ||
    !sourceBranch ||
    !targetBranch ||
    !previewMatchesSelection ||
    hasEngineConflicts ||
    (compat?.mergeBlockedByCompatGate === true &&
      !(isTenantAdmin && compatGateOverride && compatGateOverrideReason.trim().length > 0));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!previewLoading && !applyLoading) onOpenChange(o);
      }}
    >
      <DialogContent className="vdlg-dialog vdlg-dialog--lg" aria-describedby={undefined}>
        <VersionDialogHead
          icon={<GitMerge aria-hidden />}
          tone="violet"
          title="Merge branches"
          description="Preview uses a three-way merge of OpenAPI components against the merge-base (LCA) revision. Run Preview before Apply — when conflicts exist, choose a resolution for every path before applying."
        />
        <div className="vdlg-form">
          <div className="vdlg-field">
            <Label>Source branch</Label>
            <Select
              value={sourceBranch || '__pick__'}
              onValueChange={(v) => setSourceBranch(v === '__pick__' ? '' : v)}
              disabled={branchesLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={branchesLoading ? 'Loading branches…' : 'Choose branch'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__pick__">Choose branch</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="vdlg-field">
            <Label>Target branch</Label>
            <Select
              value={targetBranch || '__pick__'}
              onValueChange={(v) => setTargetBranch(v === '__pick__' ? '' : v)}
              disabled={branchesLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={branchesLoading ? 'Loading branches…' : 'Choose branch'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__pick__">Choose branch</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={`t-${b.id}`} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {previewData?.classification && (
            <Alert variant={previewData.classification.canAutoMerge ? 'ok' : 'danger'}>
              {previewData.classification.canAutoMerge
                ? 'No overlapping modified or removed paths — apply is allowed if the target tip has not moved.'
                : `Conflicts: ${previewData.classification.conflictPaths.length} path(s). Apply stays disabled until every conflict row has a resolution (mine / theirs / manual).`}
            </Alert>
          )}

          {previewData?.classification && !previewData.classification.canAutoMerge && conflictRows.length > 0 && (
            <VersionMergeConflictList
              conflicts={conflictRows}
              targetBranchName={targetBranch.trim()}
              sourceBranchName={sourceBranch.trim()}
              resolutions={conflictResolutions}
              onResolve={handleResolve}
              onBulkResolve={handleBulkResolve}
            />
          )}

          {previewData?.mergeBaseVersionId != null && previewData?.classification && (
            <p className="vdlg-quiet">
              Merge-base revision: <span className="mono">{previewData.mergeBaseVersionId}</span>
            </p>
          )}

          {compatLoading && (
            <p className="vdlg-loading-row" role="status">
              <Loader2 className="animate-spin" aria-hidden />
              Checking backward compatibility (target tip → source tip)…
            </p>
          )}

          {compat && !compatLoading && (
            <Alert
              variant={
                compat.overall === 'safe' ? 'ok' : compat.overall === 'unknown' ? 'neutral' : 'danger'
              }
            >
              <span className="vdlg-alert__title">Backward compatibility (target tip → source tip)</span>
              <div className="vdlg-alert__body">
                <CompatibilityReportPanel
                  overall={compat.overall}
                  findings={compat.findings}
                  ruleHits={compat.ruleHits}
                  docUrl={compat.breakingChangeDocumentationIssueUrl ?? undefined}
                  intro={
                    <span>
                      Compares generated OpenAPI for <strong>target tip</strong> (base) vs <strong>source tip</strong>{' '}
                      (head). Merge execution uses the three-way engine plus an optional project compatibility gate on
                      the merged result.
                    </span>
                  }
                />
                <div className="vdlg-alert__section">
                  <ExternalCompatEvidencePanel
                    projectId={projectId}
                    baseRevisionId={previewData?.targetTipVersionId}
                    headRevisionId={previewData?.sourceTipVersionId}
                  />
                </div>
              </div>
              {compat.mergeBlockedByCompatGate && (
                <p className="vdlg-alert__note">
                  Project metadata enables compat gating — merge is blocked until compatibility is safe, unless a tenant
                  administrator overrides with a written justification (recorded in the workflow audit log).
                </p>
              )}
              {compat.mergeBlockedByCompatGate && isTenantAdmin ? (
                <div className="vdlg-alert__section">
                  <label className="vdlg-check vdlg-check--top">
                    <Checkbox
                      checked={compatGateOverride}
                      onCheckedChange={(checked) => {
                        const next = checked === true;
                        setCompatGateOverride(next);
                        if (!next) setCompatGateOverrideReason('');
                      }}
                    />
                    <span>
                      Override compatibility gate (tenant admin) — required when the gate blocks merge due to unsafe
                      target/source pair analysis
                    </span>
                  </label>
                  {compatGateOverride ? (
                    <div className="vdlg-field">
                      <Label htmlFor="canvas-merge-compat-reason">Justification *</Label>
                      <Textarea
                        id="canvas-merge-compat-reason"
                        value={compatGateOverrideReason}
                        onChange={(e) => setCompatGateOverrideReason(e.target.value)}
                        rows={3}
                        placeholder="Explain why merge should proceed despite the compatibility gate (audit record)"
                        className="vdlg-textarea"
                        aria-invalid={compatGateOverride && compatGateOverrideReason.trim().length === 0}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={previewLoading || applyLoading}
          >
            Close
          </Button>
          <Button
            variant="secondary"
            onClick={runPreview}
            disabled={previewLoading || applyLoading || !sourceBranch || !targetBranch}
          >
            {previewLoading ? 'Previewing…' : 'Preview merge'}
          </Button>
          <Button onClick={runApply} disabled={applyDisabled}>
            {applyLoading ? 'Merging…' : 'Apply merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default MergeBranchesDialog;
