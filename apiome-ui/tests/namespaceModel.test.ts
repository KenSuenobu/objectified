/**
 * Tests for the Namespaces & Scopes model (#3471).
 *
 * Exercises the pure validation / derivation / request-building helpers that back the namespaces
 * table and the create/edit dialog, keeping them aligned with the Namespace CRUD API (#3451).
 */

import {
  REGISTRY_BASE_URL,
  NAMESPACE_PATH_RE,
  VERSION_SEGMENT_RE,
  emptyNamespaceForm,
  formFromNamespace,
  normalizeNamespacePath,
  deriveVersionRoot,
  defaultBaseUri,
  isSystemNamespacePath,
  validateNamespaceForm,
  isNamespaceFormValid,
  countUnassignedTypes,
  detectUnregisteredNamespaces,
  isUnassignedNamespace,
  buildCreateRequestBody,
  buildUpdateRequestBody,
  visibilityLabel,
  type NamespaceFormData,
} from '../src/app/ade/dashboard/primitives/namespaceModel';
import type { TypeNamespaceCollection } from '../src/app/ade/dashboard/primitives/primitivesRegistryTypes';

const tenantNs: TypeNamespaceCollection = {
  id: 'ns-1',
  tenant_id: 'tenant-1',
  namespace: 'tenant/acme/v1/types',
  base_uri: 'https://api.apiome.app/types/tenant/acme/v1/',
  version_root: 'v1',
  description: 'Acme core types',
  scope: 'tenant',
  is_system: false,
  is_public: false,
  is_default: true,
  type_count: 48,
};

const systemNs: TypeNamespaceCollection = {
  id: 'ns-sys',
  tenant_id: null,
  namespace: 'std/v0/types',
  base_uri: 'https://api.apiome.app/types/std/v0/',
  version_root: 'v0',
  description: null,
  scope: 'system',
  is_system: true,
  is_public: true,
  is_default: false,
  type_count: 56,
};

function form(overrides: Partial<NamespaceFormData> = {}): NamespaceFormData {
  return { ...emptyNamespaceForm(), ...overrides };
}

describe('namespace path helpers', () => {
  it('normalizes surrounding whitespace and slashes', () => {
    expect(normalizeNamespacePath('  /tenant/acme/v1/types/ ')).toBe('tenant/acme/v1/types');
    expect(normalizeNamespacePath('')).toBe('');
  });

  it('accepts valid lowercase slash-separated paths and rejects invalid ones', () => {
    expect(NAMESPACE_PATH_RE.test('tenant/acme/v1/types')).toBe(true);
    expect(NAMESPACE_PATH_RE.test('vendor/fhir/r4')).toBe(true);
    expect(NAMESPACE_PATH_RE.test('Tenant/Acme')).toBe(false); // uppercase
    expect(NAMESPACE_PATH_RE.test('tenant//acme')).toBe(false); // empty segment
    expect(NAMESPACE_PATH_RE.test('tenant/acme/')).toBe(false); // trailing slash
  });

  it('derives the version root from the first vN segment', () => {
    expect(deriveVersionRoot('std/v0/types')).toBe('v0');
    expect(deriveVersionRoot('tenant/acme/v12/payments')).toBe('v12');
    expect(deriveVersionRoot('tenant/acme/types')).toBeNull();
    expect(VERSION_SEGMENT_RE.test('v3')).toBe(true);
    expect(VERSION_SEGMENT_RE.test('ver1')).toBe(false);
  });

  it('derives the default base URI from the namespace path', () => {
    expect(defaultBaseUri('tenant/acme/v1/types')).toBe(
      `${REGISTRY_BASE_URL}tenant/acme/v1/types/`
    );
    expect(defaultBaseUri('  ')).toBe('');
  });

  it('flags the reserved std/ system root', () => {
    expect(isSystemNamespacePath('std')).toBe(true);
    expect(isSystemNamespacePath('std/v0/types')).toBe(true);
    expect(isSystemNamespacePath('standard/v0')).toBe(false);
    expect(isSystemNamespacePath('tenant/acme')).toBe(false);
  });
});

