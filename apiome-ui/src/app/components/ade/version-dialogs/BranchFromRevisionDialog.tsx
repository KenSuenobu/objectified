'use client';

/**
 * Create a named branch starting at a given revision.
 *
 * Self-contained: owns form state + POST to
 *   /api/projects/{projectId}/version-branches/from-revision.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Label } from '../../ui/Label';
import { GitBranchPlus } from 'lucide-react';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import type { DialogRevisionRef } from './types';

export interface BranchFromRevisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  revision: DialogRevisionRef | null;
  /** Optional name suggestion (e.g. from suggestBranchNameFromRevision). */
  initialName?: string;
  onCreated?: (result: {
    branch?: { id: string; name: string; tip_version_id: string };
  }) => void;
}

export function BranchFromRevisionDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  initialName,
  onCreated,
}: BranchFromRevisionDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName ?? '');
      setSaving(false);
    }
  }, [open, initialName]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed || !revision?.id || !projectId) {
      toast.warning('Enter a branch name');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/version-branches/from-revision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchName: trimmed, sourceRevisionId: revision.id }),
      });
      const d = (await r.json()) as {
        success?: boolean;
        error?: string;
        branch?: { id?: string; name?: string; tip_version_id?: string };
      };
      if (d.success && d.branch?.id && d.branch.tip_version_id) {
        toast.success(`Branch "${trimmed}" created`);
        onOpenChange(false);
        onCreated?.({
          branch: {
            id: d.branch.id,
            name: d.branch.name ?? trimmed,
            tip_version_id: d.branch.tip_version_id,
          },
        });
      } else {
        toast.error(typeof d.error === 'string' ? d.error : 'Could not create branch');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create branch');
    } finally {
      setSaving(false);
    }
  };

  const revisionLabel = revision?.version_id ? `v${revision.version_id}` : revision?.id ?? '—';

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="vdlg-dialog vdlg-dialog--sm" aria-describedby={undefined}>
        <VersionDialogHead
          icon={<GitBranchPlus aria-hidden />}
          tone="accent"
          title="Create named branch"
          description={
            <>
              Point a new branch name at revision <span className="mono">{revisionLabel}</span> in this project.
              Further work can advance the tip via merge workflows.
            </>
          }
        />
        <div className="vdlg-form">
          <div className="vdlg-field">
            <Label htmlFor="canvas-branch-name">Branch name</Label>
            <Input
              id="canvas-branch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. feature/payments"
              autoComplete="off"
              autoFocus
              className="vdlg-input--mono"
            />
            <p className="vdlg-hint">Suggested from the revision message.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !name.trim() || !revision?.id}>
            {saving ? 'Saving…' : 'Create branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default BranchFromRevisionDialog;
