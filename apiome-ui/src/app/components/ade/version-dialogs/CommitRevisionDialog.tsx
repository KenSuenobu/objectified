'use client';

/**
 * Commit a new revision (git-style commit) from the canvas or dashboard.
 *
 * Self-contained: fetches branch list on open, picks base revision (= branch tip),
 * posts to /api/versions. On 409 STALE_HEAD surfaces the PushConflict banner via
 * the optional `onStaleHead` callback so the caller can route through its existing
 * PushConflictBannerProvider plumbing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Label } from '../../ui/Label';
import { Textarea } from '../../ui/Textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/Select';
import { Alert } from '../../ui/Alert';
import {
  COMMIT_EXTERNAL_REF_MAX_CHARS,
  validateVersionNotesClient,
} from '@lib/version-notes';
import { sortBranchesForPicker } from '@lib/studio-branch-resolve';
import { parseStaleHeadFromVersionsPostJson } from '@/app/utils/push-conflict';
import { GitCommitHorizontal } from 'lucide-react';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import type { VersionBranchRow, CreatedRevisionResult, DialogRevisionRef } from './types';

type BumpStrategy = 'patch' | 'minor' | 'major';

/**
 * Multi-branch commit UI: show the branch dropdown when there is more than one branch and there is no
 * **valid** studio lock (#2724 GLI-05). Invalid locks fall back to the picker.
 */
export function commitRevisionDialogShowsBranchPicker(
  lockedBranchId: string | null | undefined,
  branches: Array<{ id: string }>
): boolean {
  if (branches.length <= 1) return false;
  const lock = String(lockedBranchId ?? '').trim();
  if (!lock) return true;
  return !branches.some((b) => b.id === lock);
}

export interface CommitRevisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Current canvas revision (used as fallback base when no named branches exist). */
  currentRevision: DialogRevisionRef | null;
  /**
   * When set, commit targets this branch tip and the branch dropdown is hidden (canvas toolbar / #2724).
   */
  lockedBranchId?: string | null;
  /**
   * Branch the user has checked out in the studio (when known). Used to default the branch picker and
   * label the current branch — same as committing on that branch in git.
   */
  studioSelectedBranchId?: string | null;
  onCreated?: (result: CreatedRevisionResult) => void;
  /**
   * Fired on 409 STALE_HEAD so the caller can hydrate the shared PushConflictBanner.
   * The dialog already surfaces a toast, so this is purely for the sticky banner.
   */
  onStaleHead?: (info: {
    message?: string;
    currentHeadRevisionId?: string;
    currentHead?: {
      revisionId?: string;
      versionId?: string;
      shortMessage?: string | null;
      createdAt?: string | null;
    } | null;
  }) => void;
}

