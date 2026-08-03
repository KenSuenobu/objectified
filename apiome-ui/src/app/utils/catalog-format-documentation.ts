/**
 * Official technical documentation URLs for catalog import formats (MFI-23.12).
 *
 * The supported-formats gallery links each importable card to the authoritative spec or reference
 * for that format. Keys are canonical {@link CatalogFormat.id} values from
 * {@link catalog-format-registry}.
 */

/** Official documentation URL per importable catalog format id. */
export const CATALOG_FORMAT_DOCUMENTATION_URL: Readonly<Record<string, string>> = {
  // RPC
  grpc: 'https://grpc.io/docs/',
  protobuf: 'https://protobuf.dev/overview/',
  thrift: 'https://thrift.apache.org/docs/',
  connectrpc: 'https://connectrpc.com/docs/introduction',
  capnproto: 'https://capnproto.org/language.html',
  wit: 'https://component-model.bytecodealliance.org/design/wit.html',
  flatbuffers: 'https://flatbuffers.dev/docs/',
  corbaidl: 'https://www.omg.org/spec/IDL/',
  oncrpc: 'https://datatracker.ietf.org/doc/html/rfc5531',
  xmlrpc: 'https://xmlrpc.com/spec',
  openrpc: 'https://spec.open-rpc.org/',

  // Graph
  graphql: 'https://spec.graphql.org/',

  // Event
  asyncapi: 'https://www.asyncapi.com/docs/reference/specification/latest',
  cloudevents: 'https://cloudevents.io/',

  // REST (non-OpenAPI)
  raml: 'https://raml.org/specs/300',
  postman: 'https://schema.getpostman.com/json/collection/v2.1.0/docs/index.html',
  'http-file': 'https://www.jetbrains.com/help/idea/exploring-http-syntax.html',
  kong: 'https://docs.konghq.com/gateway/latest/production/deployment-topologies/db-less-and-declarative-config/',
  'gateway-api': 'https://gateway-api.sigs.k8s.io/api-types/httproute/',
  odata: 'https://www.odata.org/documentation/',
  wsdl: 'https://www.w3.org/TR/wsdl',
  wadl: 'https://www.w3.org/Submission/wadl/',
  discovery: 'https://developers.google.com/discovery/v1/reference',
  apiblueprint: 'https://apiblueprint.org/documentation/specification.html',
  smithy: 'https://smithy.io/2.0/spec/index.html',
  typespec: 'https://typespec.io/docs',

  // Workflows
  arazzo: 'https://spec.openapis.org/arazzo/latest.html',

  // Agent
  'llm-tools': 'https://platform.openai.com/docs/guides/function-calling',

  // Data schema
  jsonschema: 'https://json-schema.org/draft/2020-12/json-schema-core',
  'k8s-crd':
    'https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/',
  avro: 'https://avro.apache.org/docs/current/specification/',
  jtd: 'https://www.rfc-editor.org/rfc/rfc8927',
  xsd: 'https://www.w3.org/TR/xmlschema11-1/',
  asn1: 'https://www.itu.int/rec/T-REC-X.680',
  cobolcopybook: 'https://www.ibm.com/docs/en/cobol-zos/latest?topic=programs-copybook',

  // Healthcare
  fhir: 'https://hl7.org/fhir/R4/',
  hl7v2: 'https://www.hl7.org/implement/standards/product_brief.cfm?product_id=185',

  // Finance / B2B
  edix12: 'https://x12.org/products/industry-data-standards',
  iso20022: 'https://www.iso20022.org/iso-20022-message-definitions',
  iso8583: 'https://www.iso.org/standard/31628.html',
  fix: 'https://www.fixtrading.org/standards/',

  // Mainframe
  zosconnect: 'https://www.ibm.com/docs/en/zos-connect/3.0.0?topic=apis-creating-api',
};

/** Resolve the official technical documentation URL for a catalog format id, if known. */
export function catalogFormatDocumentationUrl(formatId: string): string | undefined {
  return CATALOG_FORMAT_DOCUMENTATION_URL[formatId];
}
