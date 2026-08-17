/**
 * Pure helpers for the Tenants MCP Settings form (MTG-4.1 / #4780, MTG-4.2 / #4781,
 * MTG-5.1 / #4785 capability presets).
 *
 * Merges the MTG-1.1 catalog with the stored MTG-3.1 policy so every registry
 * tool appears as a row. Missing policy rows get display defaults from
 * `default_mode` (see EFFECTIVE_POLICY.md). Toolset grouping powers the
 * master-switch UX. Named capability presets apply a toolset enable matrix.
 */

import type {
  McpToolCatalogItem,
  TenantDefaultMode,
  TenantMcpPolicyPutRequest,
  TenantMcpPolicyResponse,
  TenantMcpPolicyTool,
} from './mcpPolicyApi';

export interface McpPolicyToolRow extends TenantMcpPolicyTool {
  description: string;
  toolset: string;
}

export interface McpPolicyFormState {
  default_mode: TenantDefaultMode;
  allow_anonymous_mcp: boolean;
  tools: McpPolicyToolRow[];
}

/** Flags applied when a catalog tool has no stored policy row. */
export function defaultFlagsForMode(mode: TenantDefaultMode): Omit<TenantMcpPolicyTool, 'tool_id'> {
  if (mode === 'explicit') {
    return { in_ceiling: false, default_enabled: false, anonymous_enabled: true };
  }
  // `all` and `inherit_registry`: missing rows behave as in-ceiling + default-enabled.
  return { in_ceiling: true, default_enabled: true, anonymous_enabled: true };
}

/** Merge catalog descriptors with stored policy rows into an editable form. */
export function mcpPolicyFormFromSources(
  policy: TenantMcpPolicyResponse,
  catalog: McpToolCatalogItem[],
): McpPolicyFormState {
  const byId = new Map(policy.tools.map((t) => [t.tool_id, t]));
  const defaults = defaultFlagsForMode(policy.default_mode);

  const tools: McpPolicyToolRow[] = catalog.map((item) => {
    const stored = byId.get(item.id);
    if (stored) {
      return {
        tool_id: item.id,
        description: item.description,
        toolset: item.toolset,
        in_ceiling: stored.in_ceiling,
        default_enabled: stored.default_enabled,
        anonymous_enabled: stored.anonymous_enabled,
      };
    }
    return {
      tool_id: item.id,
      description: item.description,
      toolset: item.toolset,
      ...defaults,
    };
  });

  return {
    default_mode: policy.default_mode,
    allow_anonymous_mcp: policy.allow_anonymous_mcp,
    tools,
  };
}

/** Build the PUT body from form state (full replace-all tool list). */
export function buildMcpPolicyPutBody(form: McpPolicyFormState): TenantMcpPolicyPutRequest {
  return {
    default_mode: form.default_mode,
    allow_anonymous_mcp: form.allow_anonymous_mcp,
    tools: form.tools.map(({ tool_id, in_ceiling, default_enabled, anonymous_enabled }) => ({
      tool_id,
      in_ceiling,
      default_enabled,
      anonymous_enabled,
    })),
  };
}

/** Client-side validation matching REST 422 rules. */
export function validateMcpPolicyForm(form: McpPolicyFormState): string | null {
  const seen = new Set<string>();
  for (const tool of form.tools) {
    if (!tool.tool_id.trim()) {
      return 'Each tool row requires a tool id.';
    }
    if (seen.has(tool.tool_id)) {
      return `Duplicate tool id: ${tool.tool_id}`;
    }
    seen.add(tool.tool_id);
    if (tool.default_enabled && !tool.in_ceiling) {
      return `default_enabled requires in_ceiling for tool id: ${tool.tool_id}`;
    }
  }
  return null;
}