describe('formFromNamespace', () => {
  it('maps a namespace row onto editable form fields', () => {
    expect(formFromNamespace(tenantNs)).toEqual({
      namespace: 'tenant/acme/v1/types',
      baseUri: 'https://api.apiome.app/types/tenant/acme/v1/',
      versionRoot: 'v1',
      description: 'Acme core types',
      isDefault: true,
    });
  });

  it('coerces null base/version/description to empty strings', () => {
    const ns: TypeNamespaceCollection = { ...tenantNs, version_root: null, description: null };
    const result = formFromNamespace(ns);
    expect(result.versionRoot).toBe('');
    expect(result.description).toBe('');
  });
});

describe('validateNamespaceForm (create)', () => {
  it('requires a namespace path', () => {
    expect(validateNamespaceForm(form({ namespace: '' }), false).namespace).toBeDefined();
  });

  it('rejects a malformed namespace path', () => {
    expect(validateNamespaceForm(form({ namespace: 'Tenant/Acme' }), false).namespace).toContain(
      'lowercase'
    );
  });

  it('rejects the reserved std/ root', () => {
    expect(validateNamespaceForm(form({ namespace: 'std/v9/types' }), false).namespace).toContain(
      "'std/'"
    );
  });

  it('rejects a non-absolute base URI', () => {
    expect(
      validateNamespaceForm(form({ namespace: 'tenant/acme/v1/types', baseUri: 'not a url' }), false)
        .baseUri
    ).toBeDefined();
  });

  it('rejects an invalid version root', () => {
    expect(
      validateNamespaceForm(
        form({ namespace: 'tenant/acme/v1/types', versionRoot: 'rev1' }),
        false
      ).versionRoot
    ).toBeDefined();
  });

  it('accepts a well-formed tenant namespace', () => {
    const valid = form({
      namespace: 'tenant/acme/v1/types',
      baseUri: 'https://api.apiome.app/types/tenant/acme/v1/',
      versionRoot: 'v1',
    });
    expect(validateNamespaceForm(valid, false)).toEqual({});
    expect(isNamespaceFormValid(valid, false)).toBe(true);
  });
});

describe('validateNamespaceForm (edit)', () => {
  it('does not re-validate the immutable path but still validates base/version', () => {
    // The path is "std/..." (a system value), but on edit it is not re-checked.
    const f = form({ namespace: 'std/v0/types', baseUri: '', versionRoot: '' });
    expect(validateNamespaceForm(f, true)).toEqual({});
  });

  it('still rejects a bad base URI on edit', () => {
    const f = form({ namespace: 'tenant/acme/v1/types', baseUri: 'ftp://nope' });
    expect(validateNamespaceForm(f, true).baseUri).toBeDefined();
  });
});

describe('buildCreateRequestBody', () => {
  it('omits derived blank fields and always scopes to tenant', () => {
    const body = buildCreateRequestBody(
      form({ namespace: ' tenant/acme/v1/types ', isDefault: true })
    );
    expect(body).toEqual({
      namespace: 'tenant/acme/v1/types',
      scope: 'tenant',
      is_default: true,
    });
  });

  it('includes explicit base URI, version root, and description when provided', () => {
    const body = buildCreateRequestBody(
      form({
        namespace: 'tenant/acme/v1/types',
        baseUri: 'https://example.com/types/',
        versionRoot: 'v1',
        description: 'Payments types',
      })
    );
    expect(body).toMatchObject({
      base_uri: 'https://example.com/types/',
      version_root: 'v1',
      description: 'Payments types',
    });
  });
});

