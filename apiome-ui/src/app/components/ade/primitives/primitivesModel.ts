/**
 * The rules the primitives & types registry screen runs on (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` and its **Notes → Keeps (1:1)** list.
 *
 * Everything here used to live inside JSX — which sentence the KPI strip's foot prints, which
 * tone a namespace row's scope pill takes, what the collections foot counts, what the delete
 * confirm says, how a removed namespace is described. That made each of them testable only by
 * rendering the whole screen, and it let the same rule be spelled twice: the types table and
 * the collections panel each carried their own "System · core" pill, the registry tab and the
 * namespaces tab each carried their own reading of `scope`.
 *
 * The module is pure — no React, no fetch, no DOM — so `tests/primitives-registry-model.test.ts`
 * can pin the whole vocabulary of the screen without mounting anything.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import type {
  PrimitiveImportActivity,
  RegistryCoverageStats,
  TypeNamespaceCollection,
} from '@/app/ade/dashboard/primitives/primitivesRegistryTypes';

// ---------------------------------------------------------------------------------------
// The screen itself
// ---------------------------------------------------------------------------------------

/** Where the screen lives, for the links that come back to it. */
export const PRIMITIVES_ROUTE = '/ade/dashboard/primitives';

/** One primitive's detail page. */
export function primitiveDetailHref(id: string): string {
  return `${PRIMITIVES_ROUTE}/${id}`;
}

/** The four panes of the screen, in the order the mockup's tab row draws them. */
export type PrimitivesView = 'registry' | 'namespaces' | 'resolver' | 'settings';

/** Tab labels, as the mockup words them. */
export const PRIMITIVES_VIEW_LABEL: Readonly<Record<PrimitivesView, string>> = {
  registry: 'Registry',
  namespaces: 'Namespaces & scopes',
  resolver: 'Resolver',
  settings: 'Settings',
};

/** The tab order, so the strip and the deep-link parser agree on what exists. */
export const PRIMITIVES_VIEWS: readonly PrimitivesView[] = [
  'registry',
  'namespaces',
  'resolver',
  'settings',
];

/**
 * The query parameter the KPI strip's amber tile and the `$ref` explainer used to link with.
 *
 * Both pointed at `?focus=resolver`, and **nothing read it** — the screen opened on Registry and
 * stayed there, so the one affordance offered for "3 unresolved refs, go and look" was a link
 * that appeared to do nothing. The mockup's *Adds* asks for those two to switch tabs; they do
 * that directly now, and this parser is what makes the address still work when it is pasted.
 *
 * @param value The raw `?focus=` value, or `null` when the parameter is absent.
 * @returns The view to open, or `null` to leave the screen on its default.
 */
export function viewFromFocusParam(value: string | null | undefined): PrimitivesView | null {
  if (!value) return null;
  const candidate = value.trim().toLowerCase();
  return (PRIMITIVES_VIEWS as readonly string[]).includes(candidate)
    ? (candidate as PrimitivesView)
    : null;
}

// ---------------------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------------------

/** One tile of the registry KPI strip. */
export interface RegistryKpi {
  /** Stable id — the React key and the tile's `data-testid` suffix. */
  id: 'core' | 'tenant' | 'imported' | 'bound' | 'unresolved';
  /** The tile's caption. */
  label: string;
  /** The figure, already formatted for the reader's locale. */
  value: string;
  /** The quiet line under the figure. */
  foot: string;
  /** Whether the figure is set in the tile's own tone rather than in `--fg`. */
  tone?: StatusTone;
  /** True when the tile is asking to be acted on — the unresolved-`$ref` count above zero. */
  alert?: boolean;
}

/**
 * The five tiles of the registry strip.
 *
 * The counts come from `GET /api/primitives/stats` unchanged; what this decides is the
 * *wording* — singular or plural namespaces and classes, and the honest "no bindings yet"
 * rather than "across 0 classes".
 *
 * @param stats The coverage stats, or `null` before the first read lands.
 * @returns The five tiles, or an empty array when there is nothing to draw yet.
 */
