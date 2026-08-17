'use client';

import * as React from 'react';
import { ArrowRight, Building2, Link2, TriangleAlert } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Spinner } from '@/app/components/ui/Spinner';
import { Textarea } from '@/app/components/ui/Textarea';

import {
  describeTenantEdit,
  validateTenantEdit,
  type TenantEditChanges,
  type TenantEditDraft,
  type TenantRecord,
} from './tenantsModel';

/**
 * Edit tenant, and the slug-change confirm behind it — HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `#edit-tenant` → `#confirm-slug`.
 *
 * ### Why the confirm is a second dialog rather than an inline warning
 *
 * A tenant's slug is in the URL of every OpenAPI spec it has published. Moving it is
 * therefore not a rename — it breaks links that live in other people's systems, and nothing
 * in the form can undo that afterwards. The screen this replaces already stopped for it,
 * through `useDialog().confirm` with a hand-assembled JSX message; what changes here is
 * only the spelling. The confirm now enumerates the change the way DESIGN.md §8 asks a
 * destructive confirm to — the fields, before and after, then the consequence — as a
 * definition list rather than a paragraph, so the before/after pair is readable rather than
 * merely present.
 *
 * The `nameChanged` row appears in the confirm only when the name moved too, because the
 * confirm's job is to enumerate *what this save would do*, and listing an unchanged field
 * dilutes the one that matters.
 */

/** Props for {@link EditTenantDialog}. */
export interface EditTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tenant being edited; `null` while the dialog is closed. */
  tenant: TenantRecord | null;
  /**
   * Persist the edit. Called only after validation passes and, when the slug moved, after
   * the reader confirms.
   *
   * @param input The tenant's id and the trimmed draft.
   * @returns The error to show inline, or `null` on success.
   */
  onSubmit: (input: { id: string; draft: TenantEditDraft }) => Promise<string | null>;
}

/** The warning both the form and the confirm carry, in the words the screen already used. */
const SLUG_URL_WARNING =
  'This change will affect any published OpenAPI specs that reference this tenant’s slug in their URLs.';

/**
 * Edit tenant.
 *
 * @param props See {@link EditTenantDialogProps}.
 * @returns The form dialog, plus the slug confirm it can raise.
 */
