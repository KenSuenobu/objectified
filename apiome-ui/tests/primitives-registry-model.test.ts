/**
 * The rules the primitives & types screen runs on (HIVE-6.5, #5316).
 *
 * `components/ade/primitives/primitivesModel.ts` is where the screen's vocabulary went when it
 * came out of JSX: which sentence each KPI tile's foot prints, which tone a namespace's scope
 * pill takes, what the two table feet count, what the delete confirm asks, what removing a
 * namespace registration is said to do, and which pane a `?focus=` deep link opens.
 *
 * Every one of those used to be testable only by rendering the whole screen — and several were
 * written twice, which is how the registry tab and the namespaces tab came to draw two
 * different "System · core" pills from the same `scope` field.
 */

import {
  PRIMITIVES_ROUTE,
  PRIMITIVES_VIEWS,
  PRIMITIVES_VIEW_LABEL,
  PROMOTE_TO_CORE,
  REF_RESOLUTION_EXAMPLE,
  SCOPE_EXPLAINERS,
  SCOPE_PRECEDENCE,
  UNASSIGNED_NAMESPACE_KEY,
  collectionsFootLabel,
  collectionsSubtitle,
  deletePrimitiveConfirm,
  describeNamespaceRemoval,
  importActivityTitle,
  importActivityTone,
  namespaceFilterChipLabel,
  namespaceScopeBadge,
  namespaceStatusBadge,
  primitiveDetailHref,
  primitiveScopeBadge,
  registryKpis,
  registryStorageBadge,
  reresolveSummary,
  resolverFootLabel,
  shortBaseUri,
  typesFootLabel,
  primitiveIdFromEditParam,
  viewFromFocusParam,
} from '../src/app/components/ade/primitives/primitivesModel';
import type {
  PrimitiveImportActivity,
  RegistryCoverageStats,
  TypeNamespaceCollection,
} from '../src/app/ade/dashboard/primitives/primitivesRegistryTypes';

const STATS: RegistryCoverageStats = {
  core_type_count: 24,
  tenant_type_count: 17,
  imported_count: 6,
  properties_bound_count: 88,
  bound_class_count: 31,
  unresolved_ref_count: 3,
  namespace_count: 3,
};

const NAMESPACE: TypeNamespaceCollection = {
  id: 'ns-1',
  tenant_id: 'tenant-1',
  namespace: 'tenant/acme/v1/types',
  base_uri: 'https://api.apiome.dev/types/tenant/acme/v1/types/',
  version_root: 'v1',
  description: 'Acme business types',
  scope: 'tenant',
  is_system: false,
  is_public: false,
  is_default: true,
  type_count: 12,
};

describe('the KPI strip', () => {
  it('draws the mockup’s five tiles, in its order', () => {
    expect(registryKpis(STATS).map((kpi) => kpi.id)).toEqual([
      'core',
      'tenant',
      'imported',
      'bound',
      'unresolved',
    ]);
    expect(registryKpis(STATS).map((kpi) => kpi.label)).toEqual([
      'Core system types',
      'Tenant types',
      'Imported schemas',
      'Properties bound',
      'Unresolved $ref',
    ]);
  });

  it('has nothing to draw before the first read lands', () => {
    expect(registryKpis(null)).toEqual([]);
  });

  it('says how many namespaces the tenant types are spread over, in the right number', () => {
    expect(registryKpis(STATS)[1].foot).toBe('3 namespaces');
    expect(registryKpis({ ...STATS, namespace_count: 1 })[1].foot).toBe('1 namespace');
  });

  it('says “no bindings yet” rather than “across 0 classes”', () => {
    expect(registryKpis(STATS)[3].foot).toBe('across 31 classes');
    expect(registryKpis({ ...STATS, bound_class_count: 1 })[3].foot).toBe('across 1 class');
    expect(registryKpis({ ...STATS, bound_class_count: 0 })[3].foot).toBe('no bindings yet');
  });

  it('marks the unresolved tile only when there is something to resolve', () => {
    const [unresolved] = registryKpis(STATS).slice(-1);
    expect(unresolved).toMatchObject({ alert: true, tone: 'warn', foot: 'open resolver →' });

    const [clear] = registryKpis({ ...STATS, unresolved_ref_count: 0 }).slice(-1);
    expect(clear.alert).toBe(false);
    expect(clear.tone).toBeUndefined();
    expect(clear.foot).toBe('every $ref resolves');
  });

  it('formats every figure for the reader’s locale', () => {
    const kpis = registryKpis({ ...STATS, properties_bound_count: 12345 });
    expect(kpis[3].value).toBe((12345).toLocaleString());
  });
});

