/**
 * `$ref` resolution and repair for the Primitives import wizard.
 *
 * The case that motivates the module: a ref that walks up too far lands outside the registry root,
 * which the API drops entirely rather than reporting as broken. These tests pin that such a ref is
 * matched by the path it names, rewritten to the canonical depth, and that anything genuinely
 * unknown is reported instead of quietly repaired.
 */

import {
  applyRefRewrites,
  baseUriForNamespace,
  buildKnownTargets,
  canonicalRef,
  collectRefs,
  refRewriteMap,
  refTailPath,
  registryPathOf,
  resolveImportRefs,
  slugifyTypeName,
  summarizeRefResolutions,
  REGISTRY_BASE_URL,
  type KnownTarget,
} from '../src/app/ade/dashboard/primitives/primitiveRefResolution';

const TARGET_NAMESPACE = 'tenant/acme/v1/types';

const KNOWN: KnownTarget[] = [
  { path: 'std/v0/types/uri', origin: 'registry' },
  { path: 'std/v0/types/email', origin: 'registry' },
  { path: 'tenant/acme/v1/types/decimal', origin: 'registry' },
];

const resolveOne = (schema: Record<string, unknown>, knownTargets: KnownTarget[] = KNOWN) =>
  resolveImportRefs({ thing: schema }, { targetNamespace: TARGET_NAMESPACE, knownTargets })[0];

describe('path helpers', () => {
  it('derives the base URI for a namespace', () => {
    expect(baseUriForNamespace('tenant/acme/v1/types')).toBe(
      'https://api.apiome.dev/types/tenant/acme/v1/types/'
    );
    expect(baseUriForNamespace('')).toBeNull();
    expect(baseUriForNamespace(null)).toBeNull();
  });

  it('reads the registry path out of an absolute id', () => {
    expect(registryPathOf(`${REGISTRY_BASE_URL}std/v0/types/uri`)).toBe('std/v0/types/uri');
    expect(registryPathOf('https://x.example/std/v0/types/uri')).toBeNull();
  });

  it('strips the walk-up prefix to leave the path a ref names', () => {
    expect(refTailPath('../../../../../std/v0/types/uri')).toBe('std/v0/types/uri');
    expect(refTailPath('../../../../std/v0/types/uri')).toBe('std/v0/types/uri');
    expect(refTailPath('./decimal')).toBe('decimal');
    expect(refTailPath(`${REGISTRY_BASE_URL}std/v0/types/uri`)).toBe('std/v0/types/uri');
    expect(refTailPath('#/$defs/Money')).toBeNull();
  });

  it('slugifies a type name the way the API does', () => {
    expect(slugifyTypeName('Email Address')).toBe('email-address');
    expect(slugifyTypeName('')).toBe('type');
  });
});

describe('canonicalRef', () => {
  it('walks up exactly as far as the namespaces differ', () => {
    expect(canonicalRef('tenant/acme/v1/types', 'std/v0/types/uri')).toBe('../../../../std/v0/types/uri');
  });

  it('uses a sibling reference within the same namespace', () => {
    expect(canonicalRef('tenant/acme/v1/types', 'tenant/acme/v1/types/money')).toBe('./money');
  });

  it('shares the common prefix rather than walking to the root', () => {
    expect(canonicalRef('tenant/acme/v1/types', 'tenant/acme/v2/types/money')).toBe(
      '../../v2/types/money'
    );
  });

  it('falls back to an absolute id when there is no namespace to anchor to', () => {
    expect(canonicalRef(null, 'std/v0/types/uri')).toBe(`${REGISTRY_BASE_URL}std/v0/types/uri`);
  });

  it('round-trips: the canonical ref resolves back to the target', () => {
    const base = baseUriForNamespace('tenant/acme/v1/types') as string;
    const ref = canonicalRef('tenant/acme/v1/types', 'std/v0/types/uri');
    expect(registryPathOf(new URL(ref, base).toString())).toBe('std/v0/types/uri');
  });
});

