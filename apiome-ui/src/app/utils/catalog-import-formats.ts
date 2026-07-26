/**
 * Catalog store-raw import: detected format → REST adapter `source_kind` (MFI-23.7).
 *
 * The catalog importer stores a non-OpenAPI source **verbatim** (no conversion) by running it
 * through the REST spec-import adapter pipeline, which persists a catalog item and keeps the raw
 * bytes for later conversion. That pipeline resolves the request's `source_kind` against the
 * server-side import-source registry, so a source is storable only when a **registered adapter**
 * can parse it. Today those adapters are gRPC/Protobuf, GraphQL, AsyncAPI, Thrift, Connect RPC,
 * FlatBuffers, Cap'n Proto, WSDL, RAML, WADL, OpenRPC, Avro, XML-RPC, XSD, ASN.1, EDI X12, ONC RPC, CORBA IDL, OData, FHIR, and Postman (OpenAPI/Swagger are native and go to Projects, not
 * the catalog).
 *
 * This maps the client analyzer's detected `format` token (see `openapi-analyzer.ts`) to the
 * adapter registry key the REST job needs, or `null` when no adapter can store the format yet —
 * so the UI can clearly say "recognized, but not importable to the catalog yet" instead of failing
 * an import mid-flight.
 */

/** An adapter-backed catalog source: the detected format, the REST `source_kind`, and a label. */
export interface CatalogAdapterSource {
  /** REST import-source registry key the spec-import job runs under. */
  sourceKind: string;
  /** Human label for the source. */
  label: string;
}

export type CatalogImportDestination =
  | 'catalog'
  | 'project'
  | 'json-schema-choice'
  | 'not-importable';

export interface CatalogImportRoutingDecision {
  destination: CatalogImportDestination;
  label: string;
  description: string;
  adapter: CatalogAdapterSource | null;
}

// Format *families* (post-{@link formatFamily} normalization) that route to Projects rather than the
// catalog: the native REST formats.
const PROJECT_FORMATS = new Set(['openapi', 'swagger']);

// JSON Schema families that still trigger the Catalog-vs-Types/Projects prompt when no adapter
// mapping exists (e.g. a spaced label). Registered `json-schema` / `jsonschema` families route
// directly to the catalog adapter like other store-raw formats.
const JSON_SCHEMA_FORMATS = new Set(['json schema']);

/**
 * Detected-format token → adapter source. Keys are format *families* (see {@link formatFamily}); a
 * Protobuf document (`.proto`) routes to the gRPC adapter (its registry key is `grpc`, and it emits
 * the `protobuf` format), and every AsyncAPI version (`asyncapi-2` / `asyncapi-3`) folds to the one
 * `asyncapi` adapter.
 */
