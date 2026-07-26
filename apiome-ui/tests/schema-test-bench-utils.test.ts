/**
 * Pure-helper tests for the Schema Test Bench (IXH-5.3, #5115).
 *
 * Covers the reference grammar, the RFC 6901 pointer→editor-range anchoring (the mechanism
 * behind inline markers and click-to-reveal), the curl/fixture exports, and the IXH-3.6
 * payload budget check — all without a DOM, Monaco, or the network.
 */

import { describe, expect, it } from '@jest/globals';

import {
  buildCorpusFixture,
  buildCurlCommand,
  buildRegistryRef,
  buildSchemaRef,
  checkPayloadBudget,
  describeOperationBody,
  escapePointerSegment,
  findingsToMarkers,
  fixtureFileStem,
  jsonPointerRanges,
  MARKER_SEVERITY_ERROR,
  registryRefFromPrimitive,
  REGISTRY_BASE_URL,
  unescapePointerSegment,
  type BenchFinding,
  type SchemaOperationBodyTarget,
} from '../src/app/utils/schema-test-bench';

// ===========================================================================
// Reference building
// ===========================================================================

describe('schema reference building', () => {
  it('builds revision and type references in the IXH-5.1 grammar', () => {
    expect(buildSchemaRef('catalog', 'legacy-soap', 'latest')).toBe('catalog/legacy-soap/latest');
    expect(buildSchemaRef('project', 'petstore', '1.0.0', 'acme.Pet')).toBe(
      'project/petstore/1.0.0/acme.Pet',
    );
  });

  it('builds registry references from namespace + name, tolerating stray slashes', () => {
    expect(buildRegistryRef('std/v0/primitives', 'email')).toBe('registry/std/v0/primitives/email');
    expect(buildRegistryRef('/std/v0/', '/email/')).toBe('registry/std/v0/email');
  });

  it('derives a registry reference from the primitive $id when it is under the registry root', () => {
    expect(
      registryRefFromPrimitive({
        schema_id: `${REGISTRY_BASE_URL}std/v0/primitives/email`,
        namespace: 'ignored',
        name: 'ignored',
      }),
    ).toBe('registry/std/v0/primitives/email');
  });

  it('falls back to namespace/name and refuses to guess without either coordinate', () => {
    expect(
      registryRefFromPrimitive({ schema_id: 'https://elsewhere.example/x', namespace: 'std/v0', name: 'date' }),
    ).toBe('registry/std/v0/date');
    expect(registryRefFromPrimitive({ schema_id: null, namespace: null, name: 'orphan' })).toBeNull();
  });

  it('labels operation bodies with verb, route, role, status, and list wrapping', () => {
    const body: SchemaOperationBodyTarget = {
      operation_key: 'GET /pets',
      operation_name: 'listPets',
      http_method: 'GET',
      http_path: '/pets',
      role: 'response',
      status_code: '200',
      type_key: 'acme.Pet',
      type_name: 'Pet',
      list_wrapped: true,
    };
    expect(describeOperationBody(body)).toBe('GET /pets — response body 200 ([Pet])');
    expect(
      describeOperationBody({ ...body, http_method: null, http_path: null, role: 'request', status_code: null, list_wrapped: false }),
    ).toBe('listPets — request body (Pet)');
  });
});

// ===========================================================================
// JSON Pointer anchoring
// ===========================================================================

describe('jsonPointerRanges', () => {
  it('maps the root, object members, and array items to their exact value ranges', () => {
    const text = '{\n  "name": "Rex",\n  "tags": [1, 22]\n}';
    const ranges = jsonPointerRanges(text);

    expect(ranges.get('')).toEqual({ startLine: 1, startColumn: 1, endLine: 4, endColumn: 2 });
    expect(ranges.get('/name')).toEqual({ startLine: 2, startColumn: 11, endLine: 2, endColumn: 16 });
    expect(ranges.get('/tags')).toEqual({ startLine: 3, startColumn: 11, endLine: 3, endColumn: 18 });
    expect(ranges.get('/tags/0')).toEqual({ startLine: 3, startColumn: 12, endLine: 3, endColumn: 13 });
    expect(ranges.get('/tags/1')).toEqual({ startLine: 3, startColumn: 15, endLine: 3, endColumn: 17 });
  });

  it('escapes RFC 6901 special characters in member names', () => {
    const ranges = jsonPointerRanges('{"a/b": 1, "c~d": 2}');
    expect(ranges.has('/a~1b')).toBe(true);
    expect(ranges.has('/c~0d')).toBe(true);
    expect(unescapePointerSegment(escapePointerSegment('a/b~c'))).toBe('a/b~c');
  });

  it('handles escaped quotes and unicode escapes inside keys and strings', () => {
    const ranges = jsonPointerRanges('{"he said \\"hi\\"": "\\u00e9clair"}');
    expect(ranges.has('/he said "hi"')).toBe(true);
  });

  it('handles nested structures, booleans, nulls, and scientific numbers', () => {
    const ranges = jsonPointerRanges('{"a": {"b": [true, null, 1e-3]}}');
    expect(ranges.has('/a/b/0')).toBe(true);
    expect(ranges.has('/a/b/1')).toBe(true);
    expect(ranges.has('/a/b/2')).toBe(true);
  });

  it('returns an empty map for invalid JSON and for trailing garbage', () => {
    expect(jsonPointerRanges('{"a": }').size).toBe(0);
    expect(jsonPointerRanges('{"a": 1} extra').size).toBe(0);
    expect(jsonPointerRanges('').size).toBe(0);
  });
});

