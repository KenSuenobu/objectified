'use client';

/**
 * Per-key MCP capability editor — MTG-4.3 (#4782) + MTG-4.4 (#4783) empty state.
 *
 * Lists MCP API keys, lets admins choose Inherit vs Custom, and when Custom
 * exposes toolset toggles constrained by the saved tenant ceiling. Effective
 * summary comes from MTG-3.3 capabilities/preview. Zero keys shows EmptyState
 * with an admin-only create CTA.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, Check, Copy, KeyRound, Loader2, Lock, Plus } from 'lucide-react';
import { toast } from 'sonner';
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
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { RadioGroup, RadioGroupItem } from '@/app/components/ui/RadioGroup';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { Switch } from '@/app/components/ui/Switch';
import type { McpToolCatalogItem } from './mcpPolicyApi';
import {
  createMcpKey,
  fetchMcpKeys,
  previewMcpKeyCapabilities,
  putMcpKeyCapabilities,
  type McpApiKeyMetadata,
  type McpKeyCapabilityMode,
  type McpKeyEffectiveToolRow,
} from './mcpKeysApi';
import {
  buildMcpKeyCapabilitiesPutBody,
  groupKeyToolsByToolset,
  hasMcpKeyCapabilityChanges,
  mcpKeyCapabilityFormFromSources,
  patchKeyToolEnabled,
  patchKeyToolsetEnabled,
  setKeyCapabilityMode,
  validateMcpKeyCapabilityForm,
  type McpKeyCapabilityFormState,
} from './mcpKeyCapabilityForm';

export interface TenantMcpKeyCapabilitiesEditorProps {
  /** Catalog tools (id / description / toolset). */
  catalog: McpToolCatalogItem[];
  /** Tool ids in the saved tenant ceiling (baseline, not dirty form). */
  ceilingToolIds: string[];
  /**
   * Bumped when tenant policy is saved so inherit previews refresh against
   * the new default enable-set.
   */
  policyRevision: number;
  /** True when the viewer may create keys and mutate capabilities. */
  isAdmin?: boolean;
}

function titleCaseToolset(toolset: string): string {
  if (!toolset) return 'Other';
  return toolset.charAt(0).toUpperCase() + toolset.slice(1);
}

function keyOptionLabel(key: McpApiKeyMetadata): string {
  const revoked = key.revoked_at ? ' (revoked)' : '';
  return `${key.label} · ${key.prefix}…${revoked}`;
}