export function CommitRevisionDialog({
  open,
  onOpenChange,
  projectId,
  currentRevision,
  lockedBranchId,
  studioSelectedBranchId,
  onCreated,
  onStaleHead,
}: CommitRevisionDialogProps) {
  const [branches, setBranches] = useState<VersionBranchRow[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const [selectedBranchId, setSelectedBranchId] = useState<string>('');
  const [shortMessage, setShortMessage] = useState('');
  const [changelog, setChangelog] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [bumpStrategy, setBumpStrategy] = useState<BumpStrategy>('patch');

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setShortMessage('');
      setChangelog('');
      setExternalRef('');
      setBumpStrategy('patch');
      setSelectedBranchId('');
      setErrorMessage(null);
      setSubmitting(false);
      setBranchError(null);
      return;
    }
    if (!projectId) return;

    let cancelled = false;
    setBranchesLoading(true);
    setBranchError(null);
    (async () => {
      try {
        const r = await fetch(`/api/projects/${projectId}/version-branches`);
        if (cancelled) return;
        const d = (await r.json()) as { success?: boolean; branches?: VersionBranchRow[]; error?: string };
        if (d.success && Array.isArray(d.branches)) {
          setBranches(d.branches);
          const lock = String(lockedBranchId ?? '').trim();
          if (d.branches.length === 1) {
            setSelectedBranchId(d.branches[0].id);
          } else if (d.branches.length > 1) {
            if (lock && d.branches.some((b) => b.id === lock)) {
              setSelectedBranchId(lock);
            } else {
              const studio = String(studioSelectedBranchId ?? '').trim();
              const studioOk = Boolean(studio && d.branches.some((b) => b.id === studio));
              const matchingTip = d.branches.find(
                (b) => b.tip_version_id && b.tip_version_id === currentRevision?.id
              );
              setSelectedBranchId((studioOk ? studio : matchingTip?.id) ?? '');
            }
          }
        } else {
          setBranchError(typeof d.error === 'string' ? d.error : 'Could not load branches');
        }
      } catch {
        if (!cancelled) setBranchError('Could not load branches');
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, projectId, currentRevision?.id, lockedBranchId, studioSelectedBranchId]);

  const branchesForSelect = useMemo(() => {
    const sorted = sortBranchesForPicker(branches);
    const sid = String(studioSelectedBranchId ?? '').trim();
    if (!sid) return sorted;
    const cur = sorted.find((b) => b.id === sid);
    if (!cur) return sorted;
    return [cur, ...sorted.filter((b) => b.id !== sid)];
  }, [branches, studioSelectedBranchId]);

  const selectedBranch = useMemo(
    () => branches.find((b) => b.id === selectedBranchId) ?? null,
    [branches, selectedBranchId]
  );

  /**
   * Resolve baseRevisionId: branch tip when branches exist, else current canvas selection,
   * else the project's head (fetched just-in-time) — mirrors the dashboard logic.
   */
  const resolveBase = useCallback(async (): Promise<{
    baseRevisionId: string;
    branchName?: string;
  } | null> => {
    if (branches.length > 1) {
      if (!selectedBranch) return null;
      return { baseRevisionId: selectedBranch.tip_version_id, branchName: selectedBranch.name };
    }
    if (branches.length === 1) {
      const b = branches[0];
      return { baseRevisionId: b.tip_version_id, branchName: b.name };
    }
    if (currentRevision?.id) return { baseRevisionId: currentRevision.id };
    try {
      const r = await fetch(`/api/versions?projectId=${encodeURIComponent(projectId)}`);
      const d = (await r.json()) as { success?: boolean; versions?: Array<{ id?: string }>; error?: string };
      if (!r.ok || !d.success) return null;
      const head = d.versions?.[0]?.id ?? '';
      return head ? { baseRevisionId: head } : null;
    } catch {
      return null;
    }
  }, [branches, selectedBranch, currentRevision?.id, projectId]);

  const handleSubmit = async () => {
    if (!shortMessage.trim()) {
      setErrorMessage('Commit message is required');
      return;
    }
    const notesCheck = validateVersionNotesClient(shortMessage, changelog);
    if (!notesCheck.ok) {
      setErrorMessage(notesCheck.error);
      return;
    }
    const extRefTrim = externalRef.trim();
    if (extRefTrim.length > COMMIT_EXTERNAL_REF_MAX_CHARS) {
      setErrorMessage(`External reference must be at most ${COMMIT_EXTERNAL_REF_MAX_CHARS} characters`);
      return;
    }
    const lock = String(lockedBranchId ?? '').trim();
    if (lock) {
      if (branchesLoading) {
        setErrorMessage('Branch information is still loading. Please wait and try again.');
        return;
      }
      const locked = branches.find((b) => b.id === lock);
      if (!locked) {
        setErrorMessage('Locked branch is no longer available. Refresh and try again.');
        return;
      }
    } else if (branches.length > 1 && !selectedBranch) {
      setErrorMessage('Select a branch to commit on.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const base = await resolveBase();
      if (!base) {
        setErrorMessage('Could not resolve a base revision for this commit.');
        setSubmitting(false);
        return;
      }

      const body: Record<string, unknown> = {
        projectId,
        shortMessage: shortMessage.trim(),
        changelog: changelog.trim() || null,
        baseRevisionId: base.baseRevisionId,
        bump_strategy: bumpStrategy,
      };
      if (base.branchName) body.branchName = base.branchName;
      if (extRefTrim) body.externalRef = extRefTrim;

      const r = await fetch('/api/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = (await r.json()) as {
        success?: boolean;
        error?: string;
        code?: string;
        version?: { id?: string; version_id?: string; published?: boolean };
      };

      if (!r.ok || !d.success) {
        if (r.status === 409) {
          const stale = parseStaleHeadFromVersionsPostJson(d, r.status);
          if (stale && onStaleHead) {
            onStaleHead({
              message: stale.message,
              currentHeadRevisionId: stale.currentHeadRevisionId,
              currentHead: stale.currentHead
                ? {
                    revisionId:
                      typeof stale.currentHead.revisionId === 'string'
                        ? stale.currentHead.revisionId
                        : undefined,
                    versionId:
                      typeof stale.currentHead.versionId === 'string'
                        ? stale.currentHead.versionId
                        : undefined,
                    shortMessage:
                      typeof stale.currentHead.shortMessage === 'string'
                        ? stale.currentHead.shortMessage
                        : null,
                    createdAt:
                      typeof stale.currentHead.createdAt === 'string'
                        ? stale.currentHead.createdAt
                        : null,
                  }
                : null,
            });
          }
        }
        const err = typeof d.error === 'string' ? d.error : 'Commit failed';
        setErrorMessage(err);
        toast.error(err);
        return;
      }

      toast.success(`Committed revision v${d.version?.version_id ?? ''}`);
      onOpenChange(false);
      onCreated?.({
        id: d.version?.id,
        version_id: d.version?.version_id,
        published: d.version?.published,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Commit failed';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const extRefTrim = externalRef.trim();
  const overCap = extRefTrim.length > COMMIT_EXTERNAL_REF_MAX_CHARS;

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-xl" aria-describedby="canvas-commit-desc">
        <VersionDialogHead
          icon={<GitCommitHorizontal aria-hidden />}
          tone="accent"
          title="Commit revision"
          description={
            <span id="canvas-commit-desc">
              Record a new schema revision on top of a branch tip (like <span className="mono">git commit</span> on
              that branch). Message is required; add an external reference when linking to a ticket or issue.
            </span>
          }
        />
        <div className="vdlg-form">
          {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
          {branchError && (
            <Alert variant="warn" role="status">
              {branchError} Using the currently selected revision as base.
            </Alert>
          )}

          {commitRevisionDialogShowsBranchPicker(lockedBranchId, branches) && (
            <div className="vdlg-field">
              <Label>Commit to branch</Label>
              <p className="vdlg-hint">
                The new revision parents from this branch&apos;s current tip and becomes its new tip. Choose another
                branch only if you intend to advance that branch instead.
              </p>
              <Select
                value={selectedBranchId || '__pick__'}
                onValueChange={(v) => setSelectedBranchId(v === '__pick__' ? '' : v)}
                disabled={branchesLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder={branchesLoading ? 'Loading branches…' : 'Choose branch'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">Choose branch</SelectItem>
                  {branchesForSelect.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name} — tip v{b.tip_version_string ?? '?'}
                      {String(studioSelectedBranchId ?? '') === b.id ? ' · current' : ''}
                      {b.protected ? ' (protected)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {branches.length >= 1 &&
            !commitRevisionDialogShowsBranchPicker(lockedBranchId, branches) &&
            selectedBranch && (
              <div className="vdlg-subcard">
                <div className="vdlg-subcard__title">
                  <span>Commit on current branch</span>
                  <span aria-hidden>·</span>
                  <span>{selectedBranch.name}</span>
                  <span className="vdlg-quiet">(tip v{selectedBranch.tip_version_string ?? '?'})</span>
                </div>
                <p className="vdlg-hint">
                  This revision will stack on that branch&apos;s tip — the same as{' '}
                  <span className="mono">git commit</span> while you&apos;re on this branch.
                </p>
              </div>
            )}

          <div className="vdlg-field">
            <Label htmlFor="canvas-commit-msg">Message *</Label>
            <Input
              id="canvas-commit-msg"
              value={shortMessage}
              onChange={(e) => setShortMessage(e.target.value)}
              placeholder="Short summary (commit message)"
              autoComplete="off"
              autoFocus
            />
          </div>

          <div className="vdlg-field">
            <Label htmlFor="canvas-commit-changelog">Changelog (optional)</Label>
            <Textarea
              id="canvas-commit-changelog"
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={3}
              placeholder="Longer notes / migration details"
            />
          </div>

          <div className="vdlg-field">
            <Label htmlFor="canvas-commit-ext">External reference (optional)</Label>
            <Input
              id="canvas-commit-ext"
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              placeholder="e.g. JIRA-123 or PR URL"
              autoComplete="off"
              aria-invalid={overCap}
            />
            {overCap && (
              <p className="vdlg-error">Max {COMMIT_EXTERNAL_REF_MAX_CHARS} characters.</p>
            )}
          </div>

          <div className="vdlg-field">
            <Label>Auto-bump</Label>
            <Select value={bumpStrategy} onValueChange={(v) => setBumpStrategy(v as BumpStrategy)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="patch">Patch (x.y.Z)</SelectItem>
                <SelectItem value="minor">Minor (x.Y.0)</SelectItem>
                <SelectItem value="major">Major (X.0.0)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !shortMessage.trim()}>
            {submitting ? 'Committing…' : 'Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default CommitRevisionDialog;
