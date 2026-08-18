'use client';

/**
 * Attach a stable name (git-style tag) to a revision.
 *
 * Self-contained: owns form state + POST to /api/projects/{projectId}/version-tags.
 * Used from the canvas menu today; can be reused from the dashboard in a later pass.
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
import { Tag as TagIcon } from 'lucide-react';
import { Checkbox } from '../../ui/Checkbox';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import type { DialogRevisionRef } from './types';

export interface VersionTagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Revision this tag will point at. */
  revision: DialogRevisionRef | null;
  /** True when current session has tenant-admin rights (unlocks the "protected" option). */
  isTenantAdmin?: boolean;
  /** Called after a tag is successfully created so the caller can refresh its tag list. */
  onCreated?: () => void;
}

export function VersionTagDialog({
  open,
  onOpenChange,
  projectId,
  revision,
  isTenantAdmin = false,
  onCreated,
}: VersionTagDialogProps) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState('');
  const [immutable, setImmutable] = useState(false);
  const [tagProtected, setTagProtected] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName('');
      setMessage('');
      setChannel('');
      setImmutable(false);
      setTagProtected(false);
      setSaving(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed || !revision?.id || !projectId) {
      toast.warning('Enter a tag name');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/version-tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          versionId: revision.id,
          message: message.trim() || undefined,
          channel: channel.trim() || undefined,
          immutable,
          ...(isTenantAdmin && tagProtected ? { protected: true } : {}),
        }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      if (d.success) {
        toast.success(`Tag "${trimmed}" created`);
        onOpenChange(false);
        onCreated?.();
      } else {
        toast.error(d.error || 'Could not create tag');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create tag');
    } finally {
      setSaving(false);
    }
  };

  const revisionLabel = revision?.version_id ? `v${revision.version_id}` : revision?.id ?? '—';

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="vdlg-dialog vdlg-dialog--sm" aria-describedby={undefined}>
        <VersionDialogHead
          icon={<TagIcon aria-hidden />}
          tone="honey"
          title="Create version tag"
          description={
            <>
              Attach a stable name to revision <span className="mono">{revisionLabel}</span>. Immutable tags cannot be
              moved or deleted afterward.
            </>
          }
        />
        <div className="vdlg-form">
          <div className="vdlg-field">
            <Label htmlFor="tag-name">Tag name</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. v1.0.0 or stable"
              autoComplete="off"
              autoFocus
              className="vdlg-input--mono"
            />
          </div>
          <div className="vdlg-field">
            <Label htmlFor="tag-msg">Message (optional)</Label>
            <Input
              id="tag-msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Release notes or annotation"
              autoComplete="off"
            />
          </div>
          <div className="vdlg-field">
            <Label htmlFor="tag-channel">Channel (optional)</Label>
            <Input
              id="tag-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="e.g. stable, beta"
              autoComplete="off"
            />
          </div>
          <label className="vdlg-check">
            <Checkbox checked={immutable} onCheckedChange={(v) => setImmutable(v === true)} />
            Lock tag (immutable — cannot move or delete)
          </label>
          {isTenantAdmin && (
            <label className="vdlg-check">
              <Checkbox checked={tagProtected} onCheckedChange={(v) => setTagProtected(v === true)} />
              Protected (only tenant admins can move or delete)
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !name.trim() || !revision?.id}>
            {saving ? 'Saving…' : 'Create tag'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default VersionTagDialog;
