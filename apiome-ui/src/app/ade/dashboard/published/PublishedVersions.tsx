'use client';

import { useAuthSession } from '@lib/auth/session-client';
import { useEffect, useState, useMemo } from 'react';
import { Eye, Lock, Globe, Copy, ExternalLink, Search, FileText, MoreVertical, ChevronLeft } from 'lucide-react';
import { getPublishedVersionsForTenant, updateVersionVisibility, getApiKeysForTenant } from '../../../../../lib/db/helper';
import { buildMockBaseUrl } from '@lib/mock/mockUrl';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '../../../components/ui/Dialog';
import { Button } from '../../../components/ui/Button';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Input } from '../../../components/ui/Input';
import { Label } from '../../../components/ui/Label';
import { Badge } from '../../../components/ui/Badge';
import { LoadingState } from '../../../components/ui/LoadingState';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/Select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/Tooltip';
import { cn } from '../../../../../lib/utils';
import { useDialog } from '../../../components/providers/DialogProvider';
import { toast } from 'sonner';
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
import {
  clearStoredPreviewApiKey,
  getStoredPreviewApiKey,
  setStoredPreviewApiKey,
} from '@/app/utils/preview-api-key-storage';
import { formatVersionWithPrefix } from '@/app/utils/version-display';
import { VersionMockCell, type VersionMockChange } from '@/app/components/ade/dashboard/VersionMockCell';
import { useMockUsage } from '@/app/hooks/useMockUsage';
import { mockUsageSeriesKey } from '@/app/utils/mock-usage-series';

interface PublishedVersion {
  id: string;
  version_id: string;
  description: string | null;
  visibility: 'public' | 'private';
  published_at: string;
  created_at: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  creator_name: string;
  creator_email: string;
  /** Hosted mock toggle state (#4422, SIM-2.1) */
  mock_enabled: boolean;
}

interface ApiKeySummary {
  id: string;
  enabled: boolean;
  expires_at: string | null;
}

