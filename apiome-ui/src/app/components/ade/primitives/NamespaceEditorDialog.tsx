'use client';

/**
 * Create / edit dialog for tenant type-registry namespaces (#3471, restyled by HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Overlays → *New / edit namespace* — the
 * detected-namespace picker, the immutable path, the derived base URI and version root, the
 * description, the Default-namespace switch and the validation banner.
 *
 * Posts to `/api/types/namespaces` (create) or `/api/types/namespaces/{id}` (edit), which proxy
 * the Namespace CRUD API (#3451). System-core namespaces never reach this dialog — they are
 * read-only — so the form always targets a tenant-owned namespace.
 *
 * ### What changed in the redesign
 *
 * The head gained the mockup's tinted icon tile, and the detected-namespace picker lost the
 * `border-slate-300 bg-white dark:bg-slate-800` it was hand-painted with. It stays a **native**
 * `<select>` rather than becoming a Radix one: it is a rarely-used shortcut whose whole value is
 * that it works the first time, and the platform control is the one that always does — on a
 * phone, under a screen reader, and in the jsdom suite that pins it.
 */

import * as React from 'react';
import { FolderPlus } from 'lucide-react';

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
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import { Switch } from '@/app/components/ui/Switch';
import { Textarea } from '@/app/components/ui/Textarea';
import {
  buildCreateRequestBody,
  buildUpdateRequestBody,
  defaultBaseUri,
  deriveVersionRoot,
  emptyNamespaceForm,
  formFromNamespace,
  validateNamespaceForm,
  type DetectedNamespace,
  type NamespaceFormData,
} from '@/app/ade/dashboard/primitives/namespaceModel';
import type { TypeNamespaceCollection } from '@/app/ade/dashboard/primitives/primitivesRegistryTypes';

export interface NamespaceEditorDialogProps {
  /** The namespace being edited, or `null` to create a new tenant namespace. */
  namespace: TypeNamespaceCollection | null;
  /**
   * Namespaces types already use that have no registry row, offered as a picker when creating.
   * Defaults to empty so callers that have nothing to detect need not pass it.
   */
  detectedNamespaces?: readonly DetectedNamespace[];
  /** Dismiss without saving. */
  onClose: () => void;
  /** The write landed — the caller reloads and closes. */
  onSaved: () => void;
  /** Report an outcome through the screen's toaster. */
  onMessage: (type: 'success' | 'error', message: string) => void;
}

/**
 * Render the dialog. See {@link NamespaceEditorDialogProps}.
 *
 * @returns The create / edit form.
 */
export default function NamespaceEditorDialog({
  namespace,
  detectedNamespaces = [],
  onClose,
  onSaved,
  onMessage,
}: NamespaceEditorDialogProps) {
  const isEdit = namespace !== null;
  const [form, setForm] = React.useState<NamespaceFormData>(() =>
    namespace ? formFromNamespace(namespace) : emptyNamespaceForm()
  );
  const [submitting, setSubmitting] = React.useState(false);

  const errors = React.useMemo(() => validateNamespaceForm(form, isEdit), [form, isEdit]);
  const hasErrors = Object.keys(errors).length > 0;

  // Show the API-derived defaults as placeholder hints so the user knows what blank fields become.
  const baseUriPlaceholder = defaultBaseUri(form.namespace) || 'https://api.apiome.dev/types/…/';
  const versionRootPlaceholder = deriveVersionRoot(form.namespace) ?? '(none)';

  const update = <K extends keyof NamespaceFormData>(key: K, value: NamespaceFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    if (hasErrors || submitting) return;
    setSubmitting(true);
    try {
      const response = isEdit
        ? await fetch(`/api/types/namespaces/${encodeURIComponent(namespace!.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildUpdateRequestBody(form)),
          })
        : await fetch('/api/types/namespaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildCreateRequestBody(form)),
          });

      const data = await response.json();

      if (data.success) {
        onMessage('success', isEdit ? 'Namespace updated' : 'Namespace created');
        onSaved();
      } else {
        onMessage('error', data.error || 'Failed to save namespace');
      }
    } catch (error) {
      console.error('Error saving namespace:', error);
      onMessage('error', 'Failed to save namespace');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="prm-dialog" aria-describedby={undefined}>
        <DialogHeader className="prm-dialog__head">
          <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
            <FolderPlus />
          </span>
          <div className="prm-dialog__heading">
            <DialogTitle>{isEdit ? 'Edit namespace' : 'New namespace'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Update the base URI, version root, description, or default flag. The namespace path is immutable.'
                : 'Create a tenant namespace. The path is reserved under your tenant; system-core (std/*) namespaces are platform-governed.'}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="prm-dialog__body">
          {/* Types can already sit in a namespace nobody registered — most often after an import,
              which writes the namespace onto the type without creating a collection row. Offering
              those paths here turns "my imported namespace is missing" into one selection. */}
          {!isEdit && detectedNamespaces.length > 0 ? (
            <FormField
              label="Detected namespaces"
              helperText="Namespaces already in use by types but not yet registered as collections."
            >
              <select
                data-testid="detected-namespace-select"
                aria-label="Detected namespaces"
                value=""
                onChange={(e) => {
                  if (e.target.value) update('namespace', e.target.value);
                }}
                className="hive-control prm-select mono"
              >
                <option value="">Select a detected namespace…</option>
                {detectedNamespaces.map((detected) => (
                  <option key={detected.namespace} value={detected.namespace}>
                    {detected.namespace} ({detected.typeCount} type
                    {detected.typeCount === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}

          <FormField
            label="Namespace path"
            required={!isEdit}
            error={errors.namespace}
            helperText={
              isEdit
                ? 'The path is immutable once created.'
                : 'Lowercase slash-separated segments, e.g. tenant/acme/v1/types.'
            }
          >
            <Input
              value={form.namespace}
              onChange={(e) => update('namespace', e.target.value)}
              placeholder="tenant/acme/v1/types"
              className="mono"
              disabled={isEdit}
              aria-label="Namespace path"
            />
          </FormField>

          <div className="prm-dialog__grid">
            <FormField
              label="Base URI"
              error={errors.baseUri}
              helperText="Leave blank to derive from the namespace path."
            >
              <Input
                value={form.baseUri}
                onChange={(e) => update('baseUri', e.target.value)}
                placeholder={baseUriPlaceholder}
                className="mono"
                aria-label="Base URI"
              />
            </FormField>

            <FormField
              label="Version root"
              error={errors.versionRoot}
              helperText="Leave blank to derive from the path's vN segment."
            >
              <Input
                value={form.versionRoot}
                onChange={(e) => update('versionRoot', e.target.value)}
                placeholder={versionRootPlaceholder}
                className="mono"
                aria-label="Version root"
              />
            </FormField>
          </div>

          <FormField label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="What this namespace groups together…"
              rows={2}
              aria-label="Description"
            />
          </FormField>

          <div className="prm-switch-row">
            <span className="prm-switch-row__text">
              <span className="prm-switch-row__title">Default namespace</span>
              <span className="prm-switch-row__desc">
                New tenant types land here unless another is chosen.
              </span>
            </span>
            <Switch
              checked={form.isDefault}
              onCheckedChange={(checked) => update('isDefault', checked)}
              aria-label="Default namespace"
            />
          </div>

          {/* `Alert` renders the variant's own icon, so passing one as a child double-stamps it. */}
          {hasErrors && (
            <Alert variant="error">
              <span>Fix the highlighted fields before saving.</span>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={hasErrors || submitting}>
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create namespace'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