export default function EditTenantDialog({
  open,
  onOpenChange,
  tenant,
  onSubmit,
}: EditTenantDialogProps) {
  const [draft, setDraft] = React.useState<TenantEditDraft>({
    name: '',
    slug: '',
    description: '',
  });
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** The change awaiting confirmation, or `null` when no confirm is open. */
  const [pendingSlugChange, setPendingSlugChange] = React.useState<TenantEditChanges | null>(
    null
  );

  React.useEffect(() => {
    if (!open || !tenant) return;
    setDraft({
      name: tenant.name,
      slug: tenant.slug,
      description: tenant.description || '',
    });
    setError('');
    setBusy(false);
    setPendingSlugChange(null);
  }, [open, tenant]);

  /** Send the edit and close on success. Shared by the direct path and the confirmed one. */
  const persist = React.useCallback(async () => {
    if (!tenant) return;
    setBusy(true);
    setError('');
    const failure = await onSubmit({
      id: tenant.id,
      draft: {
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        description: draft.description.trim(),
      },
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [draft, onOpenChange, onSubmit, tenant]);

  const handleSave = React.useCallback(() => {
    if (!tenant) return;
    const problem = validateTenantEdit(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const changes = describeTenantEdit(draft, tenant);
    if (changes.needsSlugConfirm) {
      setPendingSlugChange(changes);
      return;
    }
    void persist();
  }, [draft, persist, tenant]);

  // The live hint under the slug field: only interesting once the slug actually moved.
  const slugMoved = Boolean(tenant && draft.slug.trim() && draft.slug.trim() !== tenant.slug);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="tnt-icon-tile tnt-icon-tile--hex" data-tone="accent">
                <Building2 aria-hidden />
              </span>
              Edit tenant
            </DialogTitle>
            <DialogDescription>Update tenant details.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && <Alert variant="error">{error}</Alert>}

            <div className="space-y-2">
              <Label htmlFor="tnt-edit-name">Tenant name</Label>
              <Input
                id="tnt-edit-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }
                disabled={busy}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tnt-edit-slug">Tenant slug</Label>
              <Input
                id="tnt-edit-slug"
                className="font-mono"
                value={draft.slug}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, slug: event.target.value.toLowerCase() }))
                }
                disabled={busy}
              />
              <p className="text-xs text-fg-muted">
                Lowercase letters, numbers, and dashes only.
              </p>
              {slugMoved && tenant && (
                <p className="flex items-center gap-1.5 text-xs text-warn-fg" role="status">
                  <TriangleAlert className="size-[var(--icon-button)] shrink-0" aria-hidden />
                  Changed from <span className="font-mono">{tenant.slug}</span> — you will be
                  asked to confirm.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="tnt-edit-description">Description</Label>
              <Textarea
                id="tnt-edit-description"
                value={draft.description}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, description: event.target.value }))
                }
                disabled={busy}
                rows={3}
              />
            </div>

            <Alert variant="warning">
              <strong>Note:</strong> The slug is used in OpenAPI specification URLs. Changing
              it will affect any published specs.
            </Alert>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={busy}>
              {busy && <Spinner size="sm" aria-hidden />}
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SlugChangeConfirmDialog
        changes={pendingSlugChange}
        busy={busy}
        onCancel={() => setPendingSlugChange(null)}
        onConfirm={() => {
          setPendingSlugChange(null);
          void persist();
        }}
      />
    </>
  );
}

/** Props for {@link SlugChangeConfirmDialog}. */
export interface SlugChangeConfirmDialogProps {
  /** The change to confirm; `null` closes the dialog. */
  changes: TenantEditChanges | null;
  /** True while the save that follows is in flight. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * "Change tenant slug?" — the enumerated before/after and the published-URL warning.
 *
 * Exported for the redesign suite, which asserts the enumeration rather than merely that a
 * confirm appeared.
 *
 * @param props See {@link SlugChangeConfirmDialogProps}.
 * @returns The confirm dialog.
 */
export function SlugChangeConfirmDialog({
  changes,
  busy = false,
  onCancel,
  onConfirm,
}: SlugChangeConfirmDialogProps) {
  return (
    <Dialog open={Boolean(changes)} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent size="sm" role="alertdialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="warn">
              <Link2 aria-hidden />
            </span>
            Change tenant slug?
          </DialogTitle>
          <DialogDescription>Are you sure you want to proceed?</DialogDescription>
        </DialogHeader>

        {changes && (
          <div className="space-y-3 py-4">
            <dl className="tnt-kv" data-testid="tnt-slug-change-summary">
              {changes.nameChanged && (
                <>
                  <dt>Name</dt>
                  <dd>
                    <span className="text-fg-muted line-through">{changes.name.before}</span>
                    <ArrowRight
                      className="mx-1.5 inline size-[var(--icon-button)] align-[-0.15em] text-fg-subtle"
                      aria-hidden
                    />
                    <span className="font-semibold">{changes.name.after}</span>
                  </dd>
                </>
              )}
              <dt>Slug</dt>
              <dd className="font-mono">
                <span className="text-fg-muted line-through">{changes.slug.before}</span>
                <ArrowRight
                  className="mx-1.5 inline size-[var(--icon-button)] align-[-0.15em] text-fg-subtle"
                  aria-hidden
                />
                <span className="font-semibold">{changes.slug.after}</span>
              </dd>
            </dl>

            <Alert variant="warning">
              <strong className="block">Warning: Changing the slug will affect URLs</strong>
              {SLUG_URL_WARNING}
            </Alert>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            Change slug
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
