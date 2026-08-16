'use client';

import { useAuthSession } from '@lib/auth/session-client';
import { getApiKeysForTenant, createApiKey, deleteApiKey, toggleApiKeyStatus } from '../../../../../lib/db/helper';
import { useEffect, useState } from 'react';
import { Plus, Trash2, Key, Copy, Check, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '../../../components/ui/Dialog';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Label } from '../../../components/ui/Label';
import { Alert } from '../../../components/ui/Alert';
import { Textarea } from '../../../components/ui/Textarea';
import { EmptyState } from '../../../components/ui/EmptyState';
import { OPEN_ACTIONS, useOpenAction } from '../../../components/shell/openActions';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { Switch } from '../../../components/ui/Switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/Tooltip';
import { RadioGroup, RadioGroupItem } from '../../../components/ui/RadioGroup';
import { cn } from '../../../../../lib/utils';
import { useDialog } from '../../../components/providers/DialogProvider';
import {
  API_KEY_SCOPE_PRESETS,
  type ApiKeyScopePreset,
  formatApiKeyScopes,
} from '@/app/utils/apiKeyScopes';

interface ApiKey {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  key_prefix: string;
  scopes?: string[] | null;
  last_used_at: string | null;
  expires_at: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const SCOPE_PRESET_OPTIONS: { value: ApiKeyScopePreset; label: string; hint: string }[] = [
  {
    value: 'full',
    label: 'Full access',
    hint: 'Same as today — all REST operations for this tenant (default).',
  },
  {
    value: 'diff',
    label: 'CI: classified diff (diff:read)',
    hint: 'POST /v1/diff/…/classified only — recommended for contract gates.',
  },
  {
    value: 'lint',
    label: 'CI: lint (lint:read)',
    hint: 'GET …/lint and …/lint/gate only (catalog + MCP).',
  },
  {
    value: 'ci_both',
    label: 'CI: diff + lint',
    hint: 'Both CI read scopes; still no write access.',
  },
];

const ApiKeys = () => {
  const { data: session } = useAuthSession();
  const { confirm: confirmDialog } = useDialog();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [newApiKeyName, setNewApiKeyName] = useState('');
  const [newApiKeyDescription, setNewApiKeyDescription] = useState('');
  const [newApiKeyExpiry, setNewApiKeyExpiry] = useState('');
  const [newApiKeyScopePreset, setNewApiKeyScopePreset] = useState<ApiKeyScopePreset>('full');
  const [generatedApiKey, setGeneratedApiKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [copiedKey, setCopiedKey] = useState(false);

  const currentTenantId = (session?.user as any)?.current_tenant_id;

  useEffect(() => {
    if (currentTenantId) {
      loadApiKeys();
    }
  }, [currentTenantId]);

  const loadApiKeys = async () => {
    if (!currentTenantId) return;
    const result = await getApiKeysForTenant(currentTenantId);
    setApiKeys(JSON.parse(result));
  };

  const handleCreateApiKey = () => {
    setNewApiKeyName('');
    setNewApiKeyDescription('');
    setNewApiKeyExpiry('');
    setNewApiKeyScopePreset('full');
    setErrorMessage('');
    setShowCreateModal(true);
  };

  /*
   * The command palette's "Create API key…" action (HIVE-3.6, #5292). The palette navigates
   * here with `?open=new-api-key`; this page opens the dialog it already owns, and
   * `useOpenAction` strips the parameter so a reload does not reopen it.
   */
  useOpenAction(OPEN_ACTIONS.newApiKey, handleCreateApiKey);

  const handleCreateSubmit = async () => {
    if (!newApiKeyName.trim()) {
      setErrorMessage('API key name is required');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const expiresInDays = newApiKeyExpiry ? parseInt(newApiKeyExpiry) : null;
      const scopes = API_KEY_SCOPE_PRESETS[newApiKeyScopePreset];
      const result = await createApiKey(
        currentTenantId,
        newApiKeyName,
        newApiKeyDescription,
        expiresInDays,
        scopes,
      );
      const response = JSON.parse(result);

      if (response.success) {
        setGeneratedApiKey(response.apiKey);
        setShowCreateModal(false);
        setShowApiKeyModal(true);
        await loadApiKeys();
      } else {
        setErrorMessage(response.error || 'Failed to create API key');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to create API key');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteClick = async (apiKey: ApiKey) => {
    const confirmed = await confirmDialog({
      title: 'Delete API Key',
      message: `Are you sure you want to delete the API key "${apiKey.name}"? This action cannot be undone.`,
      variant: 'danger',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });

    if (!confirmed) return;

    try {
      const result = await deleteApiKey(apiKey.id);
      const response = JSON.parse(result);
      if (response.success) {
        await loadApiKeys();
      }
    } catch (error: any) {
      console.error('Failed to delete API key:', error.message);
    }
  };

  const handleToggleStatus = async (apiKey: ApiKey, nextEnabled: boolean) => {
    try {
      if (!nextEnabled) {
        const confirmed = await confirmDialog({
          title: 'Disable API Key',
          message: `Are you sure you want to disable "${apiKey.name}"? This will immediately block all requests using this key.`,
          variant: 'warning',
          confirmLabel: 'Disable',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) {
          setApiKeys((prev) => prev.slice());
          return;
        }
      }

      const result = await toggleApiKeyStatus(apiKey.id, nextEnabled);
      const response = JSON.parse(result);
      if (response.success) {
        await loadApiKeys();
      }
    } catch (error) {
      console.error('Failed to toggle API key status:', error);
    }
  };

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(generatedApiKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch (error) {
      console.error('Failed to copy API key:', error);
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never';
    const d = new Date(dateString);
    const datePart = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
  };

  const isExpired = (expiresAt: string | null) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  if (!currentTenantId) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="relative">
          <div className="absolute -top-10 -left-10 w-40 h-40 bg-gradient-to-br from-amber-100 to-yellow-100 dark:from-amber-900/20 dark:to-yellow-900/20 rounded-full blur-3xl opacity-60" />
          <div className="relative bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20 border border-amber-200 dark:border-amber-700/50 rounded-2xl p-8">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-yellow-500 flex items-center justify-center shadow-lg shadow-amber-500/25 flex-shrink-0">
                <AlertCircle className="h-6 w-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-amber-900 dark:text-amber-100 mb-2">No Tenant Selected</h2>
                <p className="text-amber-800 dark:text-amber-200 mb-4">Please select a tenant before managing API Keys.</p>
                <Button asChild>
                  <a href="/ade/dashboard/tenants" className="inline-flex items-center gap-2">
                    Go to Tenants
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <>
        <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <Key className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                  API Keys
                </h2>
                <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">
                  Manage API keys for external REST API access. Prefer scoped CI tokens for pipelines.
                </p>
              </div>
              <Button onClick={handleCreateApiKey}>
                <Plus className="h-4 w-4 mr-2" />
                Create API Key
              </Button>
            </div>
          </div>
        </header>

        <main className={dashboardMainClass}>
          <div className={dashboardContentStackClass}>
        {apiKeys.length === 0 ? (
          <div className={dashboardTableWrapClass}>
            <div className="p-8">
              <EmptyState
                icon={<Key className="h-10 w-10" />}
                title="No API Keys Yet"
                description="Create your first API key to access your tenant data via REST API"
                variant="compact"
              />
            </div>
          </div>
        ) : (
          <div className={dashboardTableWrapClass}>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className={dashboardTableTheadClass}>
                  <tr>
                    <th className={dashboardThClass}>Name</th>
                    <th className={dashboardThClass}>Prefix</th>
                    <th className={dashboardThClass}>Scopes</th>
                    <th className={dashboardThClass}>Status</th>
                    <th className={dashboardThClass}>Last used</th>
                    <th className={dashboardThClass}>Created</th>
                    <th className={dashboardThClass}>Expires</th>
                    <th className={dashboardThClass}>Enabled</th>
                    <th className={dashboardThRightClass}>Actions</th>
                  </tr>
                </thead>
                <tbody className={dashboardTbodyClass}>
                  {apiKeys.map((apiKey) => (
                    <tr
                      key={apiKey.id}
                      className={cn(
                        dashboardTrHoverClass,
                        isExpired(apiKey.expires_at) && 'bg-red-50/50 dark:bg-red-950/20',
                        !apiKey.enabled && !isExpired(apiKey.expires_at) && 'bg-gray-50/80 dark:bg-gray-900/40'
                      )}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-start gap-2">
                          <Key className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                          <div>
                            <div className="text-sm font-medium text-gray-900 dark:text-white">{apiKey.name}</div>
                            {apiKey.description ? (
                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-xs line-clamp-2">{apiKey.description}</div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded-md text-gray-900 dark:text-gray-100">
                          {apiKey.key_prefix}…
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                          {formatApiKeyScopes(apiKey.scopes)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {isExpired(apiKey.expires_at) && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 border border-red-200 dark:border-red-700">
                            <AlertCircle className="h-3 w-3" />Expired
                          </span>
                        )}
                        {!apiKey.enabled && !isExpired(apiKey.expires_at) && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600">
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />Disabled
                          </span>
                        )}
                        {apiKey.enabled && !isExpired(apiKey.expires_at) && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Active
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                        {formatDate(apiKey.last_used_at)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                        {formatDate(apiKey.created_at)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <span className={isExpired(apiKey.expires_at) ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-gray-600 dark:text-gray-300'}>
                          {apiKey.expires_at ? formatDate(apiKey.expires_at) : 'Never'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Switch checked={apiKey.enabled} onCheckedChange={(checked) => handleToggleStatus(apiKey, checked)} />
                          <span className="text-sm text-gray-600 dark:text-gray-300">{apiKey.enabled ? 'On' : 'Off'}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button type="button" onClick={() => handleDeleteClick(apiKey)} className="p-2 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors inline-flex">
                              <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500 transition-colors" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Delete API Key</TooltipContent>
                        </Tooltip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Create API Key Modal */}
        <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/30 dark:to-orange-900/30">
                  <Key className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                </div>
                Create API Key
              </DialogTitle>
              <DialogDescription>Create a new API key for REST API access</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
              <div className="space-y-2">
                <Label htmlFor="keyName">Name *</Label>
                <Input id="keyName" value={newApiKeyName} onChange={(e) => setNewApiKeyName(e.target.value)} placeholder="My API Key" autoFocus />
                <p className="text-xs text-gray-500 dark:text-gray-400">A descriptive name for this API key</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="keyDescription">Description</Label>
                <Textarea id="keyDescription" value={newApiKeyDescription} onChange={(e) => setNewApiKeyDescription(e.target.value)} placeholder="What is this key used for?" rows={3} />
              </div>
              <div className="space-y-2">
                <Label>Scopes</Label>
                <RadioGroup
                  value={newApiKeyScopePreset}
                  onValueChange={(v) => setNewApiKeyScopePreset(v as ApiKeyScopePreset)}
                  className="space-y-2"
                >
                  {SCOPE_PRESET_OPTIONS.map((opt) => (
                    <RadioGroupItem
                      key={opt.value}
                      value={opt.value}
                      label={
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {opt.label}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{opt.hint}</span>
                        </span>
                      }
                    />
                  ))}
                </RadioGroup>
              </div>
              <div className="space-y-2">
                <Label htmlFor="keyExpiry">Expires In (Days)</Label>
                <Input id="keyExpiry" type="number" value={newApiKeyExpiry} onChange={(e) => setNewApiKeyExpiry(e.target.value)} placeholder="Leave empty for no expiration" min={1} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateModal(false)} disabled={isLoading}>Cancel</Button>
              <Button onClick={handleCreateSubmit} disabled={isLoading} className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600">
                {isLoading ? 'Creating...' : 'Create API Key'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Show Generated API Key Modal */}
        <Dialog open={showApiKeyModal} onOpenChange={(open) => { if (!open) { setShowApiKeyModal(false); setGeneratedApiKey(''); setCopiedKey(false); } }}>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30">
                  <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                API Key Created Successfully
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <Alert variant="warning">
                <strong>Important:</strong> This is the only time you'll see this API key. Please copy it now and store it securely.
              </Alert>
              <div className="p-4 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border border-amber-200 dark:border-amber-700">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Your API Key:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-white dark:bg-gray-900 p-4 rounded-xl border border-gray-200 dark:border-gray-700 font-mono text-sm break-all text-gray-900 dark:text-gray-100">
                    {generatedApiKey}
                  </code>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button onClick={handleCopyKey} className={cn("p-3 rounded-xl transition-colors", copiedKey ? "bg-emerald-100 dark:bg-emerald-900/30" : "bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-800/30")}>
                        {copiedKey ? <Check className="h-5 w-5 text-emerald-600" /> : <Copy className="h-5 w-5 text-amber-600" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{copiedKey ? 'Copied!' : 'Copy to clipboard'}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="success" onClick={() => { setShowApiKeyModal(false); setGeneratedApiKey(''); setCopiedKey(false); }}>
                I've Saved My Key
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
          </div>
        </main>
      </>
    </TooltipProvider>
  );
};

export default ApiKeys;

