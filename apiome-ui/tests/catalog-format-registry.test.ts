/**
 * Unit tests for the catalog format / protocol / source registry (MFI-23.5, #4014).
 *
 * These pin the data-driven lookups behind the catalog pills: every registered format/protocol
 * resolves, version/punctuation variants normalise to the right entry, unknown-but-present tokens
 * resolve to `undefined` (the consumer renders a neutral pill), and the source-material derivation
 * reads file/url/discovery provenance out of either metadata bag.
 */
import { describe, test, expect } from '@jest/globals';
import {
  CATALOG_FORMATS,
  CATALOG_PROTOCOLS,
  CATALOG_PILL_TONE_CLASS,
  CATALOG_SOURCE_KIND_META,
  ALTERNATIVE_CATALOG_FORMATS,
  IMPORTABLE_ALTERNATIVE_FORMATS,
  RECOGNIZED_ALTERNATIVE_FORMATS,
  NATIVE_FORMAT_IDS,
  resolveCatalogFormat,
  resolveCatalogProtocol,
  resolveCatalogSource,
  catalogFormatFamilyId,
  catalogFormatFamilyLabel,
  catalogFormatSearchTokens,
  catalogFormatTraits,
  CATALOG_FORMAT_DATA_TYPES,
  CATALOG_FORMAT_ORIGINS,
} from '../src/app/utils/catalog-format-registry';

describe('catalog-format-registry — formats', () => {
  test('format ids are unique', () => {
    const ids = CATALOG_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every format has a label, an icon and a known tone', () => {
    for (const f of CATALOG_FORMATS) {
      expect(f.label.trim().length).toBeGreaterThan(0);
      expect(f.icon).toBeDefined();
      expect(CATALOG_PILL_TONE_CLASS[f.tone]).toBeDefined();
    }
  });

  test('resolves the headline formats called out by the ticket', () => {
    expect(resolveCatalogFormat('openapi')?.label).toBe('OpenAPI');
    expect(resolveCatalogFormat('grpc')?.label).toBe('gRPC');
    expect(resolveCatalogFormat('graphql')?.label).toBe('GraphQL');
    expect(resolveCatalogFormat('asyncapi')?.label).toBe('AsyncAPI');
    expect(resolveCatalogFormat('odata')?.label).toBe('OData');
    expect(resolveCatalogFormat('wsdl')?.label).toBe('WSDL');
    expect(resolveCatalogFormat('smithy')?.label).toBe('Smithy');
    expect(resolveCatalogFormat('raml')?.label).toBe('RAML');
    expect(resolveCatalogFormat('apiblueprint')?.label).toBe('API Blueprint');
    expect(resolveCatalogFormat('avro')?.label).toBe('Avro');
  });

  test('matching is version- and punctuation-insensitive', () => {
    expect(resolveCatalogFormat('openapi-3.1')?.id).toBe('openapi');
    expect(resolveCatalogFormat('OpenAPI 3.0')?.id).toBe('openapi');
    expect(resolveCatalogFormat('swagger-2.0')?.id).toBe('swagger');
    expect(resolveCatalogFormat('API Blueprint')?.id).toBe('apiblueprint');
    expect(resolveCatalogFormat('proto3')?.id).toBe('protobuf');
  });

  test('unknown / empty formats resolve to undefined (neutral pill)', () => {
    expect(resolveCatalogFormat('totally-made-up')).toBeUndefined();
    expect(resolveCatalogFormat('')).toBeUndefined();
    expect(resolveCatalogFormat('   ')).toBeUndefined();
    expect(resolveCatalogFormat(null)).toBeUndefined();
    expect(resolveCatalogFormat(undefined)).toBeUndefined();
  });

  test('resolves the alternative formats surfaced in the catalog (MFI-23.12)', () => {
    // A sampling across the examples/ formats now registered.
    expect(resolveCatalogFormat('protobuf')?.label).toBe('Protobuf');
    expect(resolveCatalogFormat('fhir')?.label).toBe('FHIR');
    expect(resolveCatalogFormat('hl7v2')?.label).toBe('HL7 v2');
    expect(resolveCatalogFormat('edi-x12')?.id).toBe('edix12');
    expect(resolveCatalogFormat('iso20022')?.label).toBe('ISO 20022');
    expect(resolveCatalogFormat('iso8583')?.label).toBe('ISO 8583');
    expect(resolveCatalogFormat('fix')?.label).toBe('FIX');
    expect(resolveCatalogFormat('cobol-copybook')?.id).toBe('cobolcopybook');
    expect(resolveCatalogFormat('capnp')?.id).toBe('capnproto');
    expect(resolveCatalogFormat('wit')?.label).toBe('WIT (WebAssembly)');
    expect(resolveCatalogFormat('rnc')?.id).toBe('relaxng');
    expect(resolveCatalogFormat('relaxng-compact')?.label).toBe('RELAX NG');
    expect(resolveCatalogFormat('flatbuffers')?.label).toBe('FlatBuffers');
    expect(resolveCatalogFormat('typespec')?.label).toBe('TypeSpec');
    expect(resolveCatalogFormat('openrpc')?.label).toBe('OpenRPC');
    expect(resolveCatalogFormat('discovery')?.label).toBe('Google Discovery');
    expect(resolveCatalogFormat('google-discovery')?.id).toBe('discovery');
    expect(resolveCatalogFormat('k8s-crd')?.label).toBe('Kubernetes CRD');
    expect(resolveCatalogFormat('kubernetes-crd')?.id).toBe('k8s-crd');
    expect(resolveCatalogFormat('crd')?.id).toBe('k8s-crd');
    expect(resolveCatalogFormat('llm-tools')?.label).toBe('LLM Tools');
    expect(resolveCatalogFormat('function-calling')?.id).toBe('llm-tools');
    expect(resolveCatalogFormat('openai-tools')?.id).toBe('llm-tools');
    expect(resolveCatalogFormat('http-file')?.label).toBe('HTTP Request File');
    expect(resolveCatalogFormat('curl')?.id).toBe('http-file');
    expect(resolveCatalogFormat('kong')?.label).toBe('Kong Declarative Config');
    expect(resolveCatalogFormat('kong-declarative')?.id).toBe('kong');
    expect(resolveCatalogFormat('gateway-api')?.label).toBe('Gateway API HTTPRoute');
    expect(resolveCatalogFormat('httproute')?.id).toBe('gateway-api');
    expect(resolveCatalogFormat('zos-connect')?.id).toBe('zosconnect');
    expect(resolveCatalogFormat('xml-rpc')?.id).toBe('xmlrpc');
  });
});

