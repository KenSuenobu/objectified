/**
 * Pure model + helpers for the Type Registry Settings view (#3472).
 *
 * Mirrors the REST settings contract (`GET`/`PUT /v1/types/{tenant_slug}/settings`, #3472) and
 * provides the option lists, defaults, allowlist (de)serialization, and change-diffing the
 * Settings view needs. Kept free of React/DOM so it is unit-testable.
 */

export type DefaultDraft = '2020-12' | '2019-09' | 'draft-07';
export type RefStyle = 'relative' | 'absolute' | 'anchor';
export type CircularRefPolicy = 'error' | 'warn';
export type ImportScope = 'tenant' | 'system';
export type CorePublishRole = 'platform_admin' | 'tenant_admin' | 'maintainer';

/** The full set of type-registry settings (mirrors REST `TypeRegistrySettingsSchema`). */
export interface TypeRegistrySettings {
  // JSON Schema dialect
  default_draft: DefaultDraft;
  strict_validation: boolean;
  allow_annotation_keywords: boolean;
  coerce_imported_drafts: boolean;

  // Reference resolution
  resolution_base_url: string;
  ref_style: RefStyle;
  allow_remote_refs: boolean;
  remote_host_allowlist: string[];
  max_resolution_depth: number;
  circular_ref_policy: CircularRefPolicy;

  // Import defaults
  default_import_scope: ImportScope;
  default_target_namespace: string | null;
  rewrite_refs_on_import: boolean;
  accepted_formats: string[];
  dedupe_identical_types: boolean;

  // Validation & publishing governance
  validate_on_save: boolean;
  block_publish_on_errors: boolean;
  core_publish_role: CorePublishRole;
}

/** Settings plus the server-provided provenance/`is_default` flags (the GET response shape). */
export interface TypeRegistrySettingsResponse extends TypeRegistrySettings {
  is_default: boolean;
  updated_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Registry storage health (mirrors REST `RegistryHealthResponse`, #3450). */
export interface RegistryHealth {
  status: 'healthy' | 'unhealthy';
  service?: string;
  database?: string;
  connection: 'connected' | 'disconnected';
  storage_present: boolean;
  error?: string | null;
}

/** The registry defaults, byte-for-byte the REST/DB defaults so the UI matches an unsaved tenant. */
export const DEFAULT_SETTINGS: TypeRegistrySettings = {
  default_draft: '2020-12',
  strict_validation: true,
  allow_annotation_keywords: true,
  coerce_imported_drafts: true,
  resolution_base_url: 'https://api.apiome.dev/types/',
  ref_style: 'relative',
  allow_remote_refs: false,
  remote_host_allowlist: ['json-schema.org', 'spec.openapis.org'],
  max_resolution_depth: 12,
  circular_ref_policy: 'error',
  default_import_scope: 'tenant',
  default_target_namespace: null,
  rewrite_refs_on_import: true,
  accepted_formats: ['json-schema-2020-12', 'type-def-bundle', 'openapi-3.1'],
  dedupe_identical_types: true,
  validate_on_save: true,
  block_publish_on_errors: true,
  core_publish_role: 'platform_admin',
};

/** Inclusive bounds for the max-resolution-depth control (mirrors the DB CHECK constraint). */
export const MIN_RESOLUTION_DEPTH = 1;
export const MAX_RESOLUTION_DEPTH = 64;

export const DRAFT_OPTIONS: { value: DefaultDraft; label: string }[] = [
  { value: '2020-12', label: '2020-12' },
  { value: '2019-09', label: '2019-09' },
  { value: 'draft-07', label: 'draft-07 (import compatibility)' },
];

export const REF_STYLE_OPTIONS: { value: RefStyle; label: string }[] = [
  { value: 'relative', label: 'Relative (recommended)' },
  { value: 'absolute', label: 'Absolute $id' },
  { value: 'anchor', label: 'Anchor (#/$defs)' },
];

export const CIRCULAR_POLICY_OPTIONS: { value: CircularRefPolicy; label: string }[] = [
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
];

export const IMPORT_SCOPE_OPTIONS: { value: ImportScope; label: string }[] = [
  { value: 'tenant', label: 'Tenant' },
  { value: 'system', label: 'System · core' },
];

export const CORE_PUBLISH_ROLE_OPTIONS: { value: CorePublishRole; label: string }[] = [
  { value: 'platform_admin', label: 'Platform admin' },
  { value: 'tenant_admin', label: 'Tenant admin' },
  { value: 'maintainer', label: 'Maintainer' },
];

/** The selectable import formats (the checkbox set), with stable values matching the DB defaults. */
export const ACCEPTED_FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: 'json-schema-2020-12', label: 'JSON Schema 2020-12' },
  { value: 'type-def-bundle', label: 'Type-definition bundle (.zip/.json)' },
  { value: 'openapi-3.1', label: 'OpenAPI 3.1 components' },
  { value: 'avro-protobuf', label: 'Avro / Protobuf (experimental)' },
];