export function registryKpis(stats: RegistryCoverageStats | null): RegistryKpi[] {
  if (!stats) return [];

  const namespaces = stats.namespace_count;
  const classes = stats.bound_class_count;
  const unresolved = stats.unresolved_ref_count;

  return [
    {
      id: 'core',
      label: 'Core system types',
      value: stats.core_type_count.toLocaleString(),
      foot: 'std/* · all tenants',
      tone: 'accent',
    },
    {
      id: 'tenant',
      label: 'Tenant types',
      value: stats.tenant_type_count.toLocaleString(),
      foot: `${namespaces.toLocaleString()} namespace${namespaces === 1 ? '' : 's'}`,
    },
    {
      id: 'imported',
      label: 'Imported schemas',
      value: stats.imported_count.toLocaleString(),
      foot: 'JSON Schema + bundles',
    },
    {
      id: 'bound',
      label: 'Properties bound',
      value: stats.properties_bound_count.toLocaleString(),
      foot:
        classes > 0
          ? `across ${classes.toLocaleString()} class${classes === 1 ? '' : 'es'}`
          : 'no bindings yet',
    },
    {
      id: 'unresolved',
      label: 'Unresolved $ref',
      value: unresolved.toLocaleString(),
      foot: unresolved > 0 ? 'open resolver →' : 'every $ref resolves',
      tone: unresolved > 0 ? 'warn' : undefined,
      alert: unresolved > 0,
    },
  ];
}

// ---------------------------------------------------------------------------------------
// Scopes, namespaces and their pills
// ---------------------------------------------------------------------------------------

/** A pill: what it says, and which tone of the shared vocabulary says it. */
export interface TonedLabel {
  /** The pill's text. */
  label: string;
  /** Its tone, resolved through `ui/statusVocabulary`. */
  tone: StatusTone;
}

/** The scope segmented control above the collections table. */
export const NAMESPACE_SCOPE_FILTERS: readonly { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'System · core' },
  { id: 'tenant', label: 'Tenant' },
  { id: 'imported', label: 'Imported' },
];

/**
 * The scope pill for a namespace row.
 *
 * `system` is `ok` and `tenant` is `violet`, which is what the mockup paints and what
 * DESIGN.md §3.1 reserves violet for (visibility: a tenant's own, private). A group whose
 * members disagree says so rather than picking a winner, and a row that is not a registered
 * collection at all — a detected path, the unassigned bucket — has no scope to show.
 *
 * @param scope The row's scope, or `null` when it has none.
 * @param mixed True for a group row whose members span both scopes.
 * @returns The pill, or `null` when the cell should print an em dash.
 */
export function namespaceScopeBadge(
  scope: 'system' | 'tenant' | null | undefined,
  mixed = false
): TonedLabel | null {
  if (mixed) return { label: 'Mixed', tone: 'neutral' };
  if (scope === 'system') return { label: 'System · core', tone: 'ok' };
  if (scope === 'tenant') return { label: 'Tenant', tone: 'violet' };
  return null;
}

/**
 * The resolution pill at the end of a collections row.
 *
 * @param unresolvedCount How many `$ref` under this namespace do not resolve.
 * @returns `Resolved`, or the amber count.
 */
export function namespaceStatusBadge(unresolvedCount: number): TonedLabel {
  return unresolvedCount > 0
    ? { label: `${unresolvedCount} unresolved`, tone: 'warn' }
    : { label: 'Resolved', tone: 'ok' };
}

/**
 * The base URI, trimmed to its path for the namespaces table.
 *
 * Mirrors the mockup's `…/types/std/v0/types/`: the host is the same on every row, so
 * printing it seven times spends the column's width on the one part that never varies.
 *
 * @param baseUri The absolute base URI.
 * @returns The elided path, or the input when it will not parse as a URL.
 */
export function shortBaseUri(baseUri: string): string {
  try {
    return `…${new URL(baseUri).pathname}`;
  } catch {
    return baseUri;
  }
}