const FORMAT_TO_ADAPTER: Readonly<Record<string, CatalogAdapterSource>> = {
  protobuf: { sourceKind: 'grpc', label: 'gRPC / Protobuf' },
  grpc: { sourceKind: 'grpc', label: 'gRPC / Protobuf' },
  graphql: { sourceKind: 'graphql', label: 'GraphQL' },
  asyncapi: { sourceKind: 'asyncapi', label: 'AsyncAPI' },
  thrift: { sourceKind: 'thrift', label: 'Thrift' },
  connectrpc: { sourceKind: 'connectrpc', label: 'Connect RPC' },
  connect: { sourceKind: 'connectrpc', label: 'Connect RPC' },
  flatbuffers: { sourceKind: 'flatbuffers', label: 'FlatBuffers' },
  fbs: { sourceKind: 'flatbuffers', label: 'FlatBuffers' },
  capnproto: { sourceKind: 'capnproto', label: "Cap'n Proto" },
  capnp: { sourceKind: 'capnproto', label: "Cap'n Proto" },
  wsdl: { sourceKind: 'wsdl', label: 'WSDL' },
  soap: { sourceKind: 'wsdl', label: 'WSDL' },
  raml: { sourceKind: 'raml', label: 'RAML' },
  wadl: { sourceKind: 'wadl', label: 'WADL' },
  restdescription: { sourceKind: 'wadl', label: 'WADL' },
  discovery: { sourceKind: 'discovery', label: 'Google API Discovery' },
  'google-discovery': { sourceKind: 'discovery', label: 'Google API Discovery' },
  googlediscovery: { sourceKind: 'discovery', label: 'Google API Discovery' },
  openrpc: { sourceKind: 'openrpc', label: 'OpenRPC' },
  jsonrpc: { sourceKind: 'openrpc', label: 'OpenRPC' },
  avro: { sourceKind: 'avro', label: 'Avro' },
  avsc: { sourceKind: 'avro', label: 'Avro' },
  xmlrpc: { sourceKind: 'xmlrpc', label: 'XML-RPC' },
  'xml-rpc': { sourceKind: 'xmlrpc', label: 'XML-RPC' },
  xsd: { sourceKind: 'xsd', label: 'XSD' },
  xmlschema: { sourceKind: 'xsd', label: 'XSD' },
  postman: { sourceKind: 'postman', label: 'Postman' },
  postmancollection: { sourceKind: 'postman', label: 'Postman' },
  cloudevents: { sourceKind: 'cloudevents', label: 'CloudEvents' },
  'cloud-events': { sourceKind: 'cloudevents', label: 'CloudEvents' },
  smithy: { sourceKind: 'smithy', label: 'Smithy' },
  apiblueprint: { sourceKind: 'apiblueprint', label: 'API Blueprint' },
  'api-blueprint': { sourceKind: 'apiblueprint', label: 'API Blueprint' },
  apib: { sourceKind: 'apiblueprint', label: 'API Blueprint' },
  blueprint: { sourceKind: 'apiblueprint', label: 'API Blueprint' },
  arazzo: { sourceKind: 'arazzo', label: 'Arazzo' },
  workflows: { sourceKind: 'arazzo', label: 'Arazzo' },
  asn1: { sourceKind: 'asn1', label: 'ASN.1' },
  asn: { sourceKind: 'asn1', label: 'ASN.1' },
  edix12: { sourceKind: 'edix12', label: 'EDI X12' },
  x12: { sourceKind: 'edix12', label: 'EDI X12' },
  edi: { sourceKind: 'edix12', label: 'EDI X12' },
  oncrpc: { sourceKind: 'oncrpc', label: 'ONC RPC' },
  sunrpc: { sourceKind: 'oncrpc', label: 'ONC RPC' },
  rpcgen: { sourceKind: 'oncrpc', label: 'ONC RPC' },
  xdr: { sourceKind: 'oncrpc', label: 'ONC RPC' },
  corbaidl: { sourceKind: 'corbaidl', label: 'CORBA IDL' },
  corba: { sourceKind: 'corbaidl', label: 'CORBA IDL' },
  idl: { sourceKind: 'corbaidl', label: 'CORBA IDL' },
  odata: { sourceKind: 'odata', label: 'OData' },
  edmx: { sourceKind: 'odata', label: 'OData' },
  fhir: { sourceKind: 'fhir', label: 'FHIR' },
  fhirr4: { sourceKind: 'fhir', label: 'FHIR' },
  structuredefinition: { sourceKind: 'fhir', label: 'FHIR' },
  hl7v2: { sourceKind: 'hl7v2', label: 'HL7 v2' },
  hl7: { sourceKind: 'hl7v2', label: 'HL7 v2' },
  hl7v2x: { sourceKind: 'hl7v2', label: 'HL7 v2' },
  iso20022: { sourceKind: 'iso20022', label: 'ISO 20022' },
  iso8583: { sourceKind: 'iso8583', label: 'ISO 8583' },
  cobolcopybook: { sourceKind: 'cobolcopybook', label: 'COBOL Copybook' },
  copybook: { sourceKind: 'cobolcopybook', label: 'COBOL Copybook' },
  cobol: { sourceKind: 'cobolcopybook', label: 'COBOL Copybook' },
  'cobol-copybook': { sourceKind: 'cobolcopybook', label: 'COBOL Copybook' },
  fix: { sourceKind: 'fix', label: 'FIX' },
  fixprotocol: { sourceKind: 'fix', label: 'FIX' },
  zosconnect: { sourceKind: 'zosconnect', label: 'z/OS Connect' },
  zos: { sourceKind: 'zosconnect', label: 'z/OS Connect' },
  'zos-connect': { sourceKind: 'zosconnect', label: 'z/OS Connect' },
  jsonschema: { sourceKind: 'json-schema', label: 'JSON Schema' },
  'json-schema': { sourceKind: 'json-schema', label: 'JSON Schema' },
  'k8s-crd': { sourceKind: 'k8s-crd', label: 'Kubernetes CRD' },
  'kubernetes-crd': { sourceKind: 'k8s-crd', label: 'Kubernetes CRD' },
  k8scrd: { sourceKind: 'k8s-crd', label: 'Kubernetes CRD' },
  crd: { sourceKind: 'k8s-crd', label: 'Kubernetes CRD' },
  'llm-tools': { sourceKind: 'llm-tools', label: 'LLM Tools' },
  llmtools: { sourceKind: 'llm-tools', label: 'LLM Tools' },
  'function-calling': { sourceKind: 'llm-tools', label: 'LLM Tools' },
  'openai-tools': { sourceKind: 'llm-tools', label: 'LLM Tools' },
  'anthropic-tools': { sourceKind: 'llm-tools', label: 'LLM Tools' },
  jtd: { sourceKind: 'jtd', label: 'JSON Type Definition' },
  jsontypedefinition: { sourceKind: 'jtd', label: 'JSON Type Definition' },
  rfc8927: { sourceKind: 'jtd', label: 'JSON Type Definition' },
  typespec: { sourceKind: 'typespec', label: 'TypeSpec' },
  tsp: { sourceKind: 'typespec', label: 'TypeSpec' },
  cadl: { sourceKind: 'typespec', label: 'TypeSpec' },
};

