import {
  baseChainNodeHref,
  baseChainNodeLabel,
  buildBaseChain,
  buildExampleInstance,
  refEdgeTargetHref,
  refEdgeTargetLabel,
  deriveOwner,
  deriveVersionRoot,
  effectiveNamespace,
  exportFileName,
  namespaceFromSchemaId,
  parseSchemaIdNamespace,
  scopeLabel,
  serializeSchemaExport,
  summarizeUsage,
} from '../src/app/ade/dashboard/primitives/primitiveDetailModel';

describe('primitiveDetailModel helpers', () => {
  describe('buildBaseChain', () => {
    it('starts with the type itself then one node per ref edge', () => {
      const chain = buildBaseChain('money', [
        { relative_ref: './decimal', resolved_target: 'std/v0/types/decimal', status: 'resolved' },
        { relative_ref: './currency-code', resolved_target: 'std/v0/types/currency-code', status: 'resolved' },
      ]);
      expect(chain).toHaveLength(3);
      expect(chain[0]).toEqual({ label: 'money', kind: 'self' });
      expect(chain[1]).toMatchObject({ label: './decimal', target: 'std/v0/types/decimal', kind: 'ref', status: 'resolved' });
      expect(chain[2].label).toBe('./currency-code');
    });

    it('returns only the self node when there are no refs', () => {
      expect(buildBaseChain('decimal')).toEqual([{ label: 'decimal', kind: 'self' }]);
      expect(buildBaseChain('decimal', [])).toEqual([{ label: 'decimal', kind: 'self' }]);
    });

    it('skips edges that have no relative_ref', () => {
      const chain = buildBaseChain('money', [{ resolved_target: 'x' }, { relative_ref: './ok' }]);
      expect(chain).toHaveLength(2);
      expect(chain[1].label).toBe('./ok');
    });
  });

  describe('namespaceFromSchemaId', () => {
    it('extracts the namespace between the registry mount and the type-name slug', () => {
      expect(namespaceFromSchemaId('https://api.apiome.dev/types/std/v0/types/money')).toBe('std/v0/types');
      expect(namespaceFromSchemaId('https://api.apiome.dev/types/tenant/acme/v1/payments/charge')).toBe(
        'tenant/acme/v1/payments'
      );
    });

    it('is host-agnostic, so a self-hosted registry parses the same way', () => {
      expect(namespaceFromSchemaId('https://schemas.acme.internal/types/tenant/acme/v1/types/money')).toBe(
        'tenant/acme/v1/types'
      );
    });

    it('reads a bare path as well as an absolute URL', () => {
      expect(namespaceFromSchemaId('/types/std/v0/types/money')).toBe('std/v0/types');
    });

    it('decodes percent-encoded segments', () => {
      expect(namespaceFromSchemaId('https://api.apiome.dev/types/tenant/a%20b/v1/types/money')).toBe(
        'tenant/a b/v1/types'
      );
    });

    it('keeps every path segment for a foreign id, where nothing is a mount', () => {
      expect(
        namespaceFromSchemaId('https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position')
      ).toBe('self/v1/schemas/api/schemas');
      expect(namespaceFromSchemaId('https://x.example/base/charge')).toBe('base');
    });

    it('returns null when the id carries a name but no namespace above it', () => {
      expect(namespaceFromSchemaId('https://api.apiome.dev/types/money')).toBeNull();
      expect(namespaceFromSchemaId('https://x.example/position')).toBeNull();
    });

    it('returns null for missing or empty ids', () => {
      expect(namespaceFromSchemaId(null)).toBeNull();
      expect(namespaceFromSchemaId(undefined)).toBeNull();
      expect(namespaceFromSchemaId('   ')).toBeNull();
    });
  });

  describe('effectiveNamespace', () => {
    it('prefers a registry-mounted $id over the stored column', () => {
      expect(
        effectiveNamespace('https://api.apiome.dev/types/std/v0/types/money', 'stale/from/column')
      ).toBe('std/v0/types');
    });

    it('prefers the stored column over a foreign id, which describes someone else’s layout', () => {
      // An explicit `base_uri`: `base` is not this type's registry placement, the column is.
      expect(effectiveNamespace('https://x.example/base/charge', 'tenant/acme/v1/payments')).toBe(
        'tenant/acme/v1/payments'
      );
      expect(effectiveNamespace(null, 'std/v0/types')).toBe('std/v0/types');
    });

    it('falls back to a foreign id’s namespace when there is no stored column', () => {
      expect(effectiveNamespace('https://x.example/base/charge', null)).toBe('base');
    });

    it('returns null when neither source has a namespace', () => {
      expect(effectiveNamespace(null, null)).toBeNull();
    });
  });

  describe('parseSchemaIdNamespace', () => {
    it('reports whether the namespace came from under the registry mount', () => {
      expect(parseSchemaIdNamespace('https://api.apiome.dev/types/std/v0/types/money')).toEqual({
        namespace: 'std/v0/types',
        registryMounted: true,
      });
      expect(
        parseSchemaIdNamespace('https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position')
      ).toEqual({ namespace: 'self/v1/schemas/api/schemas', registryMounted: false });
    });
  });

  describe('deriveVersionRoot', () => {
    it('reads the version segment from a namespace path', () => {
      expect(deriveVersionRoot('std/v0/types')).toBe('v0');
      expect(deriveVersionRoot('tenant/acme/v12/payments')).toBe('v12');
    });

    it('falls back to the base URI when namespace is empty', () => {
      expect(deriveVersionRoot(null, 'https://api.apiome.dev/types/std/v0/types/')).toBe('v0');
    });

    it('returns null when no version root is present', () => {
      expect(deriveVersionRoot('std/types')).toBeNull();
      expect(deriveVersionRoot(null, null)).toBeNull();
    });
  });

  describe('scopeLabel / deriveOwner', () => {
    it('labels scope by system flag', () => {
      expect(scopeLabel(true)).toBe('System · core');
      expect(scopeLabel(false)).toBe('Tenant');
    });

    it('derives owner from system flag or tenant namespace', () => {
      expect(deriveOwner(true, 'std/v0/types')).toBe('system');
      expect(deriveOwner(false, 'tenant/acme/v1/payments')).toBe('acme');
      expect(deriveOwner(false, null)).toBe('tenant');
    });
  });

  describe('summarizeUsage', () => {
    it('counts dependent types, properties, and distinct tenants', () => {
      const summary = summarizeUsage(
        [
          { scope: 'tenant', tenant_label: 'acme', property: 'amount' },
          { scope: 'tenant', tenant_label: 'acme', property: 'total' },
          { scope: 'tenant', tenant_label: 'globex', property: 'grandTotal' },
          { scope: 'system', name: 'core-type' },
        ],
        11
      );
      expect(summary).toEqual({ dependentTypes: 4, properties: 11, tenants: 2 });
    });

    it('degrades to zero dependents/tenants when the reverse index is empty', () => {
      expect(summarizeUsage(undefined, 3)).toEqual({ dependentTypes: 0, properties: 3, tenants: 0 });
      expect(summarizeUsage([], -5)).toEqual({ dependentTypes: 0, properties: 0, tenants: 0 });
    });

    it('counts a type that references this one twice as one dependent type', () => {
      // The reverse index emits one entry per referencing edge, so the counter dedupes.
      const summary = summarizeUsage(
        [
          { id: 'p-invoice', scope: 'tenant', tenant_label: 'acme', property: 'total' },
          { id: 'p-invoice', scope: 'tenant', tenant_label: 'acme', property: 'lines[]' },
        ],
        2
      );
      expect(summary).toEqual({ dependentTypes: 1, properties: 2, tenants: 1 });
    });
  });

  describe('exportFileName / serializeSchemaExport', () => {
    it('slugifies the type name into a safe filename', () => {
      expect(exportFileName('Money')).toBe('money.schema.json');
      expect(exportFileName('US Dollar (amount)')).toBe('us-dollar-amount.schema.json');
      expect(exportFileName('   ')).toBe('primitive.schema.json');
    });

    it('pretty-prints the schema document', () => {
      expect(serializeSchemaExport({ type: 'string' })).toBe('{\n  "type": "string"\n}');
      expect(serializeSchemaExport(undefined)).toBe('{}');
    });
  });

  describe('buildExampleInstance', () => {
    it('prefers an explicit examples entry', () => {
      expect(buildExampleInstance({ type: 'string', examples: ['USD', 'EUR'] })).toBe('USD');
    });

    it('falls back to default, then const, then enum', () => {
      expect(buildExampleInstance({ type: 'number', default: 42 })).toBe(42);
      expect(buildExampleInstance({ const: 'fixed' })).toBe('fixed');
      expect(buildExampleInstance({ enum: ['a', 'b'] })).toBe('a');
    });

    it('derives values from primitive types', () => {
      expect(buildExampleInstance({ type: 'string' })).toBe('string');
      expect(buildExampleInstance({ type: 'string', format: 'date' })).toBe('date');
      expect(buildExampleInstance({ type: 'integer' })).toBe(0);
      expect(buildExampleInstance({ type: 'boolean' })).toBe(true);
      expect(buildExampleInstance({ type: 'array' })).toEqual([]);
      expect(buildExampleInstance({ type: 'null' })).toBeNull();
    });

    it('walks object properties and omits unresolvable $ref-only properties', () => {
      const example = buildExampleInstance({
        type: 'object',
        properties: {
          label: { type: 'string' },
          amount: { $ref: './decimal' },
        },
      });
      expect(example).toEqual({ label: 'string' });
    });

    it('keeps an explicit null-typed property', () => {
      const example = buildExampleInstance({
        type: 'object',
        properties: { note: { type: 'null' }, name: { type: 'string' } },
      });
      expect(example).toEqual({ note: null, name: 'string' });
    });

    it('returns null when no meaningful example can be produced', () => {
      expect(buildExampleInstance({ $ref: './decimal' })).toBeNull();
      expect(buildExampleInstance({ type: 'object', properties: { a: { $ref: './x' } } })).toBeNull();
      expect(buildExampleInstance(null)).toBeNull();
      expect(buildExampleInstance('not-an-object')).toBeNull();
    });
  });
});

