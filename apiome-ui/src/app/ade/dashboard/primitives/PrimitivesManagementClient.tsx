'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthSession } from '@lib/auth/session-client';
import {
  Database,
  Plus,
  Edit,
  Trash2,
  Search,
  FileCode,
  AlertCircle,
  CheckCircle,
  Upload,
  Shield,
  RefreshCw,
  GitFork,
  Library,
  FolderTree,
  Settings,
} from 'lucide-react';
import { countUnassignedTypes, detectUnregisteredNamespaces } from './namespaceModel';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { Alert } from '@/app/components/ui/Alert';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { useDialog } from '@/app/components/providers/DialogProvider';
import PrimitiveEditorDialog from './PrimitiveEditorDialog';
import PrimitiveImportDialog from './PrimitiveImportDialog';
import PrimitivesRegistryKpiStrip from './PrimitivesRegistryKpiStrip';
import PrimitivesNamespaceCollections from './PrimitivesNamespaceCollections';
import PrimitivesRecentActivity from './PrimitivesRecentActivity';
import PrimitivesResolverView from './PrimitivesResolverView';
import PrimitivesNamespacesView from './PrimitivesNamespacesView';
import PrimitivesSettingsView from './PrimitivesSettingsView';
import {
  countUnresolvedByNamespace,
  type NamespaceScopeFilter,
  type PrimitiveImportActivity,
  type RegistryCoverageStats,
  type TypeNamespaceCollection,
} from './primitivesRegistryTypes';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelPaddedClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';

interface Primitive {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  category: string;
  schema: Record<string, unknown>;
  tags: string[];
  created_by: string | null;
  is_system: boolean;
  is_public: boolean;
  usage_count: number;
  enabled: boolean;
  source?: string;
  namespace?: string | null;
  schema_id?: string | null;
  draft?: string;
  created_at: string;
  updated_at: string;
}

