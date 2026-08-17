'use client';

/**
 * Tenant MCP settings — MTG-4.1 (#4780) + MTG-4.2 (#4781) + MTG-4.4 (#4783) non-admin
 * read-only + MTG-4.5 (#4784) disable confirm + MTG-5.1 (#4785) capability presets,
 * redrawn as a drawer section by HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `[data-tab-panel="m-mcp"]`.
 *
 * Loads the MTG-3.1 policy, the MTG-1.1 catalog and the MTG-5.1 presets for the session's
 * current tenant. Toolsets carry a master switch — three-state, because a toolset whose
 * tools are partly in the ceiling is genuinely neither on nor off — named packs apply a
 * draft matrix in one click, and an optional advanced view exposes the three per-tool flags.
 * Non-admins browse the same controls disabled.
 *
 * ### What HIVE-5.1 changed
 *
 * Three things, none of them behavioural:
 *
 *  * **No self-collapse.** The panel used to be a disclosure with its own "MCP Settings"
 *    header button. Inside the manage drawer the vertical tab *is* the disclosure, and two
 *    of them nested reads as a bug. The panel now draws its section heading and its content.
 *  * **No nested children.** It used to render the per-key capability editor and the policy
 *    history inside itself. The mockup makes all three siblings, so they moved out to
 *    `components/ade/tenants/TenantMcpKeysSection` and their own tab; `onPolicySaved` is how
 *    a save still reaches them.
 *  * **Tokens, not palette classes.** Every `slate-*`/`indigo-*`/`amber-*` class is now a
 *    design token, so the panel follows all nine themes rather than only the two it was
 *    hand-tuned for.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, Lock, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { Label } from '@/app/components/ui/Label';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Spinner } from '@/app/components/ui/Spinner';
import { Switch } from '@/app/components/ui/Switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { useDialog } from '@/app/components/providers/DialogProvider';
import {
  fetchMcpCapabilityPresets,
  fetchMcpPolicy,
  fetchMcpToolCatalog,
  putMcpPolicy,
  type McpCapabilityPresetItem,
  type TenantDefaultMode,
} from './mcpPolicyApi';
import { fetchMcpKeys } from './mcpKeysApi';
import {
  applyCapabilityPreset,
  buildMcpPolicyPutBody,
  groupToolsByToolset,
  hasMcpPolicyChanges,
  matchCapabilityPreset,
  mcpPolicyFormFromSources,
  MCP_CUSTOM_PRESET_ID,
  patchToolFlag,
  patchToolsetCeiling,
  summariseMcpPolicyChanges,
  validateMcpPolicyForm,
  type McpPolicyFormState,
  type ToolsetToggleState,
} from './mcpPolicyForm';
import {
  findActiveKeysEffectivelyEnablingTools,
  formatToolsetDisableImpactMessage,
} from './mcpToolsetDisableImpact';

export interface TenantMcpSettingsPanelProps {
  /** True when this row is the session's current tenant (loads live policy). */
  isCurrentTenant: boolean;
  /** True when the viewer is a tenant admin for this tenant. */
  isAdmin: boolean;
  /** Tenant display name for the non-current-tenant helper. */
  tenantName?: string;
  /**
   * Told whether the draft differs from the saved policy.
   *
   * The manage drawer draws the unsaved dot on the MCP tab from this, which is the only way
   * a reader who has tabbed to Policy history can tell that a draft is still waiting.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Called after the policy is saved.
   *
   * The per-key editor and the policy history are siblings now, and both read data this
   * save invalidates — the ceiling and the audit trail.
   */
  onPolicySaved?: () => void;
}

const LIST_VS_CALL_HELP =
  'tools/list always returns the full catalog; ceiling, defaults, and anonymous flags only gate tools/call.';

const ADMIN_ONLY_COPY = 'Only tenant administrators can change MCP options.';

const MODE_LABELS: Record<TenantDefaultMode, string> = {
  all: 'All registry tools',
  inherit_registry: 'Inherit registry defaults',
  explicit: 'Explicit per-tool flags',
};

