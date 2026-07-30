'use client';

import { useState } from 'react';
import {
  FolderTree,
  ShieldCheck,
  Building2,
  Plus,
  Star,
  ListOrdered,
  ShieldAlert,
  ArrowUpCircle,
  Lock,
  Download,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  dashboardPanelClass,
  dashboardTableWrapClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import type { TypeNamespaceCollection } from './primitivesRegistryTypes';
import { visibilityLabel } from './namespaceModel';
import NamespaceEditorDialog from './NamespaceEditorDialog';
import type { DetectedNamespace } from './namespaceModel';

interface Props {
  namespaces: TypeNamespaceCollection[];
  unresolvedByNamespace: Record<string, number>;
  /**
   * Namespaces types already sit in that have no registry row. Offered in the create dialog so an
   * imported namespace can be registered without retyping its path.
   */
  detectedNamespaces: DetectedNamespace[];
  loading: boolean;
  /** Reload the registry overview after a namespace is created, edited, or removed. */
  onRefresh: () => void | Promise<void>;
  onMessage: (type: 'success' | 'error', message: string) => void;
}

/**
 * What removing a namespace registration actually does, spelled out for the confirm dialog.
 *
 * This list is referential: `apiome.primitives.namespace` is a string column with no foreign key to
 * `apiome.type_namespaces`. Removing a row therefore deletes no types — a reader who assumes
 * otherwise would never click the button, so the count and the consequence are both stated.
 */
export function describeNamespaceRemoval(namespace: TypeNamespaceCollection): string {
  const parts = [`Remove the namespace registration “${namespace.namespace}”?`];

  if (namespace.type_count > 0) {
    const one = namespace.type_count === 1;
    parts.push(
      `Its ${namespace.type_count} ${one ? 'type' : 'types'} ${one ? 'is' : 'are'} not deleted — ` +
        `${one ? 'it keeps' : 'they keep'} this namespace path and will show as unregistered ` +
        'until it is registered again.'
    );
  } else {
    parts.push('No types use it.');
  }

  if (namespace.is_default) {
    parts.push('It is currently the default namespace for this tenant.');
  }

  return parts.join(' ');
}

function ScopeBadge({ scope }: { scope: 'system' | 'tenant' }) {
  if (scope === 'system') {
    return (
      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
        System · core
      </span>
    );
  }
  return (
    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
      Tenant
    </span>
  );
}

/** Trim the base URI down to its path tail for compact display (mirrors the mockup's …/types/std/). */
function shortBaseUri(baseUri: string): string {
  try {
    const url = new URL(baseUri);
    return `…${url.pathname}`;
  } catch {
    return baseUri;
  }
}

/**
 * Namespaces & Scopes view (#3471).
 *
 * The third tab under Governance → Primitives: scope-model explainer cards, a table of every
 * namespace visible to the tenant (system-core ∪ own) with create/edit for tenant rows, and the
 * scope precedence + promote-to-core governance cards. CRUD reflects the Namespace API (#3451):
 * tenant administrators manage tenant namespaces; system-core (std/*) rows are read-only here.
 */
export default function PrimitivesNamespacesView({
  namespaces,
  unresolvedByNamespace,
  detectedNamespaces,
  loading,
  onRefresh,
  onMessage,
}: Props) {
  const { confirm } = useDialog();
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<TypeNamespaceCollection | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleCreate = () => {
    setEditing(null);
    setShowDialog(true);
  };

  const handleEdit = (ns: TypeNamespaceCollection) => {
    setEditing(ns);
    setShowDialog(true);
  };

  const handleRemove = async (ns: TypeNamespaceCollection) => {
    const confirmed = await confirm({
      title: 'Remove namespace',
      message: describeNamespaceRemoval(ns),
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    if (!confirmed) return;

    setRemovingId(ns.id);
    try {
      const response = await fetch(`/api/types/namespaces/${ns.id}`, { method: 'DELETE' });
      const data = await response.json();

      if (!response.ok || !data.success) {
        onMessage('error', data.error || 'Failed to remove namespace');
        return;
      }

      const orphaned = Number(data.unregisteredTypeCount ?? 0);
      onMessage(
        'success',
        orphaned > 0
          ? `Namespace “${ns.namespace}” removed — ${orphaned} type${orphaned === 1 ? '' : 's'} are now unregistered`
          : `Namespace “${ns.namespace}” removed`
      );
      await onRefresh();
    } catch (error) {
      console.error('Error removing namespace:', error);
      onMessage('error', 'Failed to remove namespace');
    } finally {
      setRemovingId(null);
    }
  };

  const handleSaved = async () => {
    setShowDialog(false);
    await onRefresh();
  };

  return (
    <div className="space-y-6">
      {/* Scope-model explainer cards */}
      <section className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-lg border border-teal-200 dark:border-teal-800/50 bg-teal-50 dark:bg-teal-900/15 p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-8 h-8 rounded-md bg-teal-100 dark:bg-teal-900/40 inline-flex items-center justify-center text-teal-600 dark:text-teal-300">
              <ShieldCheck className="w-4 h-4" />
            </span>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              System root <span className="text-xs font-normal text-teal-600 dark:text-teal-300">(core)</span>
            </h3>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
            <span className="font-mono">std/*</span> — core system types curated by the platform; visible to
            all tenants; immutable except by platform governance.
          </p>
          <div className="mt-3 rounded-md bg-white/70 dark:bg-black/30 border border-teal-200/60 dark:border-teal-800/40 px-2.5 py-1.5 font-mono text-[11px] text-teal-700 dark:text-teal-300">
            api.apiome.dev/types/std/
          </div>
        </div>
        <div className="rounded-lg border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50 dark:bg-indigo-900/15 p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-8 h-8 rounded-md bg-indigo-100 dark:bg-indigo-900/40 inline-flex items-center justify-center text-indigo-600 dark:text-indigo-300">
              <Building2 className="w-4 h-4" />
            </span>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Tenant namespaces</h3>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
            <span className="font-mono">tenant/&lt;slug&gt;/*</span> — a tenant&apos;s private types; can
            reference core types but are isolated from other tenants.
          </p>
          <div className="mt-3 rounded-md bg-white/70 dark:bg-black/30 border border-indigo-200/60 dark:border-indigo-800/40 px-2.5 py-1.5 font-mono text-[11px] text-indigo-700 dark:text-indigo-300">
            api.apiome.dev/types/tenant/&lt;slug&gt;/
          </div>
        </div>
      </section>

      {/* Namespaces table */}
      <section className={`${dashboardTableWrapClass}`}>
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FolderTree className="w-5 h-5 text-indigo-500" />
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">Namespaces</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Scopes &amp; base URIs across the type registry
              </p>
            </div>
          </div>
          <Button size="sm" onClick={handleCreate}>
            <Plus className="w-4 h-4 mr-2" />
            New namespace
          </Button>
        </div>

        {loading ? (
          <LoadingState minHeightClassName="min-h-[200px]" message="Loading namespaces…" />
        ) : namespaces.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<FolderTree className="h-8 w-8" />}
              title="No Namespaces Yet"
              description="Create a tenant namespace to group your types under a scoped base URI."
              variant="compact"
              showOrbs={false}
              iconContainerClassName="h-14 w-14 from-gray-400 to-gray-500 shadow-gray-500/30"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-gray-50/60 dark:bg-gray-900/40">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold">Namespace</th>
                  <th className="text-left px-3 py-2 font-semibold">Scope</th>
                  <th className="text-left px-3 py-2 font-semibold">Base URI</th>
                  <th className="text-left px-3 py-2 font-semibold">Version root</th>
                  <th className="text-right px-3 py-2 font-semibold">Types</th>
                  <th className="text-left px-3 py-2 font-semibold">Visibility</th>
                  <th className="text-left px-3 py-2 font-semibold">Default</th>
                  <th className="text-right px-5 py-2 font-semibold" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                {namespaces.map((ns) => {
                  const unresolved = unresolvedByNamespace[ns.namespace] ?? 0;
                  return (
                    <tr key={ns.id} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/30">
                      <td className="px-5 py-3 font-mono font-medium text-gray-900 dark:text-white">
                        {ns.namespace}
                        {unresolved > 0 && (
                          <span className="ml-2 text-[9px] px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            {unresolved} unresolved
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <ScopeBadge scope={ns.scope} />
                      </td>
                      <td className="px-3 py-3 font-mono text-[11px] text-gray-500 dark:text-gray-400">
                        {shortBaseUri(ns.base_uri)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {ns.version_root ?? '—'}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-gray-700 dark:text-gray-300">
                        {ns.type_count}
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {visibilityLabel(ns)}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {ns.is_default ? (
                          <span
                            className={`inline-flex items-center gap-1 ${
                              ns.scope === 'system'
                                ? 'text-teal-600 dark:text-teal-300'
                                : 'text-indigo-600 dark:text-indigo-300'
                            }`}
                          >
                            <Star className="w-3 h-3 fill-current" />
                            default
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {ns.scope === 'system' ? (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                            <Lock className="w-3 h-3" />
                            Read-only
                          </span>
                        ) : (
                          <div className="inline-flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => handleEdit(ns)}
                              className="inline-flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300"
                            >
                              <Pencil className="w-3 h-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              data-testid={`remove-namespace-${ns.namespace}`}
                              onClick={() => void handleRemove(ns)}
                              disabled={removingId === ns.id}
                              title="Remove this namespace registration; its types are kept"
                              className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Trash2 className="w-3 h-3" />
                              {removingId === ns.id ? 'Removing…' : 'Remove'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Scope precedence & resolution order */}
        <section className={`${dashboardPanelClass} p-5`}>
          <h3 className="text-base font-semibold mb-1 flex items-center gap-2 text-gray-900 dark:text-white">
            <ListOrdered className="w-5 h-5 text-indigo-500" />
            Scope precedence &amp; resolution order
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            How a property&apos;s type lookup resolves, most specific first.
          </p>
          <ol className="space-y-3">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300 text-xs font-semibold inline-flex items-center justify-center font-mono">
                1
              </span>
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  Tenant namespace{' '}
                  <span className="font-mono text-[11px] text-gray-500">(tenant/&lt;slug&gt;/…)</span>
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  Most specific — the tenant&apos;s own private types win.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300 text-xs font-semibold inline-flex items-center justify-center font-mono">
                2
              </span>
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">Imported vendor namespaces</p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  Vendor schemas imported for that tenant <span className="font-mono">(vendor/…)</span>.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-300 text-xs font-semibold inline-flex items-center justify-center font-mono">
                3
              </span>
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  System core <span className="font-mono text-[11px] text-gray-500">(std/…)</span>
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  Shared fallback available to every tenant.
                </p>
              </div>
            </li>
          </ol>
          <div className="mt-4 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/15 px-3 py-2.5 flex gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-800 dark:text-amber-200 leading-relaxed">
              Core types may be referenced by tenant types; tenant types are never visible across tenants
              or from core.
            </p>
          </div>
        </section>

        {/* Promote to core (governed — gated on platform admin, #3480 7.3) */}
        <section className={`${dashboardPanelClass} p-5`}>
          <h3 className="text-base font-semibold mb-1 flex items-center gap-2 text-gray-900 dark:text-white">
            <ArrowUpCircle className="w-5 h-5 text-teal-500" />
            Promote to core
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Promote a vetted tenant type into <span className="font-mono">std/*</span> so all tenants can use it.
          </p>
          <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 p-3 mb-4">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Example</p>
            <div className="flex items-center gap-2 font-mono text-xs flex-wrap">
              <span className="px-2 py-1 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                tenant/acme/v1/types/money
              </span>
              <Download className="w-4 h-4 text-gray-400 rotate-[-90deg]" />
              <span className="px-2 py-1 rounded bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
                std/v0/types/money
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" disabled title="Requires platform administrator approval">
              <ArrowUpCircle className="w-4 h-4 mr-2" />
              Request promotion
            </Button>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
              <Lock className="w-3.5 h-3.5" /> requires platform admin approval
            </p>
          </div>
        </section>
      </div>

      {showDialog && (
        <NamespaceEditorDialog
          namespace={editing}
          detectedNamespaces={detectedNamespaces}
          onClose={() => setShowDialog(false)}
          onSaved={handleSaved}
          onMessage={onMessage}
        />
      )}
    </div>
  );
}
