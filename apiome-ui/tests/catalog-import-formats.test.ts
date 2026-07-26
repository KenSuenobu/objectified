/**
 * Unit tests for the catalog store-raw format→adapter mapping (MFI-23.7).
 */
import { describe, test, expect } from '@jest/globals';
import {
  catalogAdapterForFormat,
  decideCatalogImportRouting,
  paradigmForFormat,
  formatFamily,
  isCatalogStorableFormat,
  CATALOG_STORABLE_SOURCES,
} from '../src/app/utils/catalog-import-formats';

describe('catalog-import-formats', () => {
  test('maps adapter-backed detected formats to their REST source_kind', () => {
    expect(catalogAdapterForFormat('protobuf')?.sourceKind).toBe('grpc');
    expect(catalogAdapterForFormat('grpc')?.sourceKind).toBe('grpc');
    expect(catalogAdapterForFormat('graphql')?.sourceKind).toBe('graphql');
    expect(catalogAdapterForFormat('asyncapi')?.sourceKind).toBe('asyncapi');
    expect(catalogAdapterForFormat('thrift')?.sourceKind).toBe('thrift');
    expect(catalogAdapterForFormat('connectrpc')?.sourceKind).toBe('connectrpc');
    expect(catalogAdapterForFormat('connect')?.sourceKind).toBe('connectrpc');
    expect(catalogAdapterForFormat('flatbuffers')?.sourceKind).toBe('flatbuffers');
    expect(catalogAdapterForFormat('fbs')?.sourceKind).toBe('flatbuffers');
    expect(catalogAdapterForFormat('capnproto')?.sourceKind).toBe('capnproto');
    expect(catalogAdapterForFormat('capnp')?.sourceKind).toBe('capnproto');
    expect(catalogAdapterForFormat('wsdl')?.sourceKind).toBe('wsdl');
    expect(catalogAdapterForFormat('soap')?.sourceKind).toBe('wsdl');
    expect(catalogAdapterForFormat('raml')?.sourceKind).toBe('raml');
    expect(catalogAdapterForFormat('wadl')?.sourceKind).toBe('wadl');
    expect(catalogAdapterForFormat('restdescription')?.sourceKind).toBe('wadl');
    expect(catalogAdapterForFormat('openrpc')?.sourceKind).toBe('openrpc');
    expect(catalogAdapterForFormat('jsonrpc')?.sourceKind).toBe('openrpc');
    expect(catalogAdapterForFormat('avro')?.sourceKind).toBe('avro');
    expect(catalogAdapterForFormat('avsc')?.sourceKind).toBe('avro');
    expect(catalogAdapterForFormat('xmlrpc')?.sourceKind).toBe('xmlrpc');
    expect(catalogAdapterForFormat('xml-rpc')?.sourceKind).toBe('xmlrpc');
    expect(catalogAdapterForFormat('xsd')?.sourceKind).toBe('xsd');
    expect(catalogAdapterForFormat('xmlschema')?.sourceKind).toBe('xsd');
    expect(catalogAdapterForFormat('postman')?.sourceKind).toBe('postman');
    expect(catalogAdapterForFormat('postmancollection')?.sourceKind).toBe('postman');
    expect(catalogAdapterForFormat('cloudevents')?.sourceKind).toBe('cloudevents');
    expect(catalogAdapterForFormat('cloud-events')?.sourceKind).toBe('cloudevents');
    expect(catalogAdapterForFormat('smithy')?.sourceKind).toBe('smithy');
    expect(catalogAdapterForFormat('apiblueprint')?.sourceKind).toBe('apiblueprint');
    expect(catalogAdapterForFormat('api-blueprint')?.sourceKind).toBe('apiblueprint');
    expect(catalogAdapterForFormat('apib')?.sourceKind).toBe('apiblueprint');
    expect(catalogAdapterForFormat('asn1')?.sourceKind).toBe('asn1');
    expect(catalogAdapterForFormat('asn')?.sourceKind).toBe('asn1');
    expect(catalogAdapterForFormat('edix12')?.sourceKind).toBe('edix12');
    expect(catalogAdapterForFormat('x12')?.sourceKind).toBe('edix12');
    expect(catalogAdapterForFormat('edi')?.sourceKind).toBe('edix12');
    expect(catalogAdapterForFormat('oncrpc')?.sourceKind).toBe('oncrpc');
    expect(catalogAdapterForFormat('sunrpc')?.sourceKind).toBe('oncrpc');
    expect(catalogAdapterForFormat('xdr')?.sourceKind).toBe('oncrpc');
    expect(catalogAdapterForFormat('corbaidl')?.sourceKind).toBe('corbaidl');
    expect(catalogAdapterForFormat('corba')?.sourceKind).toBe('corbaidl');
    expect(catalogAdapterForFormat('idl')?.sourceKind).toBe('corbaidl');
    expect(catalogAdapterForFormat('odata')?.sourceKind).toBe('odata');
    expect(catalogAdapterForFormat('edmx')?.sourceKind).toBe('odata');
    expect(catalogAdapterForFormat('fhir')?.sourceKind).toBe('fhir');
    expect(catalogAdapterForFormat('fhirr4')?.sourceKind).toBe('fhir');
    expect(catalogAdapterForFormat('structuredefinition')?.sourceKind).toBe('fhir');
    expect(catalogAdapterForFormat('hl7v2')?.sourceKind).toBe('hl7v2');
    expect(catalogAdapterForFormat('hl7')?.sourceKind).toBe('hl7v2');
    expect(catalogAdapterForFormat('hl7v2x')?.sourceKind).toBe('hl7v2');
    expect(catalogAdapterForFormat('iso20022')?.sourceKind).toBe('iso20022');
    expect(catalogAdapterForFormat('iso8583')?.sourceKind).toBe('iso8583');
    expect(catalogAdapterForFormat('cobolcopybook')?.sourceKind).toBe('cobolcopybook');
    expect(catalogAdapterForFormat('copybook')?.sourceKind).toBe('cobolcopybook');
    expect(catalogAdapterForFormat('cobol')?.sourceKind).toBe('cobolcopybook');
    expect(catalogAdapterForFormat('cobol-copybook')?.sourceKind).toBe('cobolcopybook');
    expect(catalogAdapterForFormat('fix')?.sourceKind).toBe('fix');
    expect(catalogAdapterForFormat('fixprotocol')?.sourceKind).toBe('fix');
    expect(catalogAdapterForFormat('zosconnect')?.sourceKind).toBe('zosconnect');
    expect(catalogAdapterForFormat('zos')?.sourceKind).toBe('zosconnect');
    expect(catalogAdapterForFormat('zos-connect')?.sourceKind).toBe('zosconnect');
    expect(catalogAdapterForFormat('jsonschema')?.sourceKind).toBe('json-schema');
    expect(catalogAdapterForFormat('json-schema')?.sourceKind).toBe('json-schema');
    expect(catalogAdapterForFormat('json-schema-2020-12')?.sourceKind).toBe('json-schema');
    expect(catalogAdapterForFormat('typespec')?.sourceKind).toBe('typespec');
    expect(catalogAdapterForFormat('tsp')?.sourceKind).toBe('typespec');
    expect(catalogAdapterForFormat('cadl')?.sourceKind).toBe('typespec');
  });

  test('is case/space-insensitive', () => {
    expect(catalogAdapterForFormat(' Protobuf ')?.sourceKind).toBe('grpc');
    expect(catalogAdapterForFormat('GraphQL')?.sourceKind).toBe('graphql');
  });

  test('returns null for formats with no catalog importer (…)', () => {
    for (const f of ['openapi', 'swagger', 'unknown', '', null, undefined]) {
      expect(catalogAdapterForFormat(f)).toBeNull();
      expect(isCatalogStorableFormat(f)).toBe(false);
    }
  });

  test('exposes the distinct storable sources (deduped by source_kind)', () => {
    const kinds = CATALOG_STORABLE_SOURCES.map((s) => s.sourceKind).sort();
    expect(kinds).toEqual(['apiblueprint', 'arazzo', 'asn1', 'asyncapi', 'avro', 'capnproto', 'cloudevents', 'cobolcopybook', 'connectrpc', 'corbaidl', 'discovery', 'edix12', 'fhir', 'fix', 'flatbuffers', 'graphql', 'grpc', 'hl7v2', 'iso20022', 'iso8583', 'json-schema', 'jtd', 'k8s-crd', 'odata', 'oncrpc', 'openrpc', 'postman', 'raml', 'smithy', 'thrift', 'typespec', 'wadl', 'wsdl', 'xmlrpc', 'xsd', 'zosconnect']);
  });

  test('routes adapter-backed formats to catalog', () => {
    expect(decideCatalogImportRouting('graphql')).toMatchObject({
      destination: 'catalog',
      label: 'Catalog',
      adapter: { sourceKind: 'graphql' },
    });
    expect(decideCatalogImportRouting('protobuf')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'grpc' },
    });
    expect(decideCatalogImportRouting('raml')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'raml' },
    });
    expect(decideCatalogImportRouting('wadl')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'wadl' },
    });
    expect(decideCatalogImportRouting('openrpc')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'openrpc' },
    });
    expect(decideCatalogImportRouting('discovery')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'discovery' },
    });
    expect(decideCatalogImportRouting('k8s-crd')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'k8s-crd' },
    });
    expect(decideCatalogImportRouting('avro')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'avro' },
    });
    expect(decideCatalogImportRouting('xmlrpc')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'xmlrpc' },
    });
    expect(decideCatalogImportRouting('xsd')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'xsd' },
    });
    expect(decideCatalogImportRouting('postman')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'postman' },
    });
    expect(decideCatalogImportRouting('cloudevents')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'cloudevents' },
    });
    expect(decideCatalogImportRouting('smithy')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'smithy' },
    });
    expect(decideCatalogImportRouting('api-blueprint')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'apiblueprint' },
    });
    expect(decideCatalogImportRouting('asn1')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'asn1' },
    });
    expect(decideCatalogImportRouting('edix12')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'edix12' },
    });
    expect(decideCatalogImportRouting('oncrpc')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'oncrpc' },
    });
    expect(decideCatalogImportRouting('corbaidl')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'corbaidl' },
    });
    expect(decideCatalogImportRouting('odata')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'odata' },
    });
    expect(decideCatalogImportRouting('fhir')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'fhir' },
    });
    expect(decideCatalogImportRouting('hl7v2')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'hl7v2' },
    });
    expect(decideCatalogImportRouting('iso20022')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'iso20022' },
    });
    expect(decideCatalogImportRouting('iso8583')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'iso8583' },
    });
    expect(decideCatalogImportRouting('cobolcopybook')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'cobolcopybook' },
    });
    expect(decideCatalogImportRouting('fix')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'fix' },
    });
    expect(decideCatalogImportRouting('zosconnect')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'zosconnect' },
    });
    expect(decideCatalogImportRouting('json-schema')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'json-schema' },
    });
    expect(decideCatalogImportRouting('jsonschema')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'json-schema' },
    });
    expect(decideCatalogImportRouting('jtd')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'jtd' },
    });
    expect(decideCatalogImportRouting('jsontypedefinition')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'jtd' },
    });
    expect(decideCatalogImportRouting('typespec')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'typespec' },
    });
    expect(decideCatalogImportRouting('arazzo')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'arazzo' },
    });
    expect(decideCatalogImportRouting('workflows')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'arazzo' },
    });
  });

  test('routes OpenAPI, Swagger to Projects', () => {
    for (const f of ['openapi', 'openapi-3.1', 'swagger', 'swagger-2.0']) {
      expect(decideCatalogImportRouting(f)).toMatchObject({
        destination: 'project',
        label: 'Projects',
        adapter: null,
      });
    }
  });

  test('routes spaced JSON Schema label to destination choice', () => {
    expect(decideCatalogImportRouting('JSON Schema')).toMatchObject({
      destination: 'json-schema-choice',
      adapter: null,
    });
  });

  test('routes unsupported formats to not-importable', () => {
    expect(decideCatalogImportRouting('totally-made-up')).toMatchObject({
      destination: 'not-importable',
      adapter: null,
    });
  });

  // --- MFI-26.3: versioned detector tokens + paradigm mapping ---

  test('folds versioned detector tokens to their format family', () => {
    expect(formatFamily('asyncapi-2')).toBe('asyncapi');
    expect(formatFamily('asyncapi-3')).toBe('asyncapi');
    expect(formatFamily('openapi-3.1')).toBe('openapi');
    expect(formatFamily('swagger-2.0')).toBe('swagger');
    expect(formatFamily('json-schema-2020-12')).toBe('json-schema');
    // Non-version tails (a hyphenated family name) are preserved.
    expect(formatFamily('api-blueprint')).toBe('api-blueprint');
    expect(formatFamily(' GraphQL ')).toBe('graphql');
    expect(formatFamily(null)).toBe('');
  });

  test('resolves the AsyncAPI adapter from versioned detect tokens (asyncapi-2/3)', () => {
    expect(catalogAdapterForFormat('asyncapi-2')?.sourceKind).toBe('asyncapi');
    expect(catalogAdapterForFormat('asyncapi-3')?.sourceKind).toBe('asyncapi');
    expect(decideCatalogImportRouting('asyncapi-2')).toMatchObject({
      destination: 'catalog',
      adapter: { sourceKind: 'asyncapi' },
    });
  });

  test('maps detected formats to the paradigm the server routing_decision uses', () => {
    expect(paradigmForFormat('protobuf')).toBe('rpc');
    expect(paradigmForFormat('grpc')).toBe('rpc');
    expect(paradigmForFormat('graphql')).toBe('graph');
    expect(paradigmForFormat('asyncapi-2')).toBe('event');
    expect(paradigmForFormat('thrift')).toBe('rpc');
    expect(paradigmForFormat('connectrpc')).toBe('rpc');
    expect(paradigmForFormat('flatbuffers')).toBe('dataschema');
    expect(paradigmForFormat('fbs')).toBe('dataschema');
    expect(paradigmForFormat('capnproto')).toBe('rpc');
    expect(paradigmForFormat('capnp')).toBe('rpc');
    expect(paradigmForFormat('wsdl')).toBe('rest');
    expect(paradigmForFormat('soap')).toBe('rest');
    expect(paradigmForFormat('raml')).toBe('rest');
    expect(paradigmForFormat('wadl')).toBe('rest');
    expect(paradigmForFormat('restdescription')).toBe('rest');
    expect(paradigmForFormat('discovery')).toBe('rest');
    expect(paradigmForFormat('k8s-crd')).toBe('dataschema');
    expect(paradigmForFormat('crd')).toBe('dataschema');
    expect(paradigmForFormat('openrpc')).toBe('rpc');
    expect(paradigmForFormat('jsonrpc')).toBe('rpc');
    expect(paradigmForFormat('avro')).toBe('dataschema');
    expect(paradigmForFormat('xmlrpc')).toBe('rpc');
    expect(paradigmForFormat('xsd')).toBe('dataschema');
    expect(paradigmForFormat('asn1')).toBe('dataschema');
    expect(paradigmForFormat('asn')).toBe('dataschema');
    expect(paradigmForFormat('edix12')).toBe('dataschema');
    expect(paradigmForFormat('x12')).toBe('dataschema');
    expect(paradigmForFormat('edi')).toBe('dataschema');
    expect(paradigmForFormat('oncrpc')).toBe('rpc');
    expect(paradigmForFormat('sunrpc')).toBe('rpc');
    expect(paradigmForFormat('xdr')).toBe('rpc');
    expect(paradigmForFormat('corbaidl')).toBe('rpc');
    expect(paradigmForFormat('idl')).toBe('rpc');
    expect(paradigmForFormat('odata')).toBe('rest');
    expect(paradigmForFormat('edmx')).toBe('rest');
    expect(paradigmForFormat('fhir')).toBe('rest');
    expect(paradigmForFormat('structuredefinition')).toBe('rest');
    expect(paradigmForFormat('hl7v2')).toBe('dataschema');
    expect(paradigmForFormat('hl7')).toBe('dataschema');
    expect(paradigmForFormat('iso20022')).toBe('dataschema');
    expect(paradigmForFormat('iso8583')).toBe('dataschema');
    expect(paradigmForFormat('cobolcopybook')).toBe('dataschema');
    expect(paradigmForFormat('copybook')).toBe('dataschema');
    expect(paradigmForFormat('cobol')).toBe('dataschema');
    expect(paradigmForFormat('cobol-copybook')).toBe('dataschema');
    expect(paradigmForFormat('fix')).toBe('dataschema');
    expect(paradigmForFormat('fixprotocol')).toBe('dataschema');
    expect(paradigmForFormat('zosconnect')).toBe('rest');
    expect(paradigmForFormat('zos')).toBe('rest');
    expect(paradigmForFormat('zos-connect')).toBe('rest');
    expect(paradigmForFormat('jsonschema')).toBe('dataschema');
    expect(paradigmForFormat('json-schema')).toBe('dataschema');
    expect(paradigmForFormat('jtd')).toBe('dataschema');
    expect(paradigmForFormat('jsontypedefinition')).toBe('dataschema');
    expect(paradigmForFormat('arazzo')).toBe('rest');
    expect(paradigmForFormat('workflows')).toBe('rest');
    expect(paradigmForFormat('typespec')).toBe('rest');
    expect(paradigmForFormat('tsp')).toBe('rest');
    expect(paradigmForFormat('postman')).toBe('rest');
    expect(paradigmForFormat('cloudevents')).toBe('event');
    expect(paradigmForFormat('cloud-events')).toBe('event');
    expect(paradigmForFormat('smithy')).toBe('rpc');
    expect(paradigmForFormat('api-blueprint')).toBe('rest');
    expect(paradigmForFormat('apib')).toBe('rest');
    expect(paradigmForFormat('avsc')).toBe('dataschema');
    expect(paradigmForFormat('openapi-3.1')).toBe('rest');
    expect(paradigmForFormat('swagger-2.0')).toBe('rest');
    expect(paradigmForFormat('json-schema-2020-12')).toBe('dataschema');
  });

  test('returns null paradigm for unknown / unmapped formats', () => {
    for (const f of ['unknown', '', null, undefined]) {
      expect(paradigmForFormat(f)).toBeNull();
    }
  });
});