describe('the tab strip and its deep link', () => {
  it('names the four panes the mockup names', () => {
    expect(PRIMITIVES_VIEWS.map((view) => PRIMITIVES_VIEW_LABEL[view])).toEqual([
      'Registry',
      'Namespaces & scopes',
      'Resolver',
      'Settings',
    ]);
  });

  it('opens the pane a ?focus= link names', () => {
    // The mockup's "Adds": `?focus=resolver` was linked from two places and read by none.
    expect(viewFromFocusParam('resolver')).toBe('resolver');
    expect(viewFromFocusParam('SETTINGS')).toBe('settings');
    expect(viewFromFocusParam(' namespaces ')).toBe('namespaces');
  });

  it('ignores a value that names no pane, rather than blanking the screen', () => {
    expect(viewFromFocusParam(null)).toBeNull();
    expect(viewFromFocusParam('')).toBeNull();
    expect(viewFromFocusParam('nonsense')).toBeNull();
  });

  it('routes a type to its own page', () => {
    expect(primitiveDetailHref('p-1')).toBe(`${PRIMITIVES_ROUTE}/p-1`);
  });

  it('admits the type id an ?edit= link names (HIVE-6.6, #5317)', () => {
    // `?focus=`'s sibling: the type-detail page linked here with `?edit=<id>` and nothing read
    // it, so "edit this type" landed on an unfiltered list of every type in the registry.
    expect(primitiveIdFromEditParam('p-money')).toBe('p-money');
    expect(primitiveIdFromEditParam('  p-money  ')).toBe('p-money');
  });

  it('treats an absent or blank ?edit= as no request at all', () => {
    expect(primitiveIdFromEditParam(null)).toBeNull();
    expect(primitiveIdFromEditParam(undefined)).toBeNull();
    expect(primitiveIdFromEditParam('')).toBeNull();
    expect(primitiveIdFromEditParam('   ')).toBeNull();
  });
});

describe('scope and status pills', () => {
  it('gives each scope the tone the design language reserves for it', () => {
    expect(namespaceScopeBadge('system')).toEqual({ label: 'System · core', tone: 'ok' });
    expect(namespaceScopeBadge('tenant')).toEqual({ label: 'Tenant', tone: 'violet' });
  });

  it('says “Mixed” for a group whose members disagree, rather than picking a winner', () => {
    expect(namespaceScopeBadge('tenant', true)).toEqual({ label: 'Mixed', tone: 'neutral' });
    expect(namespaceScopeBadge(null, true)).toEqual({ label: 'Mixed', tone: 'neutral' });
  });

  it('has no pill at all for a row that is not a registered collection', () => {
    expect(namespaceScopeBadge(null)).toBeNull();
    expect(namespaceScopeBadge(undefined)).toBeNull();
  });

  it('counts unresolved refs in the status pill, and says Resolved at zero', () => {
    expect(namespaceStatusBadge(0)).toEqual({ label: 'Resolved', tone: 'ok' });
    expect(namespaceStatusBadge(2)).toEqual({ label: '2 unresolved', tone: 'warn' });
  });

  it('separates a platform type from a tenant’s own', () => {
    expect(primitiveScopeBadge(true)).toEqual({ label: 'System', tone: 'accent' });
    expect(primitiveScopeBadge(false)).toEqual({ label: 'Tenant', tone: 'ok' });
  });
});