const PublishedVersions = ({
  restApiBaseUrl,
  mockApiBaseUrl,
}: {
  restApiBaseUrl: string;
  /** Public base URL of the hosted mock runtime (#4443, SIM-2.2), e.g. https://mock.example.com */
  mockApiBaseUrl: string;
}) => {
  const { data: session } = useAuthSession();
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [versions, setVersions] = useState<PublishedVersion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [changingVisibility, setChangingVisibility] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Dropdown state
  const [openVersionDropdown, setOpenVersionDropdown] = useState<string | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);
  const [openViewSubmenu, setOpenViewSubmenu] = useState<string | null>(null);

  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);

  const currentTenantId = (session?.user as any)?.current_tenant_id;

  // 30-day mock usage series across the tenant's published versions (#4443, SIM-2.2).
  const { seriesByVersion: mockUsageByVersion } = useMockUsage({ enabled: Boolean(currentTenantId) });

  /** Fold a successful mock toggle round-trip back into the table state (#4443). */
  const handleVersionMockChanged = (versionRecordId: string, change: VersionMockChange) => {
    setVersions((prev) =>
      prev.map((v) => (v.id === versionRecordId ? { ...v, mock_enabled: change.mockEnabled } : v))
    );
  };

  const isApiKeyExpired = (expiresAt: string | null) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };
  const hasEnabledApiKey = apiKeys.some((k) => k.enabled && !isApiKeyExpired(k.expires_at));

  useEffect(() => {
    loadPublishedVersions();
  }, [currentTenantId]);

  useEffect(() => {
    if (currentTenantId) {
      getApiKeysForTenant(currentTenantId).then((result) => {
        try {
          const keys = JSON.parse(result) as ApiKeySummary[];
          setApiKeys(keys);
        } catch {
          setApiKeys([]);
        }
      });
    } else {
      setApiKeys([]);
    }
  }, [currentTenantId]);

  const loadPublishedVersions = async () => {
    if (!currentTenantId) { setVersions([]); setIsLoading(false); return; }
    try {
      setIsLoading(true);
      const result = await getPublishedVersionsForTenant(currentTenantId);
      setVersions(JSON.parse(result));
    } catch (error) {
      console.error('Failed to load published versions:', error);
      setVersions([]);
    } finally {
      setIsLoading(false);
    }
  };

  const getAccessUrl = (version: PublishedVersion) => `${version.tenant_slug}/${version.project_slug}/${version.version_id}`;
  const getFullAccessUrl = (version: PublishedVersion) => `${restApiBaseUrl}/schema/${getAccessUrl(version)}`;
  // Mirrors the REST `_mock_base_url` shape: {mockHost}/{tenant}/{project}/{version} (#4422).
  const getMockUrl = (version: PublishedVersion) =>
    buildMockBaseUrl(mockApiBaseUrl, version.tenant_slug, version.project_slug, version.version_id);
  const getSwaggerUrl = (version: PublishedVersion) => `${restApiBaseUrl}/swagger/${getAccessUrl(version)}`;
  const getArazzoUrl = (version: PublishedVersion) => `${restApiBaseUrl}/arazzo/${getAccessUrl(version)}`;
  const getJsonUrl = (version: PublishedVersion) => `${restApiBaseUrl}/json/${getAccessUrl(version)}`;

  const withApiKey = (baseUrl: string, apiKey: string | undefined) => {
    if (!apiKey?.trim()) return baseUrl;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}api_key=${encodeURIComponent(apiKey.trim())}`;
  };

  const handleCopyUrl = async (version: PublishedVersion) => {
    try {
      await navigator.clipboard.writeText(getFullAccessUrl(version));
      setCopiedUrl(version.id);
      toast.success('Published API URL copied to clipboard.');
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch (error) {
      console.error('Failed to copy URL:', error);
      toast.error('Failed to copy URL to clipboard.');
    }
  };

  const [apiKeyDialog, setApiKeyDialog] = useState<{ version: PublishedVersion; action: 'open' | 'arazzo' | 'json' | 'swagger' } | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [rememberApiKey, setRememberApiKey] = useState(true);
  /** Bumps when localStorage preview key changes so saved-key UI re-reads storage. */
  const [previewKeyStorageVersion, setPreviewKeyStorageVersion] = useState(0);

  const hasSavedPreviewApiKey = useMemo(() => {
    void previewKeyStorageVersion;
    return Boolean(currentTenantId && getStoredPreviewApiKey(currentTenantId));
  }, [currentTenantId, previewKeyStorageVersion]);

  const openViewWithKey = (version: PublishedVersion, action: 'open' | 'arazzo' | 'json' | 'swagger', apiKey: string | undefined) => {
    const url = action === 'open' ? getFullAccessUrl(version) : action === 'arazzo' ? getArazzoUrl(version) : action === 'json' ? getJsonUrl(version) : getSwaggerUrl(version);
    window.open(withApiKey(url, apiKey), '_blank');
  };

  const openPrivateWithOptionalStoredKey = (version: PublishedVersion, action: 'open' | 'arazzo' | 'json' | 'swagger') => {
    const stored = getStoredPreviewApiKey(currentTenantId);
    if (stored) {
      openViewWithKey(version, action, stored);
      return;
    }
    setApiKeyInput('');
    setRememberApiKey(true);
    setApiKeyDialog({ version, action });
  };

  const handleOpenUrl = (version: PublishedVersion) => {
    if (version.visibility === 'private') {
      openPrivateWithOptionalStoredKey(version, 'open');
      return;
    }
    window.open(getFullAccessUrl(version), '_blank');
  };
  const handleOpenSwagger = (version: PublishedVersion) => {
    if (version.visibility === 'private') {
      openPrivateWithOptionalStoredKey(version, 'swagger');
      return;
    }
    window.open(getSwaggerUrl(version), '_blank');
  };
  const handleOpenArazzo = (version: PublishedVersion) => {
    if (version.visibility === 'private') {
      openPrivateWithOptionalStoredKey(version, 'arazzo');
      return;
    }
    window.open(getArazzoUrl(version), '_blank');
  };
  const handleOpenJson = (version: PublishedVersion) => {
    if (version.visibility === 'private') {
      openPrivateWithOptionalStoredKey(version, 'json');
      return;
    }
    window.open(getJsonUrl(version), '_blank');
  };
  const handleApiKeyDialogOpen = () => {
    if (!apiKeyDialog) return;
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    openViewWithKey(apiKeyDialog.version, apiKeyDialog.action, trimmed);
    if (rememberApiKey && currentTenantId) {
      setStoredPreviewApiKey(currentTenantId, trimmed);
      setPreviewKeyStorageVersion((n) => n + 1);
    }
    setApiKeyDialog(null);
    setApiKeyInput('');
    setOpenVersionDropdown(null);
    setOpenViewSubmenu(null);
  };

  const handleClearSavedPreviewApiKey = () => {
    if (!currentTenantId) return;
    clearStoredPreviewApiKey(currentTenantId);
    setPreviewKeyStorageVersion((n) => n + 1);
    toast.success('Saved API key removed from this browser.');
  };

  const handleToggleVisibility = async (version: PublishedVersion) => {
    const newVisibility = version.visibility === 'public' ? 'private' : 'public';
    const confirmMessage = newVisibility === 'public'
      ? `Change visibility to PUBLIC?\n\nThis will make the OpenAPI Specification public without requiring an API Key.`
      : `Change visibility to PRIVATE?\n\nThis will restrict access by requiring an API Key.`;

    const confirmed = await confirmDialog({
      title: `Change Visibility to ${newVisibility.toUpperCase()}`,
      message: confirmMessage,
      variant: 'warning',
      confirmLabel: 'Change Visibility',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    try {
      setChangingVisibility(version.id);
      const result = await updateVersionVisibility(version.id, newVisibility);
      const response = JSON.parse(result);
      if (response.success) {
        setVersions(versions.map(v => v.id === version.id ? { ...v, visibility: newVisibility } : v));
        toast.success(`Visibility changed to ${newVisibility}.`);
      } else {
        await alertDialog({ message: `Failed to update visibility: ${response.error}`, variant: 'error' });
      }
    } catch (error) {
      await alertDialog({ message: 'An error occurred while updating visibility', variant: 'error' });
    } finally {
      setChangingVisibility(null);
    }
  };

  const formatDate = (dateString: string) => {
    const d = new Date(dateString);
    const datePart = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
  };

  const filteredVersions = versions.filter(version => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return version.project_name.toLowerCase().includes(query) || version.version_id.toLowerCase().includes(query) || version.description?.toLowerCase().includes(query) || version.tenant_name.toLowerCase().includes(query);
  });

  if (!currentTenantId) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="relative">
          <div className="absolute -top-10 -left-10 w-40 h-40 bg-gradient-to-br from-amber-100 to-yellow-100 dark:from-amber-900/20 dark:to-yellow-900/20 rounded-full blur-3xl opacity-60" />
          <div className="relative bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20 border border-amber-200 dark:border-amber-700/50 rounded-2xl p-8">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-yellow-500 flex items-center justify-center shadow-lg shadow-amber-500/25 flex-shrink-0">
                <Lock className="h-6 w-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-amber-900 dark:text-amber-100 mb-2">No Tenant Selected</h2>
                <p className="text-amber-800 dark:text-amber-200 mb-4">Please select a tenant before managing publications.</p>
                <Button asChild><a href="/ade/dashboard/tenants">Go to Tenants</a></Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleAction = async (action: string, version: PublishedVersion) => {
    switch (action) {
      case 'open': handleOpenUrl(version); break;
      case 'swagger': handleOpenSwagger(version); break;
      case 'arazzo': handleOpenArazzo(version); break;
      case 'json': handleOpenJson(version); break;
      case 'copy': await handleCopyUrl(version); break;
      case 'visibility': await handleToggleVisibility(version); break;
    }
  };

  return (
    <TooltipProvider>
      <>
        <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <Eye className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                  Published Versions
                </h2>
                <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">
                  View published and locked versions, access URLs, and visibility settings
                </p>
              </div>
            </div>
          </div>
        </header>

        <main className={dashboardMainClass}>
          <div className={dashboardContentStackClass}>
        {/* Search */}
        <div className={dashboardPanelPaddedClass}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search by project name, version, or description..." className="pl-10" />
          </div>
        </div>

        {isLoading ? (
          <LoadingState
            minHeightClassName="min-h-[400px]"
            message="Loading published versions..."
          />
        ) : versions.length === 0 ? (
          <EmptyState
            icon={<Eye className="h-10 w-10" />}
            title="No Published Versions"
            description="You don't have any published versions yet. Publish a version to make it available via API."
          />
        ) : filteredVersions.length === 0 ? (
          <EmptyState
            icon={<Search className="h-10 w-10" />}
            title="No Matching Versions"
            description="No published versions match your search query."
            variant="compact"
          />
        ) : (
          <div className={dashboardTableWrapClass}>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className={dashboardTableTheadClass}>
                  <tr>
                    <th className={dashboardThClass}>Project / Version</th>
                    <th className={dashboardThClass}>Visibility</th>
                    <th className={dashboardThClass}>Access URL</th>
                    <th className={dashboardThClass}>Mock</th>
                    <th className={dashboardThClass}>Published</th>
                    <th className={dashboardThRightClass}>Actions</th>
                  </tr>
                </thead>
                <tbody className={dashboardTbodyClass}>
                  {filteredVersions.map((version) => (
                    <tr key={version.id} className={dashboardTrHoverClass}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col">
                          <div className="text-sm font-semibold text-gray-900 dark:text-white">{version.project_name}</div>
                          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2 mt-0.5">
                            <span className="font-mono font-medium text-indigo-600 dark:text-indigo-400">{formatVersionWithPrefix(version.version_id)}</span>
                            <div className="p-0.5 bg-blue-100 dark:bg-blue-900/30 rounded"><Lock className="h-3 w-3 text-blue-600 dark:text-blue-400" /></div>
                          </div>
                          {version.description && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 max-w-xs truncate">{version.description}</div>}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button onClick={() => handleToggleVisibility(version)} disabled={changingVisibility === version.id} className="cursor-pointer">
                              {version.visibility === 'public' ? (
                                <Badge variant="success" className="flex items-center gap-1"><Globe className="h-3 w-3" />Public</Badge>
                              ) : (
                                <Badge variant="secondary" className="flex items-center gap-1"><Lock className="h-3 w-3" />Private</Badge>
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Click to change to {version.visibility === 'public' ? 'private' : 'public'}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-6 py-4">
                        <code className="text-xs bg-gray-50 dark:bg-gray-900 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-mono max-w-md truncate block">
                          schema/{getAccessUrl(version)}
                        </code>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <VersionMockCell
                          versionRecordId={version.id}
                          projectId={version.project_id}
                          versionLabel={version.version_id}
                          published
                          mockEnabled={Boolean(version.mock_enabled)}
                          mockBaseUrl={version.mock_enabled ? getMockUrl(version) : null}
                          usageSeries={
                            mockUsageByVersion === null
                              ? undefined
                              : mockUsageByVersion.get(mockUsageSeriesKey(version.project_slug, version.version_id)) ?? []
                          }
                          onMockChanged={(change) => handleVersionMockChanged(version.id, change)}
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900 dark:text-gray-100">{formatDate(version.published_at)}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">by {version.creator_name}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setDropdownPosition({
                                top: rect.bottom + 4,
                                right: window.innerWidth - rect.right
                              });
                              setOpenVersionDropdown(openVersionDropdown === version.id ? null : version.id);
                              setOpenViewSubmenu(null);
                            }}
                            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-400 hover:text-gray-600 dark:hover:text-white"
                            title="Actions"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>

                          {openVersionDropdown === version.id && dropdownPosition && (
                            <>
                              <div
                                className="fixed inset-0 z-10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenVersionDropdown(null);
                                  setOpenViewSubmenu(null);
                                }}
                              />
                              <div
                                className="fixed w-52 min-w-0 overflow-visible bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-20"
                                style={{
                                  top: `${dropdownPosition.top}px`,
                                  right: `${dropdownPosition.right}px`
                                }}>
                                <div className="py-1">
                                  <div
                                    className="relative"
                                    onMouseEnter={() => setOpenViewSubmenu(version.id)}
                                    onMouseLeave={() => setOpenViewSubmenu(null)}
                                  >
                                    <div className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors cursor-default">
                                      <ChevronLeft className="w-4 h-4 flex-shrink-0 text-gray-400" />
                                      <ExternalLink className="w-4 h-4 text-blue-500 flex-shrink-0" />
                                      View
                                    </div>
                                    {openViewSubmenu === version.id && (
                                      <div
                                        className="absolute right-full top-0 mr-0 w-48 py-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-30"
                                        style={{ minWidth: '10rem' }}
                                      >
                                        {(() => {
                                          const isPrivateNoKey = version.visibility === 'private' && !hasEnabledApiKey;
                                          const viewItemClass = isPrivateNoKey
                                            ? 'w-full px-4 py-2 text-left text-sm flex items-center gap-3 text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-60'
                                            : 'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors';
                                          return (
                                            <>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      if (isPrivateNoKey) return;
                                                      setOpenVersionDropdown(null);
                                                      setOpenViewSubmenu(null);
                                                      handleAction('open', version);
                                                    }}
                                                    disabled={isPrivateNoKey}
                                                    className={viewItemClass}
                                                  >
                                                    OpenAPI
                                                  </button>
                                                </TooltipTrigger>
                                                <TooltipContent side="left">
                                                  {isPrivateNoKey ? 'Create an API key to access private versions' : 'View OpenAPI spec'}
                                                </TooltipContent>
                                              </Tooltip>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      if (isPrivateNoKey) return;
                                                      setOpenVersionDropdown(null);
                                                      setOpenViewSubmenu(null);
                                                      handleAction('arazzo', version);
                                                    }}
                                                    disabled={isPrivateNoKey}
                                                    className={viewItemClass}
                                                  >
                                                    Arazzo
                                                  </button>
                                                </TooltipTrigger>
                                                <TooltipContent side="left">
                                                  {isPrivateNoKey ? 'Create an API key to access private versions' : 'View in Arazzo'}
                                                </TooltipContent>
                                              </Tooltip>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <button
                                                    type="button"
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      if (isPrivateNoKey) return;
                                                      setOpenVersionDropdown(null);
                                                      setOpenViewSubmenu(null);
                                                      handleAction('json', version);
                                                    }}
                                                    disabled={isPrivateNoKey}
                                                    className={viewItemClass}
                                                  >
                                                    JSON Schema
                                                  </button>
                                                </TooltipTrigger>
                                                <TooltipContent side="left">
                                                  {isPrivateNoKey ? 'Create an API key to access private versions' : 'View JSON Schema'}
                                                </TooltipContent>
                                              </Tooltip>
                                            </>
                                          );
                                        })()}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenVersionDropdown(null);
                                      handleAction('swagger', version);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                  >
                                    <FileText className="w-4 h-4 text-purple-500" />
                                    Swagger UI
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenVersionDropdown(null);
                                      handleAction('copy', version);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                  >
                                    <Copy className="w-4 h-4 text-blue-500" />
                                    Copy URL
                                  </button>
                                  <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenVersionDropdown(null);
                                      handleAction('visibility', version);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                  >
                                    {version.visibility === 'public' ? (
                                      <>
                                        <Lock className="w-4 h-4 text-gray-500" />
                                        Make Private
                                      </>
                                    ) : (
                                      <>
                                        <Globe className="w-4 h-4 text-green-500" />
                                        Make Public
                                      </>
                                    )}
                                  </button>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {versions.length > 0 && (
          <div className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            Showing {filteredVersions.length} of {versions.length} published {versions.length === 1 ? 'version' : 'versions'}
            {searchQuery && filteredVersions.length < versions.length && <span className="ml-2 text-blue-600 dark:text-blue-400">(filtered)</span>}
          </div>
        )}
          </div>
        </main>
      </>

      {/* API key dialog for private View links */}
      <Dialog open={!!apiKeyDialog} onOpenChange={(open) => !open && setApiKeyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key required</DialogTitle>
            <DialogDescription>
              This version is private. Enter your tenant API key so the opened URL includes authentication (query{' '}
              <code className="text-xs">api_key</code>). Create or manage keys on the{' '}
              <a
                href="/ade/dashboard/api-keys"
                className="font-medium text-indigo-600 underline dark:text-indigo-400"
              >
                API Keys
              </a>{' '}
              page. If you choose &quot;Remember this key&quot; below, private OpenAPI, Swagger UI, Arazzo, and JSON
              Schema links skip this prompt next time on this device.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="api-key-input">API key</Label>
              <Input
                id="api-key-input"
                type="password"
                autoComplete="off"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apiKeyInput.trim() && handleApiKeyDialogOpen()}
                placeholder="sk_..."
              />
            </div>
            <div className="flex items-start gap-3">
              <Checkbox
                id="remember-tenant-api-key"
                checked={rememberApiKey}
                onCheckedChange={(v) => setRememberApiKey(v === true)}
                className="mt-0.5"
              />
              <Label htmlFor="remember-tenant-api-key" className="cursor-pointer text-sm font-normal leading-snug text-gray-700 dark:text-gray-300">
                Remember this key on this browser for the current tenant (local storage only).
              </Label>
            </div>
          </div>
          <DialogFooter className="flex flex-col gap-3 sm:flex-col sm:space-x-0">
            {hasSavedPreviewApiKey ? (
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto self-start border-amber-200 text-amber-900 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-950/40"
                onClick={handleClearSavedPreviewApiKey}
              >
                Clear saved key from this browser
              </Button>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setApiKeyDialog(null)}>
                Cancel
              </Button>
              <Button onClick={handleApiKeyDialogOpen} disabled={!apiKeyInput.trim()}>
                Open with key
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};

export default PublishedVersions;