/** The badge a toolset card carries, from its three-state ceiling. */
const TOOLSET_STATE_BADGE: Readonly<
  Record<ToolsetToggleState, { label: string; variant: 'ok' | 'warn' | 'outline' }>
> = {
  all: { label: 'All in ceiling', variant: 'ok' },
  mixed: { label: 'Mixed', variant: 'warn' },
  none: { label: 'Off', variant: 'outline' },
};

function titleCaseToolset(toolset: string): string {
  if (!toolset) return 'Other';
  return toolset.charAt(0).toUpperCase() + toolset.slice(1);
}

export default function TenantMcpSettingsPanel({
  isCurrentTenant,
  isAdmin,
  tenantName,
  onDirtyChange,
  onPolicySaved,
}: TenantMcpSettingsPanelProps) {
  const { confirm: confirmDialog } = useDialog();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<McpPolicyFormState | null>(null);
  const [baseline, setBaseline] = useState<McpPolicyFormState | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [presets, setPresets] = useState<McpCapabilityPresetItem[]>([]);

  const readOnly = !isAdmin;
  const controlsDisabled = readOnly || saving;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [policy, catalog, presetBody] = await Promise.all([
        fetchMcpPolicy(),
        fetchMcpToolCatalog(),
        fetchMcpCapabilityPresets(),
      ]);
      const next = mcpPolicyFormFromSources(policy, catalog.tools ?? []);
      setForm(next);
      setBaseline(next);
      setPresets(presetBody.presets ?? []);
      setLoadedOnce(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load MCP settings';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // The section only mounts when its tab is first opened, so mounting *is* the request to
  // load — there is no expanded flag left to wait for.
  useEffect(() => {
    if (!isCurrentTenant || loadedOnce) return;
    void load();
  }, [isCurrentTenant, loadedOnce, load]);

  const dirty = form && baseline && !readOnly ? hasMcpPolicyChanges(form, baseline) : false;
  const changeSummary = useMemo(
    () => (form && baseline && dirty ? summariseMcpPolicyChanges(form, baseline) : ''),
    [form, baseline, dirty],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // The drawer's dot must not survive the panel: an unmounted draft is a discarded one.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const toolsetGroups = useMemo(
    () => (form ? groupToolsByToolset(form.tools) : []),
    [form],
  );
  const activePresetId = useMemo(
    () => (form ? matchCapabilityPreset(form, presets) : MCP_CUSTOM_PRESET_ID),
    [form, presets],
  );

  const handleDiscard = () => {
    if (baseline) setForm(baseline);
    setError(null);
  };

  /** Apply a named pack to the draft, or no-op when Custom is chosen. */
  const handlePresetChange = (presetId: string) => {
    if (readOnly || presetId === MCP_CUSTOM_PRESET_ID) return;
    const pack = presets.find((p) => p.id === presetId);
    if (!pack) return;
    setForm((prev) => (prev ? applyCapabilityPreset(prev, pack.toolsets) : prev));
  };

  /**
   * Master toolset switch. Disabling prompts when ≥1 active key currently
   * effective-enables tools in the set (MTG-4.5); cancel leaves form unchanged.
   */
  const handleToolsetToggle = useCallback(
    async (toolset: string, enabled: boolean, toolIds: string[]) => {
      if (readOnly) return;
      if (!enabled && baseline) {
        try {
          const list = await fetchMcpKeys();
          const impacted = findActiveKeysEffectivelyEnablingTools(
            baseline,
            toolIds,
            list.keys ?? [],
          );
          if (impacted.length > 0) {
            const confirmed = await confirmDialog({
              title: `Disable ${titleCaseToolset(toolset)} toolset?`,
              message: formatToolsetDisableImpactMessage(toolset, impacted),
              variant: 'warning',
              confirmLabel: 'Disable toolset',
              cancelLabel: 'Cancel',
            });
            if (!confirmed) return;
          }
        } catch {
          // Key list failed — still warn so an impactful disable is never silent.
          const confirmed = await confirmDialog({
            title: `Disable ${titleCaseToolset(toolset)} toolset?`,
            message:
              `Disabling the ${toolset} toolset may remove tools from active MCP keys. ` +
              `Agents using those keys could lose access on the next call. Continue?`,
            variant: 'warning',
            confirmLabel: 'Disable toolset',
            cancelLabel: 'Cancel',
          });
          if (!confirmed) return;
        }
      }
      setForm((prev) => (prev ? patchToolsetCeiling(prev, toolset, enabled) : prev));
    },
    [baseline, confirmDialog, readOnly],
  );

  const handleSave = async () => {
    if (!form || readOnly) return;
    const validation = validateMcpPolicyForm(form);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await putMcpPolicy(buildMcpPolicyPutBody(form));
      const catalogTools = form.tools.map(({ tool_id, description, toolset }) => ({
        id: tool_id,
        description,
        toolset,
      }));
      const next = mcpPolicyFormFromSources(saved, catalogTools);
      setForm(next);
      setBaseline(next);
      onPolicySaved?.();
      toast.success('MCP settings saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save MCP settings';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="tnt-mcp-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="tnt-mcp-heading" className="tnt-section-title">
            MCP settings
          </h3>
          <p className="tnt-section-desc">{LIST_VS_CALL_HELP}</p>
        </div>
        {isAdmin && (
          <Badge variant="outline">
            <Shield aria-hidden />
            Admins can edit
          </Badge>
        )}
      </div>

      {!isCurrentTenant ? (
        <p className="tnt-lock-note">
          <Lock className="size-[var(--icon-dense)] shrink-0" aria-hidden />
          Select{tenantName ? ` ${tenantName}` : ' this tenant'} as your current tenant to view
          or edit MCP settings.
        </p>
      ) : (
        <>
          {readOnly && (
            <p className="tnt-lock-note">
              <Lock className="size-[var(--icon-dense)] shrink-0" aria-hidden />
              {ADMIN_ONLY_COPY}
            </p>
          )}

          {error && <Alert variant="error">{error}</Alert>}

          {loading && !form ? (
            <LoadingState message="Loading MCP settings…" minHeightClassName="min-h-[8rem]" />
          ) : form ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="mcp-default-mode">Default mode</Label>
                  <Select
                    value={form.default_mode}
                    onValueChange={(value) =>
                      setForm((prev) =>
                        prev ? { ...prev, default_mode: value as TenantDefaultMode } : prev,
                      )
                    }
                    disabled={controlsDisabled}
                  >
                    <SelectTrigger id="mcp-default-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(MODE_LABELS) as TenantDefaultMode[]).map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {MODE_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {presets.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="mcp-capability-preset">Capability profile</Label>
                    <Select
                      value={activePresetId}
                      onValueChange={handlePresetChange}
                      disabled={controlsDisabled}
                    >
                      <SelectTrigger id="mcp-capability-preset" aria-label="Capability profile">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {presets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.label}
                          </SelectItem>
                        ))}
                        <SelectItem value={MCP_CUSTOM_PRESET_ID}>Custom</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-fg-muted">
                      Named packs set toolset ceilings in one click; Custom stays editable
                      after apply.
                    </p>
                  </div>
                )}
              </div>

              <div className="tnt-switch-row">
                <div className="min-w-0">
                  <Label
                    htmlFor="mcp-allow-anonymous"
                    className={readOnly ? undefined : 'cursor-pointer'}
                  >
                    Allow anonymous MCP calls
                  </Label>
                  <p className="text-xs text-fg-muted">
                    Unauthenticated agents may call tools flagged “Anonymous” below.
                  </p>
                </div>
                <Switch
                  id="mcp-allow-anonymous"
                  aria-label="Allow anonymous MCP calls"
                  checked={form.allow_anonymous_mcp}
                  onCheckedChange={(checked) =>
                    setForm((prev) => (prev ? { ...prev, allow_anonymous_mcp: checked } : prev))
                  }
                  disabled={controlsDisabled}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-fg">Toolsets</h4>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="mcp-advanced-tools"
                    checked={advanced}
                    onCheckedChange={(checked) => setAdvanced(checked === true)}
                    disabled={saving}
                  />
                  <Label htmlFor="mcp-advanced-tools" className="cursor-pointer text-xs">
                    Advanced: individual tools
                  </Label>
                </div>
              </div>

              {toolsetGroups.length === 0 ? (
                <p className="py-2 text-sm text-fg-muted">
                  No MCP tools in the registry catalog.
                </p>
              ) : (
                <div className="space-y-3">
                  {toolsetGroups.map((group) => {
                    const badge = TOOLSET_STATE_BADGE[group.ceilingState];
                    return (
                      <section
                        key={group.toolset}
                        aria-label={`${group.toolset} toolset`}
                        className="tnt-toolset-card"
                        data-ceiling={group.ceilingState}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Switch
                              aria-label={`Enable ${group.toolset} toolset`}
                              checked={group.ceilingState === 'all'}
                              indeterminate={group.ceilingState === 'mixed'}
                              onCheckedChange={(checked) =>
                                void handleToolsetToggle(
                                  group.toolset,
                                  checked,
                                  group.tools.map((t) => t.tool_id),
                                )
                              }
                              disabled={controlsDisabled}
                            />
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-fg">
                                {titleCaseToolset(group.toolset)}
                              </div>
                              <div className="text-xs text-fg-muted">
                                {group.inCeilingCount} of {group.tools.length} tools in ceiling
                              </div>
                            </div>
                          </div>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </div>

                        {advanced && (
                          <div className="tnt-toolset-tools">
                            <div className="tnt-tool-row tnt-tool-row--head" aria-hidden>
                              <span>Tool</span>
                              <span>In ceiling</span>
                              <span>Default</span>
                              <span>Anonymous</span>
                            </div>
                            {group.tools.map((tool) => (
                              <div key={tool.tool_id} className="tnt-tool-row">
                                <span className="min-w-0">
                                  <span className="block truncate font-mono text-xs text-fg">
                                    {tool.tool_id}
                                  </span>
                                  <span className="block truncate text-2xs text-fg-muted">
                                    {tool.description}
                                  </span>
                                </span>
                                <span>
                                  <Switch
                                    aria-label={`${tool.tool_id} in ceiling`}
                                    checked={tool.in_ceiling}
                                    onCheckedChange={(checked) =>
                                      setForm((prev) =>
                                        prev
                                          ? patchToolFlag(prev, tool.tool_id, 'in_ceiling', checked)
                                          : prev,
                                      )
                                    }
                                    disabled={controlsDisabled}
                                  />
                                </span>
                                <span title={tool.in_ceiling ? undefined : 'Disabled unless in ceiling'}>
                                  <Switch
                                    aria-label={`${tool.tool_id} default enabled`}
                                    checked={tool.default_enabled}
                                    onCheckedChange={(checked) =>
                                      setForm((prev) =>
                                        prev
                                          ? patchToolFlag(
                                              prev,
                                              tool.tool_id,
                                              'default_enabled',
                                              checked,
                                            )
                                          : prev,
                                      )
                                    }
                                    disabled={controlsDisabled || !tool.in_ceiling}
                                  />
                                </span>
                                <span>
                                  <Switch
                                    aria-label={`${tool.tool_id} anonymous enabled`}
                                    checked={tool.anonymous_enabled}
                                    onCheckedChange={(checked) =>
                                      setForm((prev) =>
                                        prev
                                          ? patchToolFlag(
                                              prev,
                                              tool.tool_id,
                                              'anonymous_enabled',
                                              checked,
                                            )
                                          : prev,
                                      )
                                    }
                                    disabled={controlsDisabled}
                                  />
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}

              {dirty && (
                <div role="status" className="tnt-dirty-bar">
                  <CircleAlert className="size-[var(--icon-dense)] shrink-0" aria-hidden />
                  <span className="shrink-0 font-semibold">Unsaved MCP settings changes</span>
                  {changeSummary && (
                    <span className="tnt-dirty-bar__sub" title={changeSummary}>
                      {changeSummary}
                    </span>
                  )}
                  <div className="ml-auto flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={handleDiscard} disabled={saving}>
                      Discard
                    </Button>
                    <Button onClick={handleSave} disabled={saving} size="sm">
                      {saving && <Spinner size="xs" aria-hidden />}
                      {saving ? 'Saving…' : 'Save changes'}
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
