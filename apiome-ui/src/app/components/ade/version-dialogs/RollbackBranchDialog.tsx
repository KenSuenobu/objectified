'use client';

/**
 * Rollback a branch tip to an earlier revision (revert-style — creates a new revision
 * whose schema matches the target snapshot; history is not rewritten).
 *
 * Self-contained: fetches branches on open, runs preview + apply against
 *   /api/projects/{projectId}/version-branches/rollback-preview
 *   /api/projects/{projectId}/version-branches/rollback
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '../../ui/Dialog';
import { Alert } from '../../ui/Alert';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Label } from '../../ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/Select';
import { CompatibilityReportPanel } from '../dashboard/CompatibilityReportPanel';
import { Undo2 } from 'lucide-react';
import { Checkbox } from '../../ui/Checkbox';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import { VERSION_DIALOG_COPY } from './versionDialogsModel';
import type { DialogRevisionRef, VersionBranchRow } from './types';

interface RollbackPreview {
  branchTipRevisionId?: string;
  compatOverall?: string;
  findings?: Array<{ id?: string; rule?: string; path?: string; message?: string; category?: string }>;
  deprecationWarnings?: unknown[];
  rollbackBlockedByCompatGate?: boolean;
  breakingChangeDocumentationIssueUrl?: string | null;
}

export interface RollbackBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The revision whose snapshot will be restored onto the chosen branch. */
  targetRevision: DialogRevisionRef | null;
  /** Pre-select a branch when the caller knows it. */
  initialBranchName?: string;
  onRolledBack?: (result: { version?: { id?: string; version_id?: string } }) => void;
}