/** True when the form differs from the last loaded baseline. */
export function hasMcpPolicyChanges(
  current: McpPolicyFormState,
  baseline: McpPolicyFormState,
): boolean {
  if (current.default_mode !== baseline.default_mode) return true;
  if (current.allow_anonymous_mcp !== baseline.allow_anonymous_mcp) return true;
  if (current.tools.length !== baseline.tools.length) return true;
  for (let i = 0; i < current.tools.length; i += 1) {
    const a = current.tools[i];
    const b = baseline.tools[i];
    if (
      a.tool_id !== b.tool_id ||
      a.in_ceiling !== b.in_ceiling ||
      a.default_enabled !== b.default_enabled ||
      a.anonymous_enabled !== b.anonymous_enabled
    ) {
      return true;
    }
  }
  return false;
}

/** How the three per-tool flags read in the unsaved-changes summary. */
const TOOL_FLAG_SUMMARY_LABELS = {
  in_ceiling: 'ceiling',
  default_enabled: 'default',
  anonymous_enabled: 'anonymous',
} as const;

/** At most this many changes are named before the summary switches to a count. */
const SUMMARY_MAX_ITEMS = 2;

/**
 * Name what the draft would change, for the dirty bar's sub-line (HIVE-5.1, #5304).
 *
 * The mockup's sticky bar reads "Unsaved MCP settings changes · lint.waive removed from
 * ceiling", and the second half is the half that saves a reader from re-reading four toolset
 * cards to find what they touched. Long edits collapse to a count rather than growing a bar
 * that pushes the Save button off the end of its own row.
 *
 * @param current The draft.
 * @param baseline The last-loaded policy.
 * @returns A short phrase, or `''` when the draft matches the baseline.
 */
export function summariseMcpPolicyChanges(
  current: McpPolicyFormState,
  baseline: McpPolicyFormState,
): string {
  const changes: string[] = [];

  if (current.default_mode !== baseline.default_mode) changes.push('default mode');
  if (current.allow_anonymous_mcp !== baseline.allow_anonymous_mcp) {
    changes.push(`anonymous calls ${current.allow_anonymous_mcp ? 'on' : 'off'}`);
  }

  const baselineById = new Map(baseline.tools.map((tool) => [tool.tool_id, tool]));
  for (const tool of current.tools) {
    const before = baselineById.get(tool.tool_id);
    if (!before) continue;
    for (const flag of ['in_ceiling', 'default_enabled', 'anonymous_enabled'] as const) {
      if (tool[flag] === before[flag]) continue;
      const verb = tool[flag] ? 'added to' : 'removed from';
      changes.push(`${tool.tool_id} ${verb} ${TOOL_FLAG_SUMMARY_LABELS[flag]}`);
    }
  }

  if (changes.length === 0) return '';
  if (changes.length <= SUMMARY_MAX_ITEMS) return changes.join(' · ');
  return `${changes.length} changes across modes and tool flags`;
}

/**
 * Update one tool flag. Clearing `in_ceiling` also clears `default_enabled`
 * so the form stays REST-valid.
 */
export function patchToolFlag(
  form: McpPolicyFormState,
  toolId: string,
  flag: 'in_ceiling' | 'default_enabled' | 'anonymous_enabled',
  value: boolean,
): McpPolicyFormState {
  return {
    ...form,
    tools: form.tools.map((row) => {
      if (row.tool_id !== toolId) return row;
      if (flag === 'in_ceiling') {
        return {
          ...row,
          in_ceiling: value,
          default_enabled: value ? row.default_enabled : false,
        };
      }
      if (flag === 'default_enabled' && value && !row.in_ceiling) {
        return row;
      }
      return { ...row, [flag]: value };
    }),
  };
}

/** Canonical MTG-1.1 toolset order for grouped toggles. */
export const MCP_TOOLSET_ORDER = [
  'health',
  'catalog',
  'search',
  'document',
  'structure',
] as const;

export type ToolsetToggleState = 'all' | 'none' | 'mixed';

