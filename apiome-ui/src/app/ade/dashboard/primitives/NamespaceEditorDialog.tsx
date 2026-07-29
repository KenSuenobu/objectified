'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, FolderTree } from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { Textarea } from '@/app/components/ui/Textarea';
import { Switch } from '@/app/components/ui/Switch';
import { FormField } from '@/app/components/ui/FormField';
import { Alert } from '@/app/components/ui/Alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/app/components/ui/Dialog';
import type { TypeNamespaceCollection } from './primitivesRegistryTypes';
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
} from './namespaceModel';

interface Props {
  /** The namespace being edited, or ``null`` to create a new tenant namespace. */
  namespace: TypeNamespaceCollection | null;
  /**
   * Namespaces types already use that have no registry row, offered as a picker when creating.
   * Defaults to empty so callers that have nothing to detect need not pass it.
   */
  detectedNamespaces?: DetectedNamespace[];
  onClose: () => void;
  onSaved: () => void;
  onMessage: (type: 'success' | 'error', message: string) => void;
}

/**
 * Create / edit dialog for tenant type-registry namespaces (#3471).
 *
 * Posts to ``/api/types/namespaces`` (create) or ``/api/types/namespaces/{id}`` (edit), which
 * proxy the Namespace CRUD API (#3451). System-core namespaces never reach this dialog — they
 * are read-only — so the form always targets a tenant-owned namespace.
 */
export default function NamespaceEditorDialog({
  namespace,
  detectedNamespaces = [],
  onClose,
  onSaved,
  onMessage,
}: Props) {
  const isEdit = namespace !== null;
  const [form, setForm] = useState<NamespaceFormData>(() =>
    namespace ? formFromNamespace(namespace) : emptyNamespaceForm()
  );
  const [submitting, setSubmitting] = useState(false);

  const errors = useMemo(() => validateNamespaceForm(form, isEdit), [form, isEdit]);
  const hasErrors = Object.keys(errors).length > 0;

  // Show the API-derived defaults as placeholder hints so the user knows what blank fields become.
  const baseUriPlaceholder = defaultBaseUri(form.namespace) || 'https://api.apiome.app/types/…/';
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
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="w-5 h-5 text-indigo-500" />
            {isEdit ? 'Edit namespace' : 'New namespace'}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the base URI, version root, description, or default flag. The namespace path is immutable.'
              : 'Create a tenant namespace. The path is reserved under your tenant; system-core (std/*) namespaces are platform-governed.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
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
                className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="">Select a detected namespace…</option>
                {detectedNamespaces.map((detected) => (
                  <option key={detected.namespace} value={detected.namespace}>
                    {detected.namespace} ({detected.typeCount} type{detected.typeCount === 1 ? '' : 's'})
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
              className="font-mono"
              disabled={isEdit}
              aria-label="Namespace path"
            />
          </FormField>

          <FormField
            label="Base URI"
            error={errors.baseUri}
            helperText="Leave blank to derive from the namespace path."
          >
            <Input
              value={form.baseUri}
              onChange={(e) => update('baseUri', e.target.value)}
              placeholder={baseUriPlaceholder}
              className="font-mono"
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
              className="font-mono"
              aria-label="Version root"
            />
          </FormField>

          <FormField label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="What this namespace groups together…"
              rows={2}
              aria-label="Description"
            />
          </FormField>

          <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">Default namespace</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                New tenant types land here unless another is chosen.
              </p>
            </div>
            <Switch
              checked={form.isDefault}
              onCheckedChange={(checked) => update('isDefault', checked)}
              aria-label="Default namespace"
            />
          </div>

          {hasErrors && (
            <Alert variant="error">
              <AlertCircle className="h-4 w-4" />
              <span>Fix the highlighted fields before saving.</span>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
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