/** The keys that make up the persistable settings (everything except server provenance). */
export const SETTINGS_KEYS: (keyof TypeRegistrySettings)[] = [
  'default_draft',
  'strict_validation',
  'allow_annotation_keywords',
  'coerce_imported_drafts',
  'resolution_base_url',
  'ref_style',
  'allow_remote_refs',
  'remote_host_allowlist',
  'max_resolution_depth',
  'circular_ref_policy',
  'default_import_scope',
  'default_target_namespace',
  'rewrite_refs_on_import',
  'accepted_formats',
  'dedupe_identical_types',
  'validate_on_save',
  'block_publish_on_errors',
  'core_publish_role',
];

/**
 * Normalize an arbitrary API payload into a complete {@link TypeRegistrySettings}, filling any
 * missing field from {@link DEFAULT_SETTINGS}. Tolerant of a `null`/partial response so the form
 * always has a complete, valid starting state.
 */
export function coerceSettings(raw: Partial<TypeRegistrySettings> | null | undefined): TypeRegistrySettings {
  const source = raw ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    // Arrays must be copied (never share the DEFAULT_SETTINGS references) and coerced to arrays.
    remote_host_allowlist: Array.isArray(source.remote_host_allowlist)
      ? [...source.remote_host_allowlist]
      : [...DEFAULT_SETTINGS.remote_host_allowlist],
    accepted_formats: Array.isArray(source.accepted_formats)
      ? [...source.accepted_formats]
      : [...DEFAULT_SETTINGS.accepted_formats],
  };
}

/** Split a textarea value (newline- or comma-separated) into a trimmed, de-duplicated host list. */
export function parseAllowlist(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of text.split(/[\n,]/)) {
    const host = token.trim();
    if (host && !seen.has(host)) {
      seen.add(host);
      result.push(host);
    }
  }
  return result;
}

/** Render a host allowlist back into newline-separated textarea text. */
export function formatAllowlist(hosts: string[]): string {
  return hosts.join('\n');
}

/** Clamp a (possibly out-of-range or NaN) depth into the allowed bounds. */
export function clampDepth(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_SETTINGS.max_resolution_depth;
  return Math.min(MAX_RESOLUTION_DEPTH, Math.max(MIN_RESOLUTION_DEPTH, Math.trunc(value)));
}

/** Toggle a value's membership in a list, preserving order (used for the accepted-formats checkboxes). */
export function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Order-insensitive equality for two string lists (so checkbox/host reordering is not a "change"). */
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

/** True when two settings field values are equal (sets compared order-insensitively). */
function fieldEquals(key: keyof TypeRegistrySettings, a: TypeRegistrySettings, b: TypeRegistrySettings): boolean {
  if (key === 'remote_host_allowlist' || key === 'accepted_formats') {
    return sameStringSet(a[key] as string[], b[key] as string[]);
  }
  return a[key] === b[key];
}

/**
 * Build the minimal PUT payload: only the fields that differ between the saved baseline and the
 * current form. Returns an empty object when nothing changed (the view can then skip the save).
 */
export function diffSettings(
  baseline: TypeRegistrySettings,
  current: TypeRegistrySettings
): Partial<TypeRegistrySettings> {
  const payload: Partial<TypeRegistrySettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (!fieldEquals(key, baseline, current)) {
      (payload[key] as unknown) = current[key];
    }
  }
  return payload;
}

/** True when the current form differs from the saved baseline. */
export function hasChanges(baseline: TypeRegistrySettings, current: TypeRegistrySettings): boolean {
  return SETTINGS_KEYS.some((key) => !fieldEquals(key, baseline, current));
}