describe('buildUpdateRequestBody', () => {
  it('never sends the namespace path and clears description to null when blank', () => {
    const body = buildUpdateRequestBody(
      form({ namespace: 'tenant/acme/v1/types', description: '   ', isDefault: false })
    );
    expect(body).not.toHaveProperty('namespace');
    expect(body.description).toBeNull();
    expect(body.is_default).toBe(false);
    expect(body.version_root).toBeUndefined();
  });

  it('sends base URI and version root when present', () => {
    const body = buildUpdateRequestBody(
      form({
        baseUri: 'https://example.com/types/',
        versionRoot: 'v2',
        description: 'updated',
        isDefault: true,
      })
    );
    expect(body).toEqual({
      description: 'updated',
      is_default: true,
      base_uri: 'https://example.com/types/',
      version_root: 'v2',
    });
  });
});

describe('visibilityLabel', () => {
  it('labels system namespaces as visible to all tenants', () => {
    expect(visibilityLabel(systemNs)).toBe('All tenants');
  });

  it('labels private tenant namespaces as tenant only', () => {
    expect(visibilityLabel(tenantNs)).toBe('Tenant only');
  });

  it('labels public tenant namespaces as public', () => {
    expect(visibilityLabel({ ...tenantNs, is_public: true })).toBe('Public');
  });
});

describe('unassigned + unregistered namespace detection', () => {
  // Mirrors the real registry: types carry a namespace string, but only explicitly created
  // namespaces have a `type_namespaces` row for Type collections to list.
  const TYPES = [
    { namespace: 'std/v0/types' },
    { namespace: 'std/v0/types' },
    { namespace: 'self/v1/schemas/api/schemas' },
    { namespace: null },
    { namespace: undefined },
    { namespace: '   ' },
    {},
  ];
  const REGISTERED = [{ namespace: 'std/v0/primitives' }, { namespace: 'std/v0/types' }];

  describe('isUnassignedNamespace', () => {
    it('treats null, undefined and blank alike', () => {
      expect(isUnassignedNamespace(null)).toBe(true);
      expect(isUnassignedNamespace(undefined)).toBe(true);
      expect(isUnassignedNamespace('  ')).toBe(true);
      expect(isUnassignedNamespace('std/v0/types')).toBe(false);
    });
  });

  describe('countUnassignedTypes', () => {
    it('counts every type with no namespace at all', () => {
      expect(countUnassignedTypes(TYPES)).toBe(4);
    });

    it('is zero when every type is placed', () => {
      expect(countUnassignedTypes([{ namespace: 'std/v0/types' }])).toBe(0);
      expect(countUnassignedTypes([])).toBe(0);
    });
  });

  describe('detectUnregisteredNamespaces', () => {
    it('reports namespaces in use that have no registry row', () => {
      expect(detectUnregisteredNamespaces(TYPES, REGISTERED)).toEqual([
        { namespace: 'self/v1/schemas/api/schemas', typeCount: 1 },
      ]);
    });

    it('excludes namespaces that are already registered', () => {
      const detected = detectUnregisteredNamespaces(
        [{ namespace: 'std/v0/types' }],
        [{ namespace: 'std/v0/types' }]
      );
      expect(detected).toEqual([]);
    });

    it('never reports unassigned types as a namespace to register', () => {
      // There is nothing to register for a type with no namespace — it is counted separately.
      expect(detectUnregisteredNamespaces([{ namespace: null }, { namespace: '' }], [])).toEqual([]);
    });

    it('orders by type count, then alphabetically', () => {
      const detected = detectUnregisteredNamespaces(
        [
          { namespace: 'b/ns' },
          { namespace: 'a/ns' },
          { namespace: 'c/ns' },
          { namespace: 'c/ns' },
        ],
        []
      );
      expect(detected).toEqual([
        { namespace: 'c/ns', typeCount: 2 },
        { namespace: 'a/ns', typeCount: 1 },
        { namespace: 'b/ns', typeCount: 1 },
      ]);
    });
  });
});