describe('reference-target links', () => {
  it('carries the resolved target identity onto each chain node', () => {
    const chain = buildBaseChain('money', [
      {
        relative_ref: './decimal',
        resolved_target: 'https://api.apiome.dev/types/std/v0/types/decimal',
        status: 'resolved',
        target_id: 'p-decimal',
        target_name: 'decimal',
      },
      { relative_ref: './missing', resolved_target: null as unknown as string, status: 'unresolved' },
    ]);

    expect(chain[1]).toMatchObject({ targetId: 'p-decimal', targetName: 'decimal' });
    expect(chain[2].targetId).toBeNull();
  });

  it('links an edge with a known target to the type-detail screen', () => {
    expect(refEdgeTargetHref({ target_id: 'p-decimal' })).toBe('/ade/dashboard/primitives/p-decimal');
  });

  it('offers no link for an unresolved edge', () => {
    expect(refEdgeTargetHref({})).toBeNull();
    expect(refEdgeTargetHref({ target_id: null })).toBeNull();
  });

  it('labels an edge link with the target name, falling back to its $id', () => {
    expect(refEdgeTargetLabel({ target_name: 'decimal' })).toBe('View details for decimal');
    expect(refEdgeTargetLabel({ resolved_target: 'std/v0/types/decimal' })).toBe(
      'View details for std/v0/types/decimal'
    );
    expect(refEdgeTargetLabel({})).toBe('View details for reference target');
  });

  it('resolves a base-chain node through the same route and label as its edge', () => {
    const node = { targetId: 'p-decimal', targetName: 'decimal', target: 'std/v0/types/decimal' };
    expect(baseChainNodeHref(node)).toBe('/ade/dashboard/primitives/p-decimal');
    expect(baseChainNodeLabel(node)).toBe('View details for decimal');
  });

  it('never links the chain head, which is the type being viewed', () => {
    const [head] = buildBaseChain('money', []);
    expect(baseChainNodeHref(head)).toBeNull();
  });
});