export function RollbackBranchDialog({
  open,
  onOpenChange,
  projectId,
  targetRevision,
  initialBranchName,
  onRolledBack,
}: RollbackBranchDialogProps) {
  const [branches, setBranches] = useState<VersionBranchRow[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [shortMessage, setShortMessage] = useState('');
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [skipCompat, setSkipCompat] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setBranchName('');
      setShortMessage('');
      setPreview(null);
      setSkipCompat(false);
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
          const initial = initialBranchName && d.branches.some((b) => b.name === initialBranchName)
            ? initialBranchName
            : d.branches[0]?.name ?? '';
          setBranchName(initial);
        }
      } catch {
        /* quiet — the preview call will surface a clear error if needed */
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, projectId, initialBranchName]);

  const runPreview = async () => {
    if (!projectId || !targetRevision?.id || !branchName.trim()) {
      toast.warning('Choose a branch');
      return;
    }
    setPreviewLoading(true);
    setPreview(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/version-branches/rollback-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchName: branchName.trim(), targetRevisionId: targetRevision.id }),
      });
      const d = await r.json();
      if (d.success) {
        setPreview({
          branchTipRevisionId: typeof d.branchTipRevisionId === 'string' ? d.branchTipRevisionId : undefined,
          compatOverall: typeof d.compatOverall === 'string' ? d.compatOverall : undefined,
          findings: Array.isArray(d.findings) ? d.findings : [],
          deprecationWarnings: Array.isArray(d.deprecationWarnings) ? d.deprecationWarnings : [],
          rollbackBlockedByCompatGate: Boolean(d.rollbackBlockedByCompatGate),
          breakingChangeDocumentationIssueUrl:
            typeof d.breakingChangeDocumentationIssueUrl === 'string'
              ? d.breakingChangeDocumentationIssueUrl
              : null,
        });
        setSkipCompat(false);
      } else {
        const msg =
          typeof d.detail === 'string'
            ? d.detail
            : typeof d.error === 'string'
              ? d.error
              : 'Preview failed';
        toast.error(msg);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const runApply = async () => {
    if (!projectId || !targetRevision?.id || !branchName.trim() || !preview?.branchTipRevisionId) {
      toast.warning('Run preview first');
      return;
    }
    const overall = preview.compatOverall ?? 'unknown';
    if (preview.rollbackBlockedByCompatGate) {
      toast.error('Project policy blocks rollback when compatibility is not safe');
      return;
    }
    if (overall !== 'safe' && !skipCompat) {
      toast.warning('Acknowledge compatibility risk using the checkbox below');
      return;
    }
    setApplyLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/version-branches/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchName: branchName.trim(),
          targetRevisionId: targetRevision.id,
          baseRevisionId: preview.branchTipRevisionId,
          skipCompatWarning: overall !== 'safe',
          ...(shortMessage.trim() ? { shortMessage: shortMessage.trim() } : {}),
        }),
      });
      const d = await r.json();
      if (d.success) {
        toast.success(`Rollback complete — new revision v${d.version?.version_id ?? ''}`);
        onOpenChange(false);
        onRolledBack?.({ version: d.version });
      } else {
        const err = d.detail;
        const msg =
          typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message?: string }).message)
            : typeof d.error === 'string'
              ? d.error
              : 'Rollback failed';
        toast.error(msg);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rollback failed');
    } finally {
      setApplyLoading(false);
    }
  };

  const targetLabel = targetRevision?.version_id
    ? `v${targetRevision.version_id}`
    : targetRevision?.id ?? '—';

  const applyDisabled =
    applyLoading ||
    previewLoading ||
    !preview?.branchTipRevisionId ||
    preview.rollbackBlockedByCompatGate === true ||
    ((preview.compatOverall ?? 'unknown') !== 'safe' && !skipCompat);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!previewLoading && !applyLoading) onOpenChange(o);
      }}
    >
      <DialogContent className="vdlg-dialog vdlg-dialog--lg" aria-describedby={undefined}>
        <VersionDialogHead
          icon={<Undo2 aria-hidden />}
          tone="danger"
          title="Rollback branch (revert-style)"
          description={
            <>
              Creates a <strong>new</strong> revision whose schema matches revision{' '}
              <span className="mono">{targetLabel}</span>; the branch tip moves forward with{' '}
              <span className="mono">parent</span> pointing at the prior head. History is not rewritten.
            </>
          }
        />
        <div className="vdlg-form">
          {branches.length === 0 && !branchesLoading ? (
            <Alert variant="warn">{VERSION_DIALOG_COPY.rollbackNoBranches}</Alert>
          ) : null}
          <div className="vdlg-field">
            <Label>Branch to update</Label>
            <Select
              value={branchName || '__pick__'}
              onValueChange={(v) => setBranchName(v === '__pick__' ? '' : v)}
              disabled={branchesLoading || branches.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder={branchesLoading ? 'Loading branches…' : 'Choose branch'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__pick__">Choose branch</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={`rb-${b.id}`} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="vdlg-field">
            <Label htmlFor="canvas-rollback-msg">Revision note (optional)</Label>
            <Input
              id="canvas-rollback-msg"
              value={shortMessage}
              onChange={(e) => setShortMessage(e.target.value)}
              placeholder="Defaults to a rollback summary"
              autoComplete="off"
            />
          </div>

          {preview && (
            <Alert
              variant={
                preview.compatOverall === 'safe'
                  ? 'ok'
                  : preview.compatOverall === 'unknown'
                    ? 'neutral'
                    : 'danger'
              }
            >
              <span className="vdlg-alert__title">
                Schema impact (current tip → restored content): {preview.compatOverall ?? '—'}
              </span>
              <p className="vdlg-alert__note">Rolling back can remove paths or fields consumers rely on.</p>
              <div className="vdlg-alert__body">
                <CompatibilityReportPanel
                  findings={(preview.findings ?? []).map((f) => ({
                    id: f.id,
                    category: f.category,
                    rule: f.rule ?? '—',
                    path: f.path ?? '',
                    message: f.message ?? '',
                  }))}
                  docUrl={preview.breakingChangeDocumentationIssueUrl ?? undefined}
                />
              </div>
            </Alert>
          )}

          {preview?.rollbackBlockedByCompatGate ? (
            <Alert variant="warn" className="vdlg-note">
              Project metadata sets <span className="mono">compatGateOnRollback</span> — apply is blocked until the
              rollback pair is safe or policy is updated.
            </Alert>
          ) : null}

          {preview && preview.compatOverall && preview.compatOverall !== 'safe' ? (
            <label className="vdlg-check">
              <Checkbox checked={skipCompat} onCheckedChange={(v) => setSkipCompat(v === true)} />
              I understand the compatibility risk — apply anyway
            </label>
          ) : null}
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
            disabled={
              previewLoading ||
              applyLoading ||
              !branchName ||
              !targetRevision?.id ||
              branches.length === 0
            }
          >
            {previewLoading ? 'Previewing…' : 'Preview rollback'}
          </Button>
          <Button onClick={runApply} disabled={applyDisabled}>
            {applyLoading ? 'Rolling back…' : 'Apply rollback'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RollbackBranchDialog;