/**
 * What removing a namespace registration actually does, spelled out for the confirm dialog.
 *
 * This list is referential: `apiome.primitives.namespace` is a string column with no foreign
 * key to `apiome.type_namespaces`. Removing a row therefore deletes no types — a reader who
 * assumes otherwise would never click the button, so the count and the consequence are both
 * stated.
 *
 * @param namespace The registration about to be removed.
 * @returns The dialog's message.
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

// ---------------------------------------------------------------------------------------
// The types table
// ---------------------------------------------------------------------------------------

/** The sentinel the unassigned row filters with; matches types whose namespace is null or blank. */
export const UNASSIGNED_NAMESPACE_KEY = '';

/** A namespace filter coming from the collections panel: one namespace, or a whole family. */
export interface NamespaceSelection {
  /** The namespace path, or {@link UNASSIGNED_NAMESPACE_KEY} for the no-namespace bucket. */
  value: string;
  /** True when a group row was clicked, so every descendant path matches too. */
  includeDescendants: boolean;
}

/**
 * The label on the namespace filter chip.
 *
 * A group and its own root namespace share a path, so the `/*` suffix is the only thing that
 * tells the reader which of the two rows they clicked.
 *
 * @param selection The active selection.
 * @returns The chip's text.
 */
export function namespaceFilterChipLabel(selection: NamespaceSelection): string {
  if (selection.value === UNASSIGNED_NAMESPACE_KEY) return 'Namespace: Unassigned';
  return `Namespace: ${selection.value}${selection.includeDescendants ? '/*' : ''}`;
}

/** Whether a type is the platform's or the tenant's, as a pill. */
export function primitiveScopeBadge(isSystem: boolean): TonedLabel {
  return isSystem ? { label: 'System', tone: 'accent' } : { label: 'Tenant', tone: 'ok' };
}

/** Why a system row's Edit button is inert. */
export const SYSTEM_EDIT_TOOLTIP = 'System primitives cannot be edited';

/** Why a system row's Delete button is inert. */
export const SYSTEM_DELETE_TOOLTIP = 'System primitives cannot be deleted';

/**
 * The types table's foot.
 *
 * @param shown How many rows survived the filters.
 * @param total How many types the tenant has in all.
 * @param filtered Whether any filter is narrowing the list.
 * @returns The count sentence.
 */
export function typesFootLabel(shown: number, total: number, filtered: boolean): string {
  const head = `${shown.toLocaleString()} of ${total.toLocaleString()} type${total === 1 ? '' : 's'}`;
  return filtered ? `${head} · filtered` : head;
}

/**
 * The delete confirm for one primitive.
 *
 * The usage count is part of the question rather than a detail below it: deleting a type that
 * fourteen classes bind is a different decision from deleting one nothing uses.
 *
 * @param primitive The type about to be deleted.
 * @returns Title, message and the destructive verb.
 */
export function deletePrimitiveConfirm(primitive: {
  name: string;
  usage_count: number;
}): { title: string; message: string; confirmLabel: string } {
  const used =
    primitive.usage_count > 0
      ? ` This primitive is currently used in ${primitive.usage_count} place${
          primitive.usage_count === 1 ? '' : 's'
        }.`
      : '';

  return {
    title: 'Delete primitive',
    message: `Are you sure you want to delete the primitive “${primitive.name}”?${used}`,
    confirmLabel: 'Delete',
  };
}

// ---------------------------------------------------------------------------------------
// Type collections
// ---------------------------------------------------------------------------------------

/** What the collections panel's foot counts. */
export interface CollectionsFootCounts {
  /** Collections left after the scope filter. */
  shown: number;
  /** Collections the registry returned in all. */
  total: number;
  /** Group rows currently standing in for two or more collections. */
  groups: number;
  /** Namespaces types use that were never registered. */
  unregistered: number;
  /** Types saved with no namespace at all. */
  unassigned: number;
}