describe('the namespace filter chip', () => {
  it('names the namespace it is filtering by', () => {
    expect(namespaceFilterChipLabel({ value: 'std/v0/types', includeDescendants: false })).toBe(
      'Namespace: std/v0/types'
    );
  });

  it('marks a family selection, which shares its path with the row above it', () => {
    // A group row and the collection registered at its prefix are the same string; the suffix
    // is the only thing that tells the reader which of the two they clicked.
    expect(namespaceFilterChipLabel({ value: 'tenant/v1', includeDescendants: true })).toBe(
      'Namespace: tenant/v1/*'
    );
  });

  it('names the no-namespace bucket in words rather than as an empty string', () => {
    expect(
      namespaceFilterChipLabel({ value: UNASSIGNED_NAMESPACE_KEY, includeDescendants: false })
    ).toBe('Namespace: Unassigned');
  });
});

describe('the two table feet', () => {
  it('counts the types, and says when a filter is narrowing them', () => {
    expect(typesFootLabel(6, 41, true)).toBe('6 of 41 types · filtered');
    expect(typesFootLabel(41, 41, false)).toBe('41 of 41 types');
    expect(typesFootLabel(1, 1, false)).toBe('1 of 1 type');
  });

  it('counts the collections, dropping every clause that is zero', () => {
    expect(
      collectionsFootLabel({ shown: 6, total: 6, groups: 1, unregistered: 1, unassigned: 1 })
    ).toBe('6 of 6 collections · 1 group · 1 unregistered · 1 unassigned');
    expect(
      collectionsFootLabel({ shown: 1, total: 1, groups: 0, unregistered: 0, unassigned: 0 })
    ).toBe('1 of 1 collection');
    expect(
      collectionsFootLabel({ shown: 4, total: 9, groups: 2, unregistered: 0, unassigned: 0 })
    ).toBe('4 of 9 collections · 2 groups');
  });

  it('counts the resolver’s edges', () => {
    expect(resolverFootLabel(4, 38)).toBe('4 of 38 references shown');
    expect(resolverFootLabel(1, 1)).toBe('1 of 1 reference shown');
  });

  it('says what the Group toggle is doing to the rows above the foot', () => {
    expect(collectionsSubtitle(true)).toContain('Grouped by parent namespace');
    expect(collectionsSubtitle(false)).toContain('One row per namespace');
  });
});

describe('destructive copy', () => {
  it('names the type and how many places bind it', () => {
    expect(deletePrimitiveConfirm({ name: 'money', usage_count: 14 })).toEqual({
      title: 'Delete primitive',
      message:
        'Are you sure you want to delete the primitive “money”? This primitive is currently used in 14 places.',
      confirmLabel: 'Delete',
    });
  });

  it('uses the singular for one use, and says nothing at all for none', () => {
    expect(deletePrimitiveConfirm({ name: 'money', usage_count: 1 }).message).toContain(
      'used in 1 place.'
    );
    expect(deletePrimitiveConfirm({ name: 'money', usage_count: 0 }).message).toBe(
      'Are you sure you want to delete the primitive “money”?'
    );
  });

  it('states that removing a namespace registration deletes no types', () => {
    // `apiome.primitives.namespace` is a string column with no foreign key: a reader who
    // assumed otherwise would never click the button.
    const message = describeNamespaceRemoval(NAMESPACE);
    expect(message).toContain('Its 12 types are not deleted');
    expect(message).toContain('will show as unregistered');
    expect(message).toContain('currently the default namespace');
  });

  it('uses the singular for a lone type, and says so plainly when there are none', () => {
    expect(describeNamespaceRemoval({ ...NAMESPACE, type_count: 1 })).toContain(
      'Its 1 type is not deleted'
    );
    expect(
      describeNamespaceRemoval({ ...NAMESPACE, type_count: 0, is_default: false })
    ).toBe('Remove the namespace registration “tenant/acme/v1/types”? No types use it.');
  });
});