/**
 * Detected-format family → canonical API paradigm id (the `ApiParadigm` the import adapter emits,
 * matching the server's `routing_decision`). Used to show "· paradigm Y" after detection (MFI-26.3);
 * the ids resolve to display labels via the shared protocol registry (`resolveCatalogProtocol`).
 */
const FORMAT_TO_PARADIGM: Readonly<Record<string, string>> = {
  grpc: 'rpc',
  protobuf: 'rpc',
  graphql: 'graph',
  asyncapi: 'event',
  thrift: 'rpc',
  connectrpc: 'rpc',
  connect: 'rpc',
  flatbuffers: 'dataschema',
  fbs: 'dataschema',
  capnproto: 'rpc',
  capnp: 'rpc',
  wsdl: 'rest',
  soap: 'rest',
  raml: 'rest',
  wadl: 'rest',
  restdescription: 'rest',
  discovery: 'rest',
  'google-discovery': 'rest',
  googlediscovery: 'rest',
  openrpc: 'rpc',
  jsonrpc: 'rpc',
  avro: 'dataschema',
  avsc: 'dataschema',
  xmlrpc: 'rpc',
  'xml-rpc': 'rpc',
  xsd: 'dataschema',
  xmlschema: 'dataschema',
  postman: 'rest',
  postmancollection: 'rest',
  cloudevents: 'event',
  'cloud-events': 'event',
  smithy: 'rpc',
  apiblueprint: 'rest',
  'api-blueprint': 'rest',
  apib: 'rest',
  blueprint: 'rest',
  arazzo: 'rest',
  workflows: 'rest',
  openapi: 'rest',
  swagger: 'rest',
  jsonschema: 'dataschema',
  'json-schema': 'dataschema',
  'k8s-crd': 'dataschema',
  'kubernetes-crd': 'dataschema',
  k8scrd: 'dataschema',
  crd: 'dataschema',
  'llm-tools': 'agent',
  llmtools: 'agent',
  'function-calling': 'agent',
  'openai-tools': 'agent',
  'anthropic-tools': 'agent',
  jtd: 'dataschema',
  jsontypedefinition: 'dataschema',
  rfc8927: 'dataschema',
  asn1: 'dataschema',
  asn: 'dataschema',
  edix12: 'dataschema',
  x12: 'dataschema',
  edi: 'dataschema',
  oncrpc: 'rpc',
  sunrpc: 'rpc',
  rpcgen: 'rpc',
  xdr: 'rpc',
  corbaidl: 'rpc',
  corba: 'rpc',
  idl: 'rpc',
  odata: 'rest',
  edmx: 'rest',
  fhir: 'rest',
  fhirr4: 'rest',
  structuredefinition: 'rest',
  hl7v2: 'dataschema',
  hl7: 'dataschema',
  hl7v2x: 'dataschema',
  iso20022: 'dataschema',
  iso8583: 'dataschema',
  cobolcopybook: 'dataschema',
  copybook: 'dataschema',
  cobol: 'dataschema',
  'cobol-copybook': 'dataschema',
  fix: 'dataschema',
  fixprotocol: 'dataschema',
  zosconnect: 'rest',
  zos: 'rest',
  'zos-connect': 'rest',
  typespec: 'rest',
  tsp: 'rest',
  cadl: 'rest',
};