export default function TenantMcpKeyCapabilitiesEditor({
  catalog,
  ceilingToolIds,
  policyRevision,
  isAdmin = true,
}: TenantMcpKeyCapabilitiesEditorProps) {
  const [keys, setKeys] = useState<McpApiKeyMetadata[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [form, setForm] = useState<McpKeyCapabilityFormState | null>(null);
  const [baseline, setBaseline] = useState<McpKeyCapabilityFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewRows, setPreviewRows] = useState<McpKeyEffectiveToolRow[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSecretModal, setShowSecretModal] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [generatedSecret, setGeneratedSecret] = useState('');
  const [copiedSecret, setCopiedSecret] = useState(false);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    setKeysError(null);
    try {
      const list = await fetchMcpKeys();
      const all = list.keys ?? [];
      setKeys(all);
      const firstActive = all.find((k) => !k.revoked_at) ?? all[0] ?? null;
      setSelectedKeyId((prev) => {
        if (prev && all.some((k) => k.id === prev)) return prev;
        return firstActive?.id ?? null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load MCP keys';
      setKeysError(message);
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const selectedKey = useMemo(
    () => keys.find((k) => k.id === selectedKeyId) ?? null,
    [keys, selectedKeyId],
  );

  useEffect(() => {
    if (!selectedKey) {
      setForm(null);
      setBaseline(null);
      setPreviewRows(null);
      return;
    }
    const next = mcpKeyCapabilityFormFromSources(
      selectedKey.capability_mode,
      selectedKey.enabled_tools ?? [],
      catalog,
      ceilingToolIds,
    );
    setForm(next);
    setBaseline(next);
    setError(null);
  }, [selectedKey, catalog, ceilingToolIds]);

  const dirty = form && baseline ? hasMcpKeyCapabilityChanges(form, baseline) : false;
  const toolsetGroups = useMemo(
    () => (form ? groupKeyToolsByToolset(form.tools) : []),
    [form],
  );

  const schedulePreview = useCallback(
    (keyId: string, state: McpKeyCapabilityFormState) => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(async () => {
        setPreviewLoading(true);
        try {
          const body = buildMcpKeyCapabilitiesPutBody(state);
          const result = await previewMcpKeyCapabilities(keyId, body);
          setPreviewRows(result.tools ?? []);
        } catch {
          setPreviewRows(null);
        } finally {
          setPreviewLoading(false);
        }
      }, 250);
    },
    [],
  );

  useEffect(() => {
    if (!selectedKeyId || !form) return;
    schedulePreview(selectedKeyId, form);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [selectedKeyId, form, policyRevision, schedulePreview]);

  const handleDiscard = () => {
    if (baseline) setForm(baseline);
    setError(null);
  };

  const handleModeChange = (value: string) => {
    const mode = value as McpKeyCapabilityMode;
    setForm((prev) => (prev ? setKeyCapabilityMode(prev, mode) : prev));
  };

  const openCreateModal = () => {
    setNewKeyLabel('');
    setCreateError('');
    setShowCreateModal(true);
  };

  const handleCreateSubmit = async () => {
    if (!newKeyLabel.trim()) {
      setCreateError('Label is required');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const created = await createMcpKey({ label: newKeyLabel.trim() });
      setShowCreateModal(false);
      setGeneratedSecret(created.secret);
      setCopiedSecret(false);
      setShowSecretModal(true);
      await loadKeys();
      setSelectedKeyId(created.id);
      toast.success('MCP API key created');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create MCP key';
      setCreateError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const handleCopySecret = async () => {
    try {
      await navigator.clipboard.writeText(generatedSecret);
      setCopiedSecret(true);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleSave = async () => {
    if (!form || !selectedKeyId) return;
    const validation = validateMcpKeyCapabilityForm(form);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = buildMcpKeyCapabilitiesPutBody(form);
      const saved = await putMcpKeyCapabilities(selectedKeyId, body);
      const next = mcpKeyCapabilityFormFromSources(
        saved.mode,
        saved.enabled_tools ?? [],
        catalog,
        ceilingToolIds,
      );
      setForm(next);
      setBaseline(next);
      setKeys((prev) =>
        prev.map((k) =>
          k.id === selectedKeyId
            ? {
                ...k,
                capability_mode: saved.mode,
                enabled_tools: saved.enabled_tools ?? [],
              }
            : k,
        ),
      );
      toast.success('MCP key capabilities saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save capabilities';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const enabledPreview = useMemo(
    () => (previewRows ?? []).filter((row) => row.enabled).map((row) => row.tool_id),
    [previewRows],
  );
  const deniedCount = (previewRows ?? []).filter((row) => !row.enabled).length;

  const createDialogs = (
    <>
      <Dialog
        open={showCreateModal}
        onOpenChange={(open) => {
          if (!creating) setShowCreateModal(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
                <KeyRound className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              Create MCP API key
            </DialogTitle>
            <DialogDescription>
              Issue a new MCP API key for this tenant. Defaults to inherit tenant policy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {createError ? <Alert variant="error">{createError}</Alert> : null}
            <div className="space-y-2">
              <Label htmlFor="mcp-key-label">Label *</Label>
              <Input
                id="mcp-key-label"
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !creating) void handleCreateSubmit();
                }}
                placeholder="Prod agent"
                disabled={creating}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateModal(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleCreateSubmit()} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create key'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showSecretModal}
        onOpenChange={(open) => {
          if (!open) {
            setShowSecretModal(false);
            setGeneratedSecret('');
            setCopiedSecret(false);
          }
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/30">
                <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              MCP API key created
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Alert variant="warning">
              <strong>Important:</strong> This is the only time you&apos;ll see this secret.
              Copy it now and store it securely.
            </Alert>
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950/40">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Your MCP API key
              </p>
              <div className="flex items-start gap-2">
                <code className="flex-1 break-all rounded-lg border border-gray-200 bg-white p-3 font-mono text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
                  {generatedSecret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopySecret()}
                  aria-label={copiedSecret ? 'Copied' : 'Copy secret'}
                >
                  {copiedSecret ? (
                    <Check className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="success"
              onClick={() => {
                setShowSecretModal(false);
                setGeneratedSecret('');
                setCopiedSecret(false);
              }}
            >
              I&apos;ve saved my key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (keysLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading MCP keys…
      </div>
    );
  }

  if (keysError) {
    return <Alert variant="error">{keysError}</Alert>;
  }

  if (keys.length === 0) {
    return (
      <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
        <EmptyState
          variant="compact"
          icon={<KeyRound className="h-8 w-8" />}
          title="No MCP API keys yet"
          description="Create an MCP API key to grant agents call access under this tenant’s policy."
          action={
            isAdmin ? (
              <Button onClick={openCreateModal}>
                <Plus className="h-4 w-4 mr-2" />
                Create MCP key
              </Button>
            ) : undefined
          }
        />
        {createDialogs}
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
          <KeyRound className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden />
        </div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Per-key capabilities
        </h3>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Effective call access is per MCP API key. Inherit follows tenant defaults;
        Custom sets an enable-set capped by the ceiling above.
      </p>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="space-y-2">
        <Label htmlFor="mcp-key-select">MCP API key</Label>
        <Select
          value={selectedKeyId ?? undefined}
          onValueChange={(id) => setSelectedKeyId(id)}
          disabled={saving}
        >
          <SelectTrigger id="mcp-key-select" aria-label="Select MCP API key">
            <SelectValue placeholder="Select a key" />
          </SelectTrigger>
          <SelectContent>
            {keys.map((key) => (
              <SelectItem key={key.id} value={key.id} disabled={Boolean(key.revoked_at)}>
                {keyOptionLabel(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {form && (
        <>
          <div className="space-y-2">
            <Label>Capability mode</Label>
            <RadioGroup
              value={form.mode}
              onValueChange={handleModeChange}
              aria-label="Capability mode"
            >
              <RadioGroupItem
                value="inherit"
                label="Inherit tenant defaults"
                disabled={saving || Boolean(selectedKey?.revoked_at)}
              />
              <RadioGroupItem
                value="explicit"
                label="Custom enable-set"
                disabled={saving || Boolean(selectedKey?.revoked_at)}
              />
            </RadioGroup>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Toolsets
              {form.mode === 'inherit' ? (
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                  (read-only while inheriting)
                </span>
              ) : null}
            </h4>

            {toolsetGroups.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No MCP tools in the registry catalog.
              </p>
            ) : (
              <div className="space-y-3">
                {toolsetGroups.map((group) => {
                  const allLocked = group.unlockedCount === 0;
                  const switchDisabled =
                    saving ||
                    form.mode === 'inherit' ||
                    Boolean(selectedKey?.revoked_at) ||
                    allLocked;
                  return (
                    <section
                      key={group.toolset}
                      aria-label={`${group.toolset} key toolset`}
                      className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                    >
                      <div className="flex items-center gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/50">
                        <Switch
                          aria-label={`Enable ${group.toolset} for key`}
                          checked={group.enableState === 'all'}
                          indeterminate={group.enableState === 'mixed'}
                          onCheckedChange={(checked) =>
                            setForm((prev) =>
                              prev
                                ? patchKeyToolsetEnabled(prev, group.toolset, checked)
                                : prev,
                            )
                          }
                          disabled={switchDisabled}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-gray-900 dark:text-white">
                            {titleCaseToolset(group.toolset)}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {group.enabledUnlockedCount} of {group.unlockedCount} unlocked
                            tools enabled
                            {allLocked ? ' · all tools locked by ceiling' : ''}
                          </div>
                        </div>
                        {allLocked ? (
                          <Lock
                            className="h-4 w-4 text-slate-400"
                            aria-label="Toolset locked by ceiling"
                          />
                        ) : null}
                      </div>
                      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                        {group.tools.map((tool) => {
                          const locked = !tool.in_ceiling;
                          return (
                            <li
                              key={tool.tool_id}
                              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
                                  {tool.tool_id}
                                  {locked ? (
                                    <Lock
                                      className="h-3.5 w-3.5 text-slate-400"
                                      aria-label={`${tool.tool_id} locked by ceiling`}
                                    />
                                  ) : null}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                  {locked
                                    ? 'Outside tenant ceiling — cannot enable for this key'
                                    : tool.description}
                                </div>
                              </div>
                              <Switch
                                aria-label={`${tool.tool_id} enabled for key`}
                                checked={tool.enabled}
                                onCheckedChange={(checked) =>
                                  setForm((prev) =>
                                    prev
                                      ? patchKeyToolEnabled(prev, tool.tool_id, checked)
                                      : prev,
                                  )
                                }
                                disabled={
                                  saving ||
                                  form.mode === 'inherit' ||
                                  locked ||
                                  Boolean(selectedKey?.revoked_at)
                                }
                              />
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </div>

          <div
            className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/40"
            aria-live="polite"
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                Effective summary
              </h4>
              {previewLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-label="Updating preview" />
              ) : null}
            </div>
            {previewRows ? (
              <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                <p>
                  <span className="font-medium text-gray-800 dark:text-gray-200">
                    {enabledPreview.length}
                  </span>{' '}
                  tools enabled for calls
                  {deniedCount > 0 ? (
                    <>
                      {' '}
                      ·{' '}
                      <span className="font-medium text-gray-800 dark:text-gray-200">
                        {deniedCount}
                      </span>{' '}
                      denied
                    </>
                  ) : null}
                </p>
                {enabledPreview.length > 0 ? (
                  <p className="text-xs break-words">
                    {enabledPreview.join(', ')}
                  </p>
                ) : (
                  <p className="text-xs">No tools currently effective for this key.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Preview unavailable.
              </p>
            )}
          </div>

          {dirty && (
            <div
              role="status"
              className="sticky bottom-0 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-900/30"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
                <BadgeCheck className="h-4 w-4" aria-hidden />
                Unsaved key capability changes
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDiscard}
                  disabled={saving}
                >
                  Discard
                </Button>
                <Button onClick={handleSave} disabled={saving} size="sm">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {saving ? 'Saving…' : 'Save capabilities'}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {createDialogs}
    </div>
  );
}
