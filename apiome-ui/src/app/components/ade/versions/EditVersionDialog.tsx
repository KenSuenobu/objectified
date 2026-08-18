'use client';

/**
 * The Edit version dialog (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Edit version — the mono version id (read
 * only), lifecycle with its `#739` hint, deprecation message, sunset (local → UTC) with its
 * hint, successor revision, then the revision note and changelog, frozen for a published
 * revision an admin is editing and for an archived one.
 *
 * The state and the save are the screen's (`handleEditSubmit`, `performVersionUpdateSave`);
 * this owns the shape and the two notes that explain what is frozen and why.
 */

import * as React from 'react';
import { Lock, Pencil } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/app/components/ui/Dialog';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import { Textarea } from '@/app/components/ui/Textarea';

import { LifecycleSelect, SuccessorRevisionField, VersionDialogHead } from './VersionDialogChrome';
import { versionLabel, versionLifecycle, type Version } from './versionsModel';

export interface EditVersionDialogProps {
  open: boolean;
  /** Called with `false` to close. The screen refuses while a save is in flight. */
  onOpenChange: (open: boolean) => void;
  /** True while the save is in flight. */
  busy: boolean;
  /** The screen's error line, `''` for none. */
  error: string;
  /** The revision being edited, or `null` before one is chosen. */
  version: Version | null;
  /** Whether the viewer is a tenant admin (resolved). */
  effectiveIsAdmin: boolean;
  /** Published + admin: only deprecation and sunset metadata may change (#748). */
  publishedMetadataOnly: boolean;
  /** The revision's own id — read only. */
  versionId: string;
  lifecycle: string;
  onLifecycleChange: (next: string) => void;
  deprecationMessage: string;
  onDeprecationMessageChange: (next: string) => void;
  /** The `datetime-local` value, `''` for none. */
  sunsetLocal: string;
  onSunsetLocalChange: (next: string) => void;
  /** The successor revision id, `''` for none. */
  successorRevisionId: string;
  onSuccessorRevisionIdChange: (next: string) => void;
  /** The other revisions of the same project. */
  successorCandidates: readonly Version[];
  /** The revision note. */
  note: string;
  onNoteChange: (next: string) => void;
  changelog: string;
  onChangelogChange: (next: string) => void;
  onSubmit: () => void;
}

/**
 * Render the dialog. See {@link EditVersionDialogProps}.
 *
 * @returns The dialog.
 */
export default function EditVersionDialog({
  open,
  onOpenChange,
  busy,
  error,
  version,
  effectiveIsAdmin,
  publishedMetadataOnly,
  versionId,
  lifecycle,
  onLifecycleChange,
  deprecationMessage,
  onDeprecationMessageChange,
  sunsetLocal,
  onSunsetLocalChange,
  successorRevisionId,
  onSuccessorRevisionIdChange,
  successorCandidates,
  note,
  onNoteChange,
  changelog,
  onChangelogChange,
  onSubmit,
}: EditVersionDialogProps) {
  const archivedAdmin =
    version !== null && versionLifecycle(version) === 'archived' && effectiveIsAdmin && !publishedMetadataOnly;
  // Notes are frozen for a published revision (an admin may only touch metadata, #748) and for
  // an archived one an admin is editing — the same two rules the screen this replaces applied.
  const notesFrozen = busy || publishedMetadataOnly || archivedAdmin;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="ver-dialog" data-testid="edit-version-dialog">
        <VersionDialogHead
          icon={<Pencil />}
          tone="accent"
          title={
            <>
              Edit version{' '}
              {version ? <span className="ver-dialog__title-mono mono">{versionLabel(version)}</span> : null}
            </>
          }
          description="Lifecycle, deprecation and sunset metadata; notes for drafts."
        />

        <div className="ver-dialog__body">
          {error ? <Alert variant="error">{error}</Alert> : null}
          {publishedMetadataOnly ? (
            <Alert variant="info" icon={<Lock aria-hidden />} data-testid="edit-version-published-note">
              Published revision — notes are frozen. As a tenant admin you can update deprecation and
              sunset metadata only (#748).
            </Alert>
          ) : null}

          <div className="ver-dialog__grid">
            <FormField label="Version ID" htmlFor="edit-version-id">
              <Input id="edit-version-id" className="mono" value={versionId} disabled />
            </FormField>
            <LifecycleSelect
              id="edit-version-lifecycle"
              value={lifecycle}
              onChange={onLifecycleChange}
              disabled={busy}
              helperText="Semantic governance tag (#739). Setting Deprecated sets revision deprecation (#507) for consumers."
            />
            <FormField label="Deprecation message" htmlFor="deprecation-msg" className="ver-dialog__span-2">
              <Textarea
                id="deprecation-msg"
                value={deprecationMessage}
                onChange={(event) => onDeprecationMessageChange(event.target.value)}
                rows={2}
                disabled={busy}
                placeholder="Tell consumers what to migrate to"
              />
            </FormField>
            <FormField
              label="Sunset (local time → stored as UTC)"
              htmlFor="sunset-local"
              helperText="Requires lifecycle Deprecated when set. Successor is optional (end of life with no replacement is valid). Cleared if empty."
            >
              <Input
                id="sunset-local"
                type="datetime-local"
                value={sunsetLocal}
                onChange={(event) => onSunsetLocalChange(event.target.value)}
                disabled={busy}
              />
            </FormField>
            <SuccessorRevisionField
              id="successor-rev"
              value={successorRevisionId}
              onChange={onSuccessorRevisionIdChange}
              candidates={successorCandidates}
              disabled={busy}
            />
            <FormField label="Revision note" htmlFor="edit-version-note" required className="ver-dialog__span-2">
              <Input
                id="edit-version-note"
                value={note}
                onChange={(event) => onNoteChange(event.target.value)}
                disabled={notesFrozen}
                autoFocus={!publishedMetadataOnly && !archivedAdmin}
                placeholder="Short summary (commit message)"
                data-testid="edit-version-note"
              />
            </FormField>
            <FormField label="Changelog (markdown)" htmlFor="edit-version-changelog" className="ver-dialog__span-2">
              <Textarea
                id="edit-version-changelog"
                className="mono"
                value={changelog}
                onChange={(event) => onChangelogChange(event.target.value)}
                rows={4}
                disabled={notesFrozen}
                placeholder="Release notes, breaking bullets (- breaking: …)"
              />
            </FormField>
          </div>

          {archivedAdmin ? (
            <p className="ver-callout" data-testid="edit-version-archived-note">
              This revision is archived (read-only). You can change its lifecycle or use revision lock;
              notes cannot be edited here.
            </p>
          ) : null}
        </div>

        <DialogFooter className="ver-dialog__footer">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={busy} data-testid="edit-version-submit">
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