describe('the registry rail', () => {
  it('draws the worked example as data, so a comment line is a property of the line', () => {
    expect(REF_RESOLUTION_EXAMPLE.filter((line) => line.comment)).toHaveLength(3);
    expect(REF_RESOLUTION_EXAMPLE.find((line) => !line.comment)?.text).toBe(
      '"$ref": "../primitives/string"'
    );
  });

  it('gives each import source kind its own dot', () => {
    expect(importActivityTone('type-def-bundle')).toBe('ok');
    expect(importActivityTone('openapi')).toBe('violet');
    expect(importActivityTone('json-schema')).toBe('accent');
    expect(importActivityTone('something-new')).toBe('accent');
  });

  it('names what was imported and how much of it', () => {
    const item = {
      source_label: 'acme-types-bundle.json',
      imported_count: 12,
    } as PrimitiveImportActivity;
    expect(importActivityTitle(item)).toBe('Imported acme-types-bundle.json (12 types)');
    expect(importActivityTitle({ ...item, imported_count: 1 })).toContain('(1 type)');
    expect(importActivityTitle({ ...item, imported_count: 0 })).toBe(
      'Imported acme-types-bundle.json'
    );
    expect(importActivityTitle({ ...item, source_label: null })).toContain('Imported schema');
  });
});

describe('namespaces & scopes', () => {
  it('elides the host from a base URI, which is the same on every row', () => {
    expect(shortBaseUri('https://api.apiome.dev/types/std/v0/types/')).toBe(
      '…/types/std/v0/types/'
    );
  });

  it('leaves a value it cannot parse alone rather than mangling it', () => {
    expect(shortBaseUri('not a url')).toBe('not a url');
  });

  it('keeps the scope model’s two roots and their base URIs', () => {
    expect(SCOPE_EXPLAINERS.map((card) => card.pattern)).toEqual(['std/*', 'tenant/<slug>/*']);
    expect(SCOPE_EXPLAINERS.map((card) => card.tone)).toEqual(['ok', 'violet']);
  });

  it('keeps precedence most-specific first — tenant, then vendor, then core', () => {
    expect(SCOPE_PRECEDENCE.map((step) => step.rank)).toEqual([1, 2, 3]);
    expect(SCOPE_PRECEDENCE[0].title).toBe('Tenant namespace');
    expect(SCOPE_PRECEDENCE[1].title).toBe('Imported vendor namespaces');
    expect(SCOPE_PRECEDENCE[2].title).toBe('System core');
  });

  it('keeps promotion governed', () => {
    expect(PROMOTE_TO_CORE.from).toContain('tenant/');
    expect(PROMOTE_TO_CORE.to).toContain('std/');
    expect(PROMOTE_TO_CORE.gate).toBe('requires platform admin approval');
  });
});

describe('resolver and settings copy', () => {
  it('distinguishes a re-resolve that changed something from one that did not', () => {
    expect(reresolveSummary(3)).toBe('Re-resolved · 3 primitives updated');
    expect(reresolveSummary(1)).toBe('Re-resolved · 1 primitive updated');
    expect(reresolveSummary(0)).toBe('Re-resolved · all statuses already current');
  });

  it('reports registry storage as connected only when the probe says both things', () => {
    expect(registryStorageBadge({ connection: 'connected', status: 'healthy' })).toEqual({
      label: 'Connected',
      tone: 'ok',
    });
    expect(registryStorageBadge({ connection: 'connected', status: 'degraded' })).toEqual({
      label: 'Unavailable',
      tone: 'danger',
    });
    expect(registryStorageBadge(null)).toBeNull();
  });
});