export default function PrimitivesManagementClient() {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const { confirm } = useDialog();

  const [primitives, setPrimitives] = useState<Primitive[]>([]);
  const [filteredPrimitives, setFilteredPrimitives] = useState<Primitive[]>([]);
  const [loading, setLoading] = useState(true);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [stats, setStats] = useState<RegistryCoverageStats | null>(null);
  const [namespaces, setNamespaces] = useState<TypeNamespaceCollection[]>([]);
  const [imports, setImports] = useState<PrimitiveImportActivity[]>([]);
  const [unresolvedByNamespace, setUnresolvedByNamespace] = useState<Record<string, number>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [showSystemPrimitives, setShowSystemPrimitives] = useState(true);
  const [namespaceScopeFilter, setNamespaceScopeFilter] = useState<NamespaceScopeFilter>('all');
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);

  const [activeView, setActiveView] = useState<
    'registry' | 'namespaces' | 'resolver' | 'settings'
  >('registry');

  const [showEditorDialog, setShowEditorDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [editingPrimitive, setEditingPrimitive] = useState<Primitive | null>(null);

  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  const sortByName = (items: Primitive[]) =>
    [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const showMessage = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  }, []);

  const loadRegistryOverview = useCallback(async () => {
    setRegistryLoading(true);
    try {
      const [statsRes, namespacesRes, importsRes, unresolvedRes] = await Promise.all([
        fetch('/api/primitives/stats'),
        fetch('/api/types/namespaces'),
        fetch('/api/primitives/imports?limit=8'),
        fetch('/api/primitives/unresolved'),
      ]);

      const [statsData, namespacesData, importsData, unresolvedData] = await Promise.all([
        statsRes.json(),
        namespacesRes.json(),
        importsRes.json(),
        unresolvedRes.json(),
      ]);

      if (statsData.success) {
        setStats(statsData.stats as RegistryCoverageStats);
      }
      if (namespacesData.success) {
        setNamespaces(namespacesData.namespaces as TypeNamespaceCollection[]);
      }
      if (importsData.success) {
        setImports(importsData.imports as PrimitiveImportActivity[]);
      }
      if (unresolvedData.success && unresolvedData.unresolved?.primitives) {
        setUnresolvedByNamespace(
          countUnresolvedByNamespace(unresolvedData.unresolved.primitives)
        );
      } else {
        setUnresolvedByNamespace({});
      }
    } catch (error) {
      console.error('Error loading registry overview:', error);
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  const loadPrimitives = useCallback(async () => {
    if (!currentTenantId) {
      setPrimitives([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/primitives');

      if (!response.ok) {
        const text = await response.text();
        console.error('API error:', response.status, text);
        showMessage('error', `Failed to load primitives: ${text || response.statusText}`);
        return;
      }

      const data = await response.json();

      if (data.success) {
        setPrimitives(sortByName(data.primitives || []));
      } else {
        showMessage('error', data.error || 'Failed to load primitives');
      }
    } catch (error) {
      console.error('Error loading primitives:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load primitives';
      showMessage('error', errorMessage);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, showMessage]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadPrimitives(), loadRegistryOverview()]);
  }, [loadPrimitives, loadRegistryOverview]);

  const filterPrimitives = useCallback(() => {
    let filtered = [...primitives];

    if (!showSystemPrimitives) {
      filtered = filtered.filter((p) => !p.is_system);
    }

    if (selectedCategory !== 'all') {
      filtered = filtered.filter((p) => p.category === selectedCategory);
    }

    if (selectedNamespace !== null) {
      filtered = filtered.filter((p) => (p.namespace ?? '').trim() === selectedNamespace);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.description?.toLowerCase().includes(query) ||
          p.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          p.namespace?.toLowerCase().includes(query)
      );
    }

    setFilteredPrimitives(sortByName(filtered));
  }, [primitives, searchQuery, selectedCategory, showSystemPrimitives, selectedNamespace]);

  useEffect(() => {
    if (currentTenantId) {
      void refreshAll();
    }
  }, [currentTenantId, refreshAll]);

  useEffect(() => {
    filterPrimitives();
  }, [filterPrimitives]);

  const handleCreatePrimitive = () => {
    setEditingPrimitive(null);
    setShowEditorDialog(true);
  };

  const handleEditPrimitive = (primitive: Primitive) => {
    if (primitive.is_system) {
      showMessage('error', 'System primitives cannot be edited');
      return;
    }
    setEditingPrimitive(primitive);
    setShowEditorDialog(true);
  };

  const handleDeletePrimitive = async (primitive: Primitive, event: React.MouseEvent) => {
    event.stopPropagation();
    if (primitive.is_system) {
      showMessage('error', 'System primitives cannot be deleted');
      return;
    }

    const confirmed = await confirm({
      title: 'Delete Primitive',
      message: `Are you sure you want to delete the primitive "${primitive.name}"?${primitive.usage_count > 0 ? ` This primitive is currently used in ${primitive.usage_count} place${primitive.usage_count !== 1 ? 's' : ''}.` : ''}`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/primitives/${primitive.id}`, {
        method: 'DELETE',
      });

      const data = await response.json();

      if (data.success) {
        showMessage('success', 'Primitive deleted successfully');
        await refreshAll();
      } else {
        showMessage('error', data.error || 'Failed to delete primitive');
      }
    } catch (error) {
      console.error('Error deleting primitive:', error);
      showMessage('error', 'Failed to delete primitive');
    }
  };

  const handleSavePrimitive = async () => {
    await refreshAll();
    setShowEditorDialog(false);
  };

  const handleImportComplete = async () => {
    await refreshAll();
    setShowImportDialog(false);
  };

  const handleRowClick = (primitive: Primitive) => {
    router.push(`/ade/dashboard/primitives/${primitive.id}`);
  };

  const handleNamespaceSelect = (namespace: string) => {
    setSelectedNamespace((current) => (current === namespace ? null : namespace));
  };

  // Type collections lists `apiome.type_namespaces` rows, but a type's namespace is just a string on
  // the primitive and nothing registers it — so a namespace can be in use with no row, and a type can
  // have no namespace at all. Both are derived here from the types already loaded.
  const unassignedTypeCount = useMemo(() => countUnassignedTypes(primitives), [primitives]);
  const detectedNamespaces = useMemo(
    () => detectUnregisteredNamespaces(primitives, namespaces),
    [primitives, namespaces]
  );

  const categories = Array.from(new Set(primitives.map((p) => p.category))).sort();

  if (!currentTenantId) {
    return (
      <div className="flex items-center justify-center h-full">
        <Alert variant="warning">
          <AlertCircle className="h-4 w-4" />
          <span>Please select a tenant to manage primitives</span>
        </Alert>
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <Database className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                Primitives
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">
                JSON Schema 2020-12 type registry · core system &amp; tenant scopes · relative{' '}
                <span className="font-mono">$ref</span> resolution
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={() => setShowImportDialog(true)} variant="secondary">
                <Upload className="w-4 h-4 mr-2" />
                Import from Schema
              </Button>
              <Button onClick={handleCreatePrimitive}>
                <Plus className="w-4 h-4 mr-2" />
                Create Primitive
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className={dashboardMainClass} aria-busy={loading || registryLoading}>
        <div className={dashboardContentStackClass}>
          {message && (
            <Alert variant={message.type === 'success' ? 'default' : 'error'}>
              {message.type === 'success' ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              <span>{message.text}</span>
            </Alert>
          )}

          <PrimitivesRegistryKpiStrip stats={stats} loading={registryLoading} />

          <div className="border-b border-gray-200 dark:border-gray-700" role="tablist" aria-label="Primitives views">
            <nav className="flex gap-6 -mb-px">
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'registry'}
                onClick={() => setActiveView('registry')}
                className={`flex items-center gap-2 px-1 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeView === 'registry'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-indigo-500'
                }`}
              >
                <Library className="w-4 h-4" />
                Registry
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'namespaces'}
                onClick={() => setActiveView('namespaces')}
                className={`flex items-center gap-2 px-1 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeView === 'namespaces'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-indigo-500'
                }`}
              >
                <FolderTree className="w-4 h-4" />
                Namespaces &amp; Scopes
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'resolver'}
                onClick={() => setActiveView('resolver')}
                className={`flex items-center gap-2 px-1 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeView === 'resolver'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-indigo-500'
                }`}
              >
                <GitFork className="w-4 h-4" />
                Resolver
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'settings'}
                onClick={() => setActiveView('settings')}
                className={`flex items-center gap-2 px-1 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeView === 'settings'
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-indigo-500'
                }`}
              >
                <Settings className="w-4 h-4" />
                Settings
              </button>
            </nav>
          </div>

          {activeView === 'settings' ? (
            <PrimitivesSettingsView onMessage={showMessage} />
          ) : activeView === 'resolver' ? (
            <PrimitivesResolverView onMessage={showMessage} />
          ) : activeView === 'namespaces' ? (
            <PrimitivesNamespacesView
              namespaces={namespaces}
              unresolvedByNamespace={unresolvedByNamespace}
              detectedNamespaces={detectedNamespaces}
              loading={registryLoading}
              onRefresh={refreshAll}
              onMessage={showMessage}
            />
          ) : (
          <>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <PrimitivesNamespaceCollections
              namespaces={namespaces}
              unresolvedByNamespace={unresolvedByNamespace}
              scopeFilter={namespaceScopeFilter}
              onScopeFilterChange={setNamespaceScopeFilter}
              onNamespaceSelect={handleNamespaceSelect}
              unassignedCount={unassignedTypeCount}
              detectedNamespaces={detectedNamespaces}
              loading={registryLoading}
            />
            <PrimitivesRecentActivity imports={imports} loading={registryLoading} />
          </div>

          <div className={dashboardPanelPaddedClass}>
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <Input
                    type="text"
                    placeholder="Search primitives..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="flex items-center gap-4 flex-wrap">
                {selectedNamespace !== null ? (
                  <button
                    type="button"
                    data-testid="selected-namespace-chip"
                    onClick={() => setSelectedNamespace(null)}
                    className="text-xs px-2 py-1 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                  >
                    Namespace: {selectedNamespace === '' ? 'Unassigned' : selectedNamespace} ×
                  </button>
                ) : null}

                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="all">All Categories</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showSystemPrimitives}
                    onChange={(e) => setShowSystemPrimitives(e.target.checked)}
                    className="w-4 h-4 text-indigo-600 rounded"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Show System</span>
                </label>

                <Button variant="secondary" size="sm" onClick={refreshAll} disabled={loading || registryLoading}>
                  <RefreshCw className={`w-4 h-4 ${loading || registryLoading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>
          </div>

          <div className={dashboardTableWrapClass}>
            {loading ? (
              <LoadingState minHeightClassName="min-h-[220px]" message="Loading primitives…" />
            ) : filteredPrimitives.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={<Database className="h-8 w-8" />}
                  title="No Primitives Found"
                  description="Try adjusting your filters or create a new primitive."
                  variant="compact"
                  showOrbs={false}
                  iconContainerClassName="h-14 w-14 from-gray-400 to-gray-500 shadow-gray-500/30"
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className={dashboardTableTheadClass}>
                    <tr>
                      <th className={dashboardThClass}>Name</th>
                      <th className={dashboardThClass}>Namespace</th>
                      <th className={dashboardThClass}>Category</th>
                      <th className={dashboardThClass}>Description</th>
                      <th className={dashboardThClass}>Usage</th>
                      <th className={dashboardThClass}>Type</th>
                      <th className={dashboardThRightClass}>Actions</th>
                    </tr>
                  </thead>
                  <tbody className={dashboardTbodyClass}>
                    {filteredPrimitives.map((primitive) => (
                      <tr
                        key={primitive.id}
                        className={`${dashboardTrHoverClass} cursor-pointer`}
                        onClick={() => handleRowClick(primitive)}
                      >
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <FileCode className="w-4 h-4 text-indigo-600 dark:text-indigo-400 mr-2" />
                            <span className="text-sm font-medium text-gray-900 dark:text-white">
                              {primitive.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
                            {primitive.namespace ?? '—'}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300">
                            {primitive.category}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div
                            className="text-sm text-gray-600 dark:text-gray-400 max-w-xs line-clamp-3"
                            title={primitive.description || undefined}
                          >
                            {primitive.description || '—'}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">
                          {primitive.usage_count}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {primitive.is_system ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                              <Shield className="w-3 h-3 mr-1" />
                              System
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                              Tenant
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEditPrimitive(primitive);
                              }}
                              disabled={primitive.is_system}
                              className="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed"
                              title={primitive.is_system ? 'System primitives cannot be edited' : 'Edit primitive'}
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                            <button
                              onClick={(e) => handleDeletePrimitive(primitive, e)}
                              disabled={primitive.is_system}
                              className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                              title={primitive.is_system ? 'System primitives cannot be deleted' : 'Delete primitive'}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          </>
          )}
        </div>
      </main>

      {showEditorDialog && (
        <PrimitiveEditorDialog
          primitive={editingPrimitive}
          onClose={() => setShowEditorDialog(false)}
          onSave={handleSavePrimitive}
          onMessage={showMessage}
        />
      )}

      {showImportDialog && (
        <PrimitiveImportDialog
          onClose={() => setShowImportDialog(false)}
          onComplete={handleImportComplete}
          onMessage={showMessage}
        />
      )}
    </>
  );
}