/**
 * The collections panel's foot, as the mockup words it:
 * `6 of 6 collections · 1 group · 1 unregistered · 1 unassigned`.
 *
 * Every clause is dropped when its count is zero, so a tenant with one flat namespace reads
 * `1 of 1 collection` rather than a row of zeroes.
 *
 * @param counts What to say.
 * @returns The sentence.
 */
export function collectionsFootLabel(counts: CollectionsFootCounts): string {
  const parts = [
    `${counts.shown} of ${counts.total} collection${counts.total === 1 ? '' : 's'}`,
  ];
  if (counts.groups > 0) parts.push(`${counts.groups} group${counts.groups === 1 ? '' : 's'}`);
  if (counts.unregistered > 0) parts.push(`${counts.unregistered} unregistered`);
  if (counts.unassigned > 0) parts.push(`${counts.unassigned} unassigned`);
  return parts.join(' · ');
}

/** The grouped / flat toggle's tooltip, which explains what grouping does. */
export const GROUP_TOGGLE_HINT =
  'Collapse namespaces that share a parent path into one row';

/** The collections panel's subtitle, which changes with the Group toggle. */
export function collectionsSubtitle(grouped: boolean): string {
  return grouped
    ? 'Grouped by parent namespace · click a row to filter types below, a column to sort'
    : 'One row per namespace · click a row to filter types below, a column to sort';
}

// ---------------------------------------------------------------------------------------
// The right rail
// ---------------------------------------------------------------------------------------

/** One line of the `$ref` resolution example, and whether it is a comment. */
export interface RefExampleLine {
  /** The line's text. */
  text: string;
  /** True for the `#`-prefixed explanatory lines, which are set quieter. */
  comment: boolean;
}

/**
 * The worked `$ref` example on the registry rail.
 *
 * Held here rather than inline so the CSS suite can assert the block is drawn from data (and
 * therefore that the comment lines are the only ones tinted) without parsing JSX.
 */
export const REF_RESOLUTION_EXAMPLE: readonly RefExampleLine[] = [
  { text: '# std/v0/types/date', comment: true },
  { text: '"$ref": "../primitives/string"', comment: false },
  { text: '# base api.apiome.dev/types/std/v0/types/', comment: true },
  { text: '# resolves → std/v0/primitives/string', comment: true },
];

/**
 * The dot beside a recent import, by what was imported.
 *
 * The three source kinds keep the three tones the mockup gives them — a bundle is `ok`, an
 * OpenAPI document is `violet`, a bare JSON Schema is `accent` — so the rail can be read as a
 * legend without one.
 *
 * @param sourceKind The import's `source_kind`.
 * @returns The dot's tone.
 */
export function importActivityTone(sourceKind: string): StatusTone {
  if (sourceKind === 'type-def-bundle') return 'ok';
  if (sourceKind === 'openapi') return 'violet';
  return 'accent';
}

/**
 * The headline of one recent-import row: `Imported acme-types.json (12 types)`.
 *
 * @param item The import record.
 * @returns The title, with the count dropped when the import brought nothing in.
 */
export function importActivityTitle(item: PrimitiveImportActivity): string {
  const count =
    item.imported_count > 0
      ? ` (${item.imported_count} type${item.imported_count === 1 ? '' : 's'})`
      : '';
  return `Imported ${item.source_label ?? 'schema'}${count}`;
}

// ---------------------------------------------------------------------------------------
// Namespaces & scopes
// ---------------------------------------------------------------------------------------

/** One of the two scope-model explainer cards at the top of the Namespaces tab. */
export interface ScopeExplainer {
  /** Card id, for the key and the test id. */
  id: 'system' | 'tenant';
  /** Card title. */
  title: string;
  /** The path pattern the card is about. */
  pattern: string;
  /** What that scope means, in one sentence. */
  body: string;
  /** The base URI the scope resolves under. */
  baseUri: string;
  /** The card's tone. */
  tone: StatusTone;
}