/**
 * Fold a detected-format token to its format *family* by stripping a trailing version segment, so
 * versioned detector outputs resolve to one entry — `asyncapi-2` → `asyncapi`, `openapi-3.1` →
 * `openapi`, `swagger-2.0` → `swagger`, `json-schema-2020-12` → `json-schema`. Only a version-like
 * tail (one that begins with a digit) is removed, so families such as `api-blueprint` are preserved.
 *
 * @param format The detected format token, or null/undefined.
 * @returns The lower-cased, trimmed family key (empty string when no format was supplied).
 */
export function formatFamily(format: string | null | undefined): string {
  return (format ?? '').trim().toLowerCase().replace(/-\d[\d.]*(?:-\d[\d.]*)*$/, '');
}

/**
 * Resolve the adapter source for a detected format, or `null` when no registered adapter can store
 * it in the catalog yet.
 *
 * @param format The detected format token (e.g. `protobuf`, `graphql`, `asyncapi-2`).
 * @returns The adapter source, or `null` for unknown / native / not-yet-adapter-backed formats.
 */
export function catalogAdapterForFormat(
  format: string | null | undefined,
): CatalogAdapterSource | null {
  if (!format) return null;
  return FORMAT_TO_ADAPTER[formatFamily(format)] ?? null;
}

/**
 * The canonical API paradigm id for a detected format, or `null` when unknown. Mirrors the paradigm
 * the server-side import adapter stamps on its `routing_decision`, so the UI's "paradigm Y" note
 * and the eventual catalog item agree.
 *
 * @param format The detected format token (e.g. `graphql`, `asyncapi-3`, `openapi-3.1`).
 * @returns A paradigm id (`rpc` / `graph` / `event` / `rest` / `dataschema`), or `null`.
 */
export function paradigmForFormat(format: string | null | undefined): string | null {
  if (!format) return null;
  return FORMAT_TO_PARADIGM[formatFamily(format)] ?? null;
}

export function decideCatalogImportRouting(
  format: string | null | undefined,
): CatalogImportRoutingDecision {
  const key = formatFamily(format);
  const adapter = catalogAdapterForFormat(key);

  if (adapter) {
    return {
      destination: 'catalog',
      label: 'Catalog',
      description: `${adapter.label} imports are stored in the catalog and converted only when explicitly requested.`,
      adapter,
    };
  }

  if (PROJECT_FORMATS.has(key)) {
    return {
      destination: 'project',
      label: 'Projects',
      description: 'OpenAPI and Swagger create publishable Project versions instead of catalog items.',
      adapter: null,
    };
  }

  if (JSON_SCHEMA_FORMATS.has(key)) {
    return {
      destination: 'json-schema-choice',
      label: 'Choose destination',
      description: 'JSON Schema can be stored in the catalog for later conversion or imported as current Types/Projects schema.',
      adapter: null,
    };
  }

  return {
    destination: 'not-importable',
    label: 'Not importable yet',
    description: 'This format is recognized but does not have a catalog importer yet.',
    adapter: null,
  };
}

/** Whether a detected format can be stored (unconverted) in the catalog today. */
export function isCatalogStorableFormat(format: string | null | undefined): boolean {
  return catalogAdapterForFormat(format) !== null;
}

/** The distinct adapter-backed catalog sources, for messaging ("Supported: gRPC, GraphQL, AsyncAPI"). */
export const CATALOG_STORABLE_SOURCES: readonly CatalogAdapterSource[] = Array.from(
  new Map(Object.values(FORMAT_TO_ADAPTER).map((s) => [s.sourceKind, s])).values(),
);
