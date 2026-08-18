'use client';

/**
 * The Namespaces & scopes tab (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Namespaces & scopes — the two scope-model
 * explainer cards, the namespaces table (base URI, version root, visibility, ★ default,
 * read-only lock on system rows, Edit / Remove), the scope-precedence ladder and the disabled
 * promote-to-core card.
 *
 * ### What this replaces
 *
 * `PrimitivesNamespacesView`, which drew the two explainers as `bg-teal-50` / `bg-indigo-50`
 * panels with matching borders and icon tiles, the table as a hand-built `<thead>`/`<tbody>`,
 * the precedence steps as `bg-indigo-100` numerals and the caution as an amber box — 52 named
 * colours in one file, none of which a theme could reach.
 *
 * ### What did not change
 *
 * The ticket's second acceptance criterion. Precedence is still tenant → vendor → core, the
 * promotion button is still inert behind platform approval, `std/*` rows are still read-only,
 * and {@link describeNamespaceRemoval} still spells out that removing a registration deletes
 * no types.
 */

import * as React from 'react';
import {
  ArrowRight,
  ArrowUpCircle,
  Building2,
  FolderTree,
  ListOrdered,
  Lock,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import {
  DataTable,
  DataTableFoot,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { visibilityLabel } from '@/app/ade/dashboard/primitives/namespaceModel';
import type { DetectedNamespace } from '@/app/ade/dashboard/primitives/namespaceModel';
import type { TypeNamespaceCollection } from '@/app/ade/dashboard/primitives/primitivesRegistryTypes';

import NamespaceEditorDialog from './NamespaceEditorDialog';
import {
  PROMOTE_TO_CORE,
  SCOPE_EXPLAINERS,
  SCOPE_ISOLATION_NOTE,
  SCOPE_PRECEDENCE,
  describeNamespaceRemoval,
  namespaceScopeBadge,
  shortBaseUri,
} from './primitivesModel';

/** The glyph on each scope-model explainer card. */
const EXPLAINER_ICON = {
  system: ShieldCheck,
  tenant: Building2,
} as const;

export interface NamespacesPanelProps {
  /** Every namespace visible to the tenant — system-core ∪ own. */
  namespaces: readonly TypeNamespaceCollection[];
  /** Unresolved `$ref` counts, keyed by namespace path. */
  unresolvedByNamespace: Readonly<Record<string, number>>;
  /**
   * Namespaces types already sit in that have no registry row. Offered in the create dialog so
   * an imported namespace can be registered without retyping its path.
   */
  detectedNamespaces: readonly DetectedNamespace[];
  /** True while the registry overview is being read. */
  loading: boolean;
  /** Reload the overview after a namespace is created, edited or removed. */
  onRefresh: () => void | Promise<void>;
  /** Report an outcome through the screen's toaster. */
  onMessage: (type: 'success' | 'error', message: string) => void;
}

/**
 * Render the tab. See {@link NamespacesPanelProps}.
 *
 * @returns The explainers, the table, the governance cards, and the editor dialog.
 */
export default function NamespacesPanel({
  namespaces,
  unresolvedByNamespace,
  detectedNamespaces,
  loading,
  onRefresh,
  onMessage,
}: NamespacesPanelProps) {
  const { confirm } = useDialog();
  const [showDialog, setShowDialog] = React.useState(false);
  const [editing, setEditing] = React.useState<TypeNamespaceCollection | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

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
          ? `Namespace “${ns.namespace}” removed — ${orphaned} type${
              orphaned === 1 ? '' : 's'
            } are now unregistered`
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

  const columns: DataTableColumn<TypeNamespaceCollection>[] = [
    {
      id: 'namespace',
      header: 'Namespace',
      skeletonWidth: '12rem',
      cell: (ns) => {
        const unresolved = unresolvedByNamespace[ns.namespace] ?? 0;
        return (
          <span className="prm-ns-identity__line">
            <span className="prm-ns-path mono">{ns.namespace}</span>
            {unresolved > 0 ? (
              <span className="prm-micro prm-micro--warn">{unresolved} unresolved</span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: 'scope',
      header: 'Scope',
      skeletonWidth: '5rem',
      cell: (ns) => {
        const badge = namespaceScopeBadge(ns.scope);
        return badge ? <Badge variant={badge.tone}>{badge.label}</Badge> : null;
      },
    },
    {
      id: 'base',
      header: 'Base URI',
      skeletonWidth: '11rem',
      cell: (ns) => <span className="prm-quiet mono">{shortBaseUri(ns.base_uri)}</span>,
    },
    {
      id: 'version',
      header: 'Version root',
      skeletonWidth: '3rem',
      cell: (ns) => <span className="prm-num mono">{ns.version_root ?? '—'}</span>,
    },
    {
      id: 'types',
      header: 'Types',
      align: 'end',
      skeletonWidth: '2rem',
      cell: (ns) => <span className="prm-num mono">{ns.type_count}</span>,
    },
    {
      id: 'visibility',
      header: 'Visibility',
      skeletonWidth: '5rem',
      cell: (ns) => <span className="prm-quiet">{visibilityLabel(ns)}</span>,
    },
    {
      id: 'default',
      header: 'Default',
      skeletonWidth: '3.5rem',
      cell: (ns) =>
        ns.is_default ? (
          <span className="prm-default">
            <Star aria-hidden />
            default
          </span>
        ) : (
          <span className="prm-faint">—</span>
        ),
    },
    {
      id: 'actions',
      headerLabel: 'Actions',
      actions: true,
      cell: (ns) =>
        ns.scope === 'system' ? (
          // The read-only affordance the first acceptance criterion asks for: the lock is
          // stated, not implied by the absence of buttons.
          <span className="prm-lock" title="System-core namespaces are governed by the platform">
            <Lock aria-hidden />
            Read-only
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleEdit(ns)}
              title="Edit namespace"
            >
              <Pencil aria-hidden />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`remove-namespace-${ns.namespace}`}
              onClick={() => void handleRemove(ns)}
              disabled={removingId === ns.id}
              title="Remove this namespace registration; its types are kept"
            >
              <Trash2 aria-hidden />
              {removingId === ns.id ? 'Removing…' : 'Remove'}
            </Button>
          </>
        ),
    },
  ];

  return (
    <div className="prm-panels">
      <section className="prm-explainers" aria-label="Scope model">
        {SCOPE_EXPLAINERS.map((explainer) => {
          const Icon = EXPLAINER_ICON[explainer.id];
          return (
            <Card
              key={explainer.id}
              className="prm-explainer"
              data-tone={explainer.tone}
              data-testid={`primitives-scope-${explainer.id}`}
            >
              <h3 className="prm-explainer__title">
                <Icon aria-hidden />
                {explainer.title}
              </h3>
              <p className="prm-explainer__body">
                <span className="mono">{explainer.pattern}</span> — {explainer.body}
              </p>
              <p className="prm-explainer__uri mono">{explainer.baseUri}</p>
            </Card>
          );
        })}
      </section>

      <DataTable<TypeNamespaceCollection>
        className="prm-ns-table"
        caption="Namespaces"
        dense
        scrollX
        columns={columns}
        rows={namespaces}
        getRowId={(ns) => ns.id}
        getRowLabel={(ns) => ns.namespace}
        loading={loading}
        loadingLabel="Loading namespaces…"
        empty={
          <EmptyState
            icon={<FolderTree aria-hidden />}
            title="No Namespaces Yet"
            description="Create a tenant namespace to group your types under a scoped base URI."
            variant="compact"
          />
        }
        toolbar={
          <DataTableToolbar>
            <span className="prm-panel-head">
              <FolderTree aria-hidden />
              <span className="prm-panel-head__text">
                <h3 className="prm-panel-head__title">Namespaces</h3>
                <span className="prm-panel-head__sub">
                  Scopes &amp; base URIs across the type registry
                </span>
              </span>
            </span>
            <DataTableToolbarSpacer />
            <Button size="sm" onClick={handleCreate} data-testid="primitives-new-namespace">
              <Plus aria-hidden />
              New namespace
            </Button>
          </DataTableToolbar>
        }
        footer={
          <DataTableFoot>
            <span>
              {namespaces.length} namespace{namespaces.length === 1 ? '' : 's'}
            </span>
          </DataTableFoot>
        }
      />

      <div className="prm-governance">
        <Card className="prm-gov-card">
          <h3 className="prm-gov-card__title">
            <ListOrdered aria-hidden />
            Scope precedence &amp; resolution order
          </h3>
          <p className="prm-gov-card__desc">
            How a property’s type lookup resolves, most specific first.
          </p>
          <ol className="prm-precedence" data-testid="primitives-precedence">
            {SCOPE_PRECEDENCE.map((step) => (
              <li key={step.rank} className="prm-precedence__step">
                <span className="prm-step-pill" data-rank={step.rank}>
                  {step.rank}
                </span>
                <span className="prm-precedence__text">
                  <span className="prm-precedence__title">
                    {step.title} <span className="prm-quiet mono">{step.pattern}</span>
                  </span>
                  <span className="prm-precedence__body">{step.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <Alert variant="warning" className="prm-gov-card__note">
            <ShieldAlert aria-hidden />
            <span>{SCOPE_ISOLATION_NOTE}</span>
          </Alert>
        </Card>

        <Card className="prm-gov-card">
          <h3 className="prm-gov-card__title">
            <ArrowUpCircle aria-hidden />
            Promote to core
          </h3>
          <p className="prm-gov-card__desc">{PROMOTE_TO_CORE.description}</p>
          <p className="prm-promote">
            <span className="prm-tag mono">{PROMOTE_TO_CORE.from}</span>
            <ArrowRight aria-hidden />
            <span className="prm-tag prm-tag--core mono">{PROMOTE_TO_CORE.to}</span>
          </p>
          <p className="prm-promote__actions">
            <Button
              variant="outline"
              size="sm"
              disabled
              title="Requires platform administrator approval"
            >
              <ArrowUpCircle aria-hidden />
              Request promotion
            </Button>
            <span className="prm-lock">
              <Lock aria-hidden />
              {PROMOTE_TO_CORE.gate}
            </span>
          </p>
        </Card>
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