describe('collectRefs', () => {
  it('finds refs at any depth, in document order', () => {
    expect(
      collectRefs({
        properties: { a: { $ref: './one' }, b: { items: [{ $ref: './two' }] } },
        $defs: { c: { $ref: './three' } },
      })
    ).toEqual(['./one', './two', './three']);
  });

  it('returns nothing for a schema with no refs', () => {
    expect(collectRefs({ type: 'string' })).toEqual([]);
  });
});

describe('resolveImportRefs', () => {
  it('marks a correctly-written ref resolved without touching it', () => {
    const result = resolveOne({ $ref: '../../../../std/v0/types/uri' });

    expect(result.status).toBe('resolved');
    expect(result.target).toBe('std/v0/types/uri');
    expect(result.rewrittenTo).toBeUndefined();
  });

  it('repairs a ref that walks up too far — the reported motivating case', () => {
    // As written this lands on https://api.apiome.dev/std/v0/types/uri, outside the registry root,
    // which the API drops silently. The path it names is still unambiguous.
    const result = resolveOne({ $ref: '../../../../../std/v0/types/uri' });

    expect(result.status).toBe('repaired');
    expect(result.target).toBe('std/v0/types/uri');
    expect(result.rewrittenTo).toBe('../../../../std/v0/types/uri');
  });

  it('repairs a ref that does not walk up far enough', () => {
    const result = resolveOne({ $ref: '../std/v0/types/uri' });

    expect(result.status).toBe('repaired');
    expect(result.rewrittenTo).toBe('../../../../std/v0/types/uri');
  });

  it('preserves a trailing JSON Pointer fragment across a repair', () => {
    const result = resolveOne({ $ref: '../../../../../std/v0/types/uri#/properties/host' });

    expect(result.status).toBe('repaired');
    expect(result.rewrittenTo).toBe('../../../../std/v0/types/uri#/properties/host');
  });

  it('resolves a sibling in the same namespace', () => {
    const result = resolveOne({ $ref: './decimal' });

    expect(result.status).toBe('resolved');
    expect(result.target).toBe('tenant/acme/v1/types/decimal');
  });

  it('resolves against a type arriving with the same import', () => {
    const known = buildKnownTargets([], ['Money'], TARGET_NAMESPACE);
    const result = resolveOne({ $ref: './money' }, known);

    expect(result.status).toBe('resolved');
    expect(result.origin).toBe('import');
  });

  it('reports a ref that matches nothing, naming what it looked for', () => {
    const result = resolveOne({ $ref: '../../../../std/v0/types/missing' });

    expect(result.status).toBe('unresolved');
    expect(result.reason).toMatch(/no type matching "std\/v0\/types\/missing"/i);
  });

  it('leaves an external absolute reference alone', () => {
    const result = resolveOne({ $ref: 'https://json-schema.org/draft/2020-12/schema' });

    expect(result.status).toBe('external');
    expect(result.rewrittenTo).toBeUndefined();
  });

  it('skips same-document pointers, which the API rewrites itself', () => {
    expect(resolveImportRefs({ thing: { $ref: '#/$defs/Money' } }, {
      targetNamespace: TARGET_NAMESPACE,
      knownTargets: KNOWN,
    })).toEqual([]);
  });

  it('reports each distinct ref once per definition, attributed to that definition', () => {
    const results = resolveImportRefs(
      {
        a: { properties: { x: { $ref: './decimal' }, y: { $ref: './decimal' } } },
        b: { properties: { z: { $ref: './decimal' } } },
      },
      { targetNamespace: TARGET_NAMESPACE, knownTargets: KNOWN }
    );

    expect(results).toHaveLength(2);
    expect(results.map((entry) => entry.typeName)).toEqual(['a', 'b']);
  });

  it('still matches by path when no target namespace is set', () => {
    const results = resolveImportRefs(
      { thing: { $ref: '../../../../../std/v0/types/uri' } },
      { targetNamespace: null, knownTargets: KNOWN }
    );

    // With no namespace to anchor a relative ref to, the repair is the absolute id.
    expect(results[0].status).toBe('repaired');
    expect(results[0].rewrittenTo).toBe(`${REGISTRY_BASE_URL}std/v0/types/uri`);
  });
});