describe('catalogFormatFamilyId', () => {
  test('collapses gRPC and Protobuf into one catalog family', () => {
    expect(catalogFormatFamilyId('protobuf')).toBe('protobuf');
    expect(catalogFormatFamilyId('grpc')).toBe('protobuf');
    expect(catalogFormatFamilyLabel('protobuf')).toBe('gRPC / Protobuf');
  });

  test('search tokens match both gRPC and Protobuf labels for a protobuf item', () => {
    const tokens = catalogFormatSearchTokens('protobuf');
    expect(tokens).toEqual(expect.arrayContaining(['grpc', 'protobuf', 'proto']));
  });
});

describe('catalog-format-registry — native vs alternative split (MFI-23.12)', () => {
  test('only OpenAPI and Swagger are native (publishable → Projects)', () => {
    expect([...NATIVE_FORMAT_IDS].sort()).toEqual(['openapi', 'swagger']);
  });

  test('ALTERNATIVE_CATALOG_FORMATS is every format except the native pair', () => {
    expect(ALTERNATIVE_CATALOG_FORMATS.length).toBe(CATALOG_FORMATS.length - 2);
    for (const fmt of ALTERNATIVE_CATALOG_FORMATS) {
      expect(fmt.native).not.toBe(true);
      expect(NATIVE_FORMAT_IDS.has(fmt.id)).toBe(false);
    }
    // Native formats never leak into the alternative gallery.
    expect(ALTERNATIVE_CATALOG_FORMATS.some((f) => f.id === 'openapi')).toBe(false);
    expect(ALTERNATIVE_CATALOG_FORMATS.some((f) => f.id === 'swagger')).toBe(false);
  });

  test('every alternative format carries a gallery description', () => {
    for (const fmt of ALTERNATIVE_CATALOG_FORMATS) {
      expect(fmt.description?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('catalog-format-registry — importable vs recognized (MFI-23.12)', () => {
  test('importable alternatives are exactly the adapter-backed (store-raw) formats', () => {
    // Only formats with a server-registered adapter can be stored raw in the catalog today.
    expect(IMPORTABLE_ALTERNATIVE_FORMATS.map((f) => f.id).sort()).toEqual(
      ['apiblueprint', 'arazzo', 'arrow', 'asn1', 'asyncapi', 'avro', 'capnproto', 'cddl', 'cloudevents', 'cobolcopybook', 'connectrpc', 'corbaidl', 'dbt', 'discovery', 'dtd', 'edix12', 'fix', 'flatbuffers', 'fhir', 'gateway-api', 'graphql', 'grpc', 'hl7v2', 'http-file', 'iso20022', 'iso8583', 'jsonschema', 'jtd', 'k8s-crd', 'kafka-connect', 'kong', 'llm-tools', 'mcp', 'odata', 'odcs', 'oncrpc', 'openrpc', 'postman', 'protobuf', 'raml', 'relaxng', 'smithy', 'sql-ddl', 'thrift', 'typespec', 'wadl', 'wit', 'wsdl', 'xmlrpc', 'xsd', 'zosconnect'].sort(),
    );
  });

  test('the two partitions are disjoint and cover every alternative format', () => {
    const importable = new Set(IMPORTABLE_ALTERNATIVE_FORMATS.map((f) => f.id));
    const recognized = new Set(RECOGNIZED_ALTERNATIVE_FORMATS.map((f) => f.id));
    for (const id of importable) expect(recognized.has(id)).toBe(false);
    expect(importable.size + recognized.size).toBe(ALTERNATIVE_CATALOG_FORMATS.length);
  });

  test('arazzo is importable to the catalog', () => {
    expect(resolveCatalogFormat('arazzo')?.importable).toBe(true);
    expect(resolveCatalogFormat('workflows')?.importable).toBe(true);
  });

  test('native formats are importable', () => {
    expect(resolveCatalogFormat('openapi')?.importable).toBe(true);
    expect(resolveCatalogFormat('swagger')?.importable).toBe(true);
  });
});

describe('catalog-format-registry — format traits (CATP-1.1)', () => {
  test('every registered format is classified, and both halves resolve to metadata', () => {
    const unclassified = CATALOG_FORMATS.filter((f) => !catalogFormatTraits(f)).map((f) => f.id);
    expect(unclassified).toEqual([]);
  });

  test('every trait descriptor carries a label, an icon and a sentence', () => {
    for (const meta of [
      ...Object.values(CATALOG_FORMAT_DATA_TYPES),
      ...Object.values(CATALOG_FORMAT_ORIGINS),
    ]) {
      expect(meta.label.trim().length).toBeGreaterThan(0);
      expect(meta.icon).toBeDefined();
      expect(meta.description.trim().length).toBeGreaterThan(0);
    }
  });

  test('the pill labels stay short enough to sit beside a format name', () => {
    for (const meta of [
      ...Object.values(CATALOG_FORMAT_DATA_TYPES),
      ...Object.values(CATALOG_FORMAT_ORIGINS),
    ]) {
      expect(meta.label).not.toContain(' ');
      expect(meta.label.length).toBeLessThanOrEqual(10);
    }
  });

  test('classifies the corners of the estate the gallery is meant to make visible', () => {
    /** The two pill labels for one format id. */
    const traits = (id: string) => {
      const fmt = CATALOG_FORMATS.find((f) => f.id === id);
      if (!fmt) throw new Error(`no registry entry for ${id}`);
      const resolved = catalogFormatTraits(fmt);
      return [resolved?.dataType.label, resolved?.origin.label];
    };

    expect(traits('openapi')).toEqual(['REST', 'Web']);
    expect(traits('grpc')).toEqual(['RPC', 'Cloud']);
    expect(traits('graphql')).toEqual(['Graph', 'Web']);
    expect(traits('asyncapi')).toEqual(['Events', 'Cloud']);
    expect(traits('avro')).toEqual(['Schema', 'Data']);
    expect(traits('wsdl')).toEqual(['RPC', 'Enterprise']);
    expect(traits('cobolcopybook')).toEqual(['Records', 'Mainframe']);
    expect(traits('zosconnect')).toEqual(['REST', 'Mainframe']);
    expect(traits('hl7v2')).toEqual(['Messages', 'Healthcare']);
    expect(traits('fix')).toEqual(['Messages', 'Finance']);
    expect(traits('edix12')).toEqual(['Messages', 'B2B']);
    expect(traits('asn1')).toEqual(['Schema', 'Telecom']);
    expect(traits('mcp')).toEqual(['Tools', 'AI']);
    // The three the paradigm alone would flatten: all `rest`, and none of them a REST contract.
    expect(traits('postman')).toEqual(['Requests', 'Web']);
    expect(traits('kong')).toEqual(['Routes', 'Cloud']);
    expect(traits('arazzo')).toEqual(['Workflow', 'Web']);
  });

  test('every classification in the tables is actually used by some format', () => {
    const usedTypes = new Set(CATALOG_FORMATS.map((f) => f.dataType));
    const usedOrigins = new Set(CATALOG_FORMATS.map((f) => f.origin));
    expect(Object.keys(CATALOG_FORMAT_DATA_TYPES).filter((k) => !usedTypes.has(k as never))).toEqual([]);
    expect(Object.keys(CATALOG_FORMAT_ORIGINS).filter((k) => !usedOrigins.has(k as never))).toEqual([]);
  });
});

describe('catalog-format-registry — protocols', () => {
  test('protocol ids are unique', () => {
    const ids = CATALOG_PROTOCOLS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('resolves the canonical paradigms plus agent', () => {
    expect(resolveCatalogProtocol('rest')?.label).toBe('REST');
    expect(resolveCatalogProtocol('rpc')?.label).toBe('RPC');
    expect(resolveCatalogProtocol('event')?.label).toBe('Event');
    expect(resolveCatalogProtocol('graph')?.label).toBe('Graph');
    expect(resolveCatalogProtocol('agent')?.label).toBe('Agent');
  });

  test('data-schema resolves across snake/kebab/space spellings', () => {
    expect(resolveCatalogProtocol('data_schema')?.id).toBe('dataschema');
    expect(resolveCatalogProtocol('data-schema')?.id).toBe('dataschema');
    expect(resolveCatalogProtocol('Data Schema')?.id).toBe('dataschema');
  });

  test('unknown / empty protocols resolve to undefined (neutral pill)', () => {
    expect(resolveCatalogProtocol('carrier-pigeon')).toBeUndefined();
    expect(resolveCatalogProtocol('')).toBeUndefined();
    expect(resolveCatalogProtocol(null)).toBeUndefined();
    expect(resolveCatalogProtocol(undefined)).toBeUndefined();
  });
});

describe('catalog-format-registry — source material', () => {
  test('every source kind has an icon and a fallback label', () => {
    for (const meta of Object.values(CATALOG_SOURCE_KIND_META)) {
      expect(meta.icon).toBeDefined();
      expect(meta.fallbackLabel.trim().length).toBeGreaterThan(0);
    }
  });

  test('reads an explicit file source from formatMetadata (snake_case)', () => {
    const s = resolveCatalogSource({ input_kind: 'file', file_name: 'petstore.proto' }, null);
    expect(s).toEqual({ kind: 'file', label: 'petstore.proto', title: 'petstore.proto' });
  });

  test('reads a url source and compacts it to host + path (camelCase)', () => {
    const s = resolveCatalogSource({ inputKind: 'url', sourceUri: 'https://api.example.com/v1/spec.yaml?x=1' }, null);
    expect(s?.kind).toBe('url');
    expect(s?.label).toBe('api.example.com/v1/spec.yaml');
    expect(s?.title).toBe('https://api.example.com/v1/spec.yaml?x=1');
  });

  test('infers url kind from an http(s) label when no kind is recorded', () => {
    const s = resolveCatalogSource({ sourceLabel: 'https://schemas.example.com/user.avsc' }, null);
    expect(s?.kind).toBe('url');
  });

  test('infers file kind from a bare label when no kind is recorded', () => {
    const s = resolveCatalogSource({ sourceLabel: 'orders.graphql' }, null);
    expect(s?.kind).toBe('file');
    expect(s?.label).toBe('orders.graphql');
  });

  test('falls back to the generic metadata bag when formatMetadata lacks provenance', () => {
    const s = resolveCatalogSource(null, { source_url: 'https://example.com/api' });
    expect(s?.kind).toBe('url');
  });

  test('a labelless discovery source still renders with its fallback label', () => {
    const s = resolveCatalogSource({ inputKind: 'discovery' }, null);
    expect(s).toEqual({ kind: 'discovery', label: 'Live discovery', title: 'Live discovery' });
  });

  test('returns undefined when there is no source material', () => {
    expect(resolveCatalogSource(null, null)).toBeUndefined();
    expect(resolveCatalogSource({}, {})).toBeUndefined();
    expect(resolveCatalogSource({ unrelated: 'x' }, null)).toBeUndefined();
  });

  test('a non-discovery kind with no label is not enough to render', () => {
    expect(resolveCatalogSource({ inputKind: 'file' }, null)).toBeUndefined();
  });
});