/** The two scope-model cards, worded as the mockup words them. */
export const SCOPE_EXPLAINERS: readonly ScopeExplainer[] = [
  {
    id: 'system',
    title: 'System root (core)',
    pattern: 'std/*',
    body:
      'core system types curated by the platform; visible to all tenants; immutable except by ' +
      'platform governance.',
    baseUri: 'api.apiome.dev/types/std/',
    tone: 'ok',
  },
  {
    id: 'tenant',
    title: 'Tenant namespaces',
    pattern: 'tenant/<slug>/*',
    body:
      'a tenant’s private types; can reference core types but are isolated from other tenants.',
    baseUri: 'api.apiome.dev/types/tenant/<slug>/',
    tone: 'violet',
  },
];

/** One rung of the scope precedence ladder. */
export interface PrecedenceStep {
  /** Its 1-based rank, which is also what the pill prints. */
  rank: number;
  /** The scope's name. */
  title: string;
  /** The path shape, set in mono beside the name. */
  pattern: string;
  /** Why it sits where it sits. */
  body: string;
}

/** How a property's type lookup resolves, most specific first. */
export const SCOPE_PRECEDENCE: readonly PrecedenceStep[] = [
  {
    rank: 1,
    title: 'Tenant namespace',
    pattern: '(tenant/<slug>/…)',
    body: 'Most specific — the tenant’s own private types win.',
  },
  {
    rank: 2,
    title: 'Imported vendor namespaces',
    pattern: '(vendor/…)',
    body: 'Vendor schemas imported for that tenant.',
  },
  {
    rank: 3,
    title: 'System core',
    pattern: '(std/…)',
    body: 'Shared fallback available to every tenant.',
  },
];

/** The caution under the precedence ladder. */
export const SCOPE_ISOLATION_NOTE =
  'Core types may be referenced by tenant types; tenant types are never visible across ' +
  'tenants or from core.';

/** The promote-to-core card's worked example and why its button is inert. */
export const PROMOTE_TO_CORE = {
  /** What the card is for. */
  description: 'Promote a vetted tenant type into std/* so all tenants can use it.',
  /** The tenant-scoped type in the example. */
  from: 'tenant/acme/v1/types/money',
  /** Where promotion would put it. */
  to: 'std/v0/types/money',
  /** Why the verb cannot be used from here. */
  gate: 'requires platform admin approval',
} as const;

// ---------------------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------------------

/** The status segmented control above the reference table. */
export const RESOLVER_STATUS_FILTERS: readonly { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'unresolved', label: 'Unresolved' },
  { id: 'circular', label: 'Circular' },
];

/**
 * The reference table's foot: `4 of 38 references shown`.
 *
 * @param shown How many edges the filters left.
 * @param total How many edges the resolver returned.
 * @returns The count sentence.
 */
export function resolverFootLabel(shown: number, total: number): string {
  return `${shown} of ${total} reference${total === 1 ? '' : 's'} shown`;
}

/**
 * What a Re-resolve run is toasted as.
 *
 * @param updated How many primitives changed status.
 * @returns The toast's text.
 */
export function reresolveSummary(updated: number): string {
  return updated > 0
    ? `Re-resolved · ${updated} primitive${updated === 1 ? '' : 's'} updated`
    : 'Re-resolved · all statuses already current';
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

/** The banner shown while a tenant is still on the registry defaults. */
export const SETTINGS_DEFAULTS_NOTE =
  'This tenant is using the registry defaults. Save to persist a tenant-specific configuration.';

/**
 * The storage-health pill.
 *
 * @param health The probe's answer, or `null` when it could not be read.
 * @returns The pill, or `null` when the status is genuinely unknown.
 */
export function registryStorageBadge(
  health: { connection?: string; status?: string } | null
): TonedLabel | null {
  if (!health) return null;
  const connected = health.connection === 'connected' && health.status === 'healthy';
  return connected
    ? { label: 'Connected', tone: 'ok' }
    : { label: 'Unavailable', tone: 'danger' };
}