describe('buildKnownTargets', () => {
  it('prefers the schema_id path and falls back to namespace + slugified name', () => {
    const targets = buildKnownTargets(
      [
        { schema_id: `${REGISTRY_BASE_URL}std/v0/types/uri`, namespace: 'ignored', name: 'uri' },
        { schema_id: null, namespace: 'tenant/acme/v1/types', name: 'Email Address' },
      ],
      [],
      null
    );

    expect(targets.map((target) => target.path)).toEqual([
      'std/v0/types/uri',
      'tenant/acme/v1/types/email-address',
    ]);
  });

  it('adds the imported definitions under the target namespace', () => {
    const targets = buildKnownTargets([], ['Money', 'Decimal'], 'tenant/acme/v1/types');

    expect(targets).toEqual([
      { path: 'tenant/acme/v1/types/money', origin: 'import' },
      { path: 'tenant/acme/v1/types/decimal', origin: 'import' },
    ]);
  });

  it('cannot place imported definitions without a target namespace', () => {
    expect(buildKnownTargets([], ['Money'], null)).toEqual([]);
  });

  it('keeps the registry entry when an imported name collides with it', () => {
    const targets = buildKnownTargets(
      [{ schema_id: `${REGISTRY_BASE_URL}tenant/acme/v1/types/money` }],
      ['Money'],
      'tenant/acme/v1/types'
    );

    expect(targets).toHaveLength(1);
    expect(targets[0].origin).toBe('registry');
  });
});

describe('applyRefRewrites', () => {
  it('replaces only the repaired refs, leaving the rest untouched', () => {
    const doc = {
      $defs: {
        a: { properties: { x: { $ref: '../../../../../std/v0/types/uri' }, y: { $ref: './decimal' } } },
      },
    };
    const resolutions = resolveImportRefs(doc.$defs, {
      targetNamespace: TARGET_NAMESPACE,
      knownTargets: KNOWN,
    });

    const rewritten = applyRefRewrites(doc, refRewriteMap(resolutions));

    expect(rewritten.$defs.a.properties.x.$ref).toBe('../../../../std/v0/types/uri');
    expect(rewritten.$defs.a.properties.y.$ref).toBe('./decimal');
  });

  it('does not mutate the document it was given', () => {
    const doc = { $defs: { a: { $ref: '../../../../../std/v0/types/uri' } } };
    const rewrites = new Map([['../../../../../std/v0/types/uri', '../../../../std/v0/types/uri']]);

    applyRefRewrites(doc, rewrites);

    expect(doc.$defs.a.$ref).toBe('../../../../../std/v0/types/uri');
  });

  it('returns the document unchanged when there is nothing to rewrite', () => {
    const doc = { type: 'string' };
    expect(applyRefRewrites(doc, new Map())).toBe(doc);
  });
});

describe('summarizeRefResolutions', () => {
  it('counts a repaired ref as resolved as well as repaired', () => {
    const summary = summarizeRefResolutions([
      { typeName: 'a', ref: './decimal', status: 'resolved' },
      { typeName: 'a', ref: '../../../../../std/v0/types/uri', status: 'repaired', rewrittenTo: 'x' },
      { typeName: 'b', ref: './missing', status: 'unresolved' },
      { typeName: 'b', ref: 'https://json-schema.org/x', status: 'external' },
    ]);

    expect(summary).toEqual({ resolved: 2, repaired: 1, unresolved: 1, external: 1 });
  });
});