describe('findingsToMarkers', () => {
  const text = '{\n  "age": "old"\n}';

  it('anchors a finding to its pointer value range as an error marker', () => {
    const findings: BenchFinding[] = [
      { pointer: '/age', keyword: 'type', message: "'old' is not of type 'integer'" },
    ];
    const [marker] = findingsToMarkers(findings, text);
    expect(marker).toEqual({
      startLine: 2,
      startColumn: 10,
      endLine: 2,
      endColumn: 15,
      severity: MARKER_SEVERITY_ERROR,
      message: "type: 'old' is not of type 'integer'",
    });
  });

  it('falls back to an explicit line/column (XML findings) and then to the document start', () => {
    const findings: BenchFinding[] = [
      { pointer: '/missing', keyword: 'x', message: 'm', line: 7, column: 3 },
      { pointer: '/also-missing', keyword: 'y', message: 'n' },
    ];
    const [withLine, atStart] = findingsToMarkers(findings, text);
    expect([withLine.startLine, withLine.startColumn]).toEqual([7, 3]);
    expect([atStart.startLine, atStart.startColumn]).toEqual([1, 1]);
  });
});

// ===========================================================================
// Exports (curl + corpus fixture)
// ===========================================================================

describe('buildCurlCommand', () => {
  it('targets the REST validate endpoint with an env-var credential, never an embedded one', () => {
    const curl = buildCurlCommand({
      restBaseUrl: 'http://localhost:8000/v1/',
      tenantSlug: 'acme',
      ref: 'project/petstore/1.0.0/acme.Pet',
      payloadText: '{"name": "Rex"}',
    });
    expect(curl).toContain(
      "'http://localhost:8000/v1/tenants/acme/schemas/project/petstore/1.0.0/acme.Pet/validate'",
    );
    expect(curl).toContain('X-API-Key: $APIOME_API_KEY');
    expect(curl).toContain('"instance_text"');
    expect(curl).not.toContain('Bearer');
  });

  it('percent-encodes reference segments and shell-escapes single quotes in the payload', () => {
    const curl = buildCurlCommand({
      restBaseUrl: 'http://localhost:8000/v1',
      tenantSlug: 'acme',
      ref: 'catalog/legacy soap/latest/Order',
      payloadText: `{"note": "it's"}`,
    });
    expect(curl).toContain('/schemas/catalog/legacy%20soap/latest/Order/validate');
    expect(curl).toContain(`'\\''`);
  });
});

describe('buildCorpusFixture', () => {
  it('emits a valid-class IXH-1.1 manifest entry naming the schema reference', () => {
    const fixture = buildCorpusFixture({
      ref: 'catalog/legacy-soap/latest/Order',
      payloadText: '{"id": 1}',
      name: 'Golden Order!',
      synthetic: false,
    });
    expect(fixture.entry.path).toBe('json-schema/test-bench/golden-order.json');
    expect(fixture.entry.validity_class).toBe('valid');
    expect(fixture.entry.expected_outcome).toBe('imports');
    expect(fixture.entry.adapter_key).toBeNull();
    expect(fixture.entry.source).toBe('hand-authored');
    expect(fixture.entry.provenance).toContain('catalog/legacy-soap/latest/Order');
    expect(fixture.payload).toBe('{"id": 1}');
  });

  it('keeps the synthetic label on generated payloads', () => {
    const fixture = buildCorpusFixture({
      ref: 'project/p/latest/T',
      payloadText: '{}',
      name: 'gen',
      synthetic: true,
    });
    expect(fixture.entry.source).toBe('synthesized');
    expect(fixture.entry.provenance).toContain('IXH-5.2');
  });

  it('derives a safe kebab-case file stem, with a fallback for empty labels', () => {
    expect(fixtureFileStem('  Héllo — World!! ')).toBe('h-llo-world');
    expect(fixtureFileStem('!!!')).toBe('payload');
  });
});

// ===========================================================================
// Payload budget (IXH-3.6)
// ===========================================================================

describe('checkPayloadBudget', () => {
  it('accepts payloads within the budget', () => {
    expect(checkPayloadBudget('{"a":1}', 100)).toEqual({
      bytes: 7,
      withinBudget: true,
      message: null,
    });
  });

  it('measures UTF-8 bytes, not code units, and refuses with a stated size', () => {
    const result = checkPayloadBudget('"éé"', 3);
    expect(result.bytes).toBe(6); // two 2-byte chars + quotes
    expect(result.withinBudget).toBe(false);
    expect(result.message).toContain('above the Test Bench bound');
    expect(result.message).toContain('curl');
  });
});