export interface McpToolsetGroup {
  toolset: string;
  tools: McpPolicyToolRow[];
  ceilingState: ToolsetToggleState;
  inCeilingCount: number;
}

function ceilingStateForTools(tools: McpPolicyToolRow[]): ToolsetToggleState {
  if (tools.length === 0) return 'none';
  const enabled = tools.filter((t) => t.in_ceiling).length;
  if (enabled === 0) return 'none';
  if (enabled === tools.length) return 'all';
  return 'mixed';
}

/**
 * Group form rows by toolset for the MTG-4.2 toggle UX.
 * Known toolsets follow `MCP_TOOLSET_ORDER`; any others sort alphabetically after.
 */
export function groupToolsByToolset(tools: McpPolicyToolRow[]): McpToolsetGroup[] {
  const bySet = new Map<string, McpPolicyToolRow[]>();
  for (const tool of tools) {
    const key = tool.toolset || 'other';
    const list = bySet.get(key);
    if (list) list.push(tool);
    else bySet.set(key, [tool]);
  }

  const known = new Set<string>(MCP_TOOLSET_ORDER);
  const ordered: string[] = [
    ...MCP_TOOLSET_ORDER.filter((name) => bySet.has(name)),
    ...[...bySet.keys()].filter((name) => !known.has(name)).sort(),
  ];

  return ordered.map((toolset) => {
    const groupTools = bySet.get(toolset) ?? [];
    return {
      toolset,
      tools: groupTools,
      ceilingState: ceilingStateForTools(groupTools),
      inCeilingCount: groupTools.filter((t) => t.in_ceiling).length,
    };
  });
}

/**
 * Master toolset switch: set ceiling (and defaults) for every tool in the set.
 * ON → in_ceiling + default_enabled; OFF → both false. Leaves anonymous flags alone.
 */
export function patchToolsetCeiling(
  form: McpPolicyFormState,
  toolset: string,
  enabled: boolean,
): McpPolicyFormState {
  return {
    ...form,
    tools: form.tools.map((row) => {
      if (row.toolset !== toolset) return row;
      return {
        ...row,
        in_ceiling: enabled,
        default_enabled: enabled,
      };
    }),
  };
}

/** UI sentinel when the draft does not match a named capability pack. */
export const MCP_CUSTOM_PRESET_ID = 'custom';

export interface McpCapabilityPresetDef {
  id: string;
  label: string;
  toolsets: readonly string[];
}

/**
 * Apply a named capability preset matrix to the draft form.
 * Tools in `enabledToolsets` get in_ceiling + default_enabled; others clear both.
 * Leaves anonymous_enabled, default_mode, and allow_anonymous_mcp unchanged.
 */
export function applyCapabilityPreset(
  form: McpPolicyFormState,
  enabledToolsets: readonly string[],
): McpPolicyFormState {
  const enabled = new Set(enabledToolsets);
  return {
    ...form,
    tools: form.tools.map((row) => {
      const on = enabled.has(row.toolset);
      return {
        ...row,
        in_ceiling: on,
        default_enabled: on,
      };
    }),
  };
}

/**
 * Match the draft to a named preset, or `custom` when mixed / non-matching.
 * Empty tool list or any toolset with mixed ceiling → custom.
 */
export function matchCapabilityPreset(
  form: McpPolicyFormState,
  presets: readonly McpCapabilityPresetDef[],
): string {
  const groups = groupToolsByToolset(form.tools);
  if (groups.length === 0) return MCP_CUSTOM_PRESET_ID;
  if (groups.some((g) => g.ceilingState === 'mixed')) return MCP_CUSTOM_PRESET_ID;

  const enabled = new Set(
    groups.filter((g) => g.ceilingState === 'all').map((g) => g.toolset),
  );

  for (const preset of presets) {
    if (preset.toolsets.length !== enabled.size) continue;
    if (preset.toolsets.every((t) => enabled.has(t))) return preset.id;
  }
  return MCP_CUSTOM_PRESET_ID;
}
