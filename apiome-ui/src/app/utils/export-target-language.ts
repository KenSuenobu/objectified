/**
 * Export target → Monaco language, file extension, and download filename (MFX-9.4, #3869).
 *
 * The multi-format export surface lets a version be emitted to a registered target (OpenAPI and
 * AsyncAPI today; Arazzo, GraphQL, … as their emitter epics land). A target card previews the emitted artifact and
 * offers it for download, both of which need three pieces of client metadata the backend emitter
 * descriptor does not spell out directly: the Monaco language id for syntax highlighting, the file
 * extension, and a sensible download filename. This module is the single, data-driven bridge — pure
 * functions so they can be unit-tested without rendering the editor, mirroring the import-side
 * {@link file://./catalog-source-language.ts} resolver.
 *
 * Targets are keyed by the emitter's canonical id — either its registry `format` (`openapi-3.1`,
 * `swagger-2.0`, `asyncapi-3`) or its `key` (`openapi`, `asyncapi`). Version suffixes collapse to the
 * base id, so a new OpenAPI or AsyncAPI dialect maps without a code change. Unlike a raw imported
 * source (authored as either JSON or YAML), an emitter emits a **canonical serialization** —
 * OpenAPI/Swagger/AsyncAPI emit JSON — so the default language is JSON, refined to YAML/XML only when a
 * byte sample of the actual artifact says otherwise (e.g. the CLI's `--yaml` output). Protobuf/gRPC
 * emits `.proto` source (Monaco `protobuf` grammar). GraphQL emits SDL (Monaco `graphql` grammar).
 * Avro emits `.avsc` JSON (Monaco `json` grammar). Unknown targets degrade to `plaintext` when no
 * sample is available, and are otherwise sniffed as JSON/YAML/XML when their bytes are recognisable.
 *
 * The full registry-driven export dialog + target-card grid is a later epic (MFX-EPIC-41); this
 * module is the small client-metadata layer that grid — and any emitted-artifact viewer — reads.
 *
 * The Monaco artifact viewer (MFX-EPIC-43) emits ~20 languages — proto, GraphQL SDL, WSDL/XSD XML,
 * YAML/JSON, SQL, RAML, Markdown/apib, thrift, asn.1, copybook… — far more than the handful of
 * emitter *keys* the export dialog knows by name. {@link monacoLanguageForArtifact} resolves those
 * the way the registry does: it lets the emitted artifact's own `mediaType` and filename extension
 * decide the highlight language, so a newly-registered emitter highlights correctly from its
 * descriptor alone, with no change here. It falls back to `plaintext` when nothing recognises the
 * artifact.
 */

/** The client metadata one export target carries: highlight language, extension, and filename stem. */
interface ExportTargetMeta {
  /** Monaco language id for the emitter's canonical serialization. */
  readonly language: string;
  /** File extension (with leading dot) for the emitter's canonical serialization. */
  readonly extension: string;
  /** Download filename stem (no extension), e.g. `openapi` → `openapi.json`. */
  readonly baseName: string;
}

/**
 * Per canonical export-target id. OpenAPI and its Swagger 2.0 downgrade both emit JSON documents
 * (`openapi.json` / `swagger.json`); AsyncAPI 3 emits a JSON document too (`asyncapi.json`, MFX-11.5);
 * protobuf/gRPC emits `.proto` source (`api.proto` by default, MFX-12.5); GraphQL emits SDL
 * (`schema.graphql` by default, MFX-13.5); Avro emits `.avsc` JSON (`schema.avsc` by default,
 * MFX-19.5); the no-op `sample` emitter is plaintext.
 */
const EXPORT_TARGET_LANGUAGE: Readonly<Record<string, ExportTargetMeta>> = {
  openapi: { language: 'json', extension: '.json', baseName: 'openapi' },
  swagger: { language: 'json', extension: '.json', baseName: 'swagger' },
  asyncapi: { language: 'json', extension: '.json', baseName: 'asyncapi' },
  protobuf: { language: 'protobuf', extension: '.proto', baseName: 'api' },
  grpc: { language: 'protobuf', extension: '.proto', baseName: 'api' },
  graphql: { language: 'graphql', extension: '.graphql', baseName: 'schema' },
  avro: { language: 'json', extension: '.avsc', baseName: 'schema' },
  asn1: { language: 'plaintext', extension: '.asn1', baseName: 'schema' },
  edix12: { language: 'plaintext', extension: '.edi', baseName: 'interchange' },
  oncrpc: { language: 'plaintext', extension: '.x', baseName: 'program' },
  corbaidl: { language: 'plaintext', extension: '.idl', baseName: 'module' },
  odata: { language: 'xml', extension: '.edmx', baseName: 'service' },
  fhir: { language: 'json', extension: '.json', baseName: 'resource' },
  hl7v2: { language: 'plaintext', extension: '.hl7', baseName: 'message' },
  iso20022: { language: 'xml', extension: '.xml', baseName: 'message' },
  iso8583: { language: 'json', extension: '.json', baseName: 'message' },
  cobolcopybook: { language: 'plaintext', extension: '.cpy', baseName: 'record' },
  fix: { language: 'plaintext', extension: '.fix', baseName: 'message' },
  zosconnect: { language: 'json', extension: '.json', baseName: 'zosconnect' },
  'json-schema': { language: 'json', extension: '.json', baseName: 'schema' },
  jsonschema: { language: 'json', extension: '.json', baseName: 'schema' },
  jtd: { language: 'json', extension: '.jtd.json', baseName: 'schema' },
  jsontypedefinition: { language: 'json', extension: '.jtd.json', baseName: 'schema' },
  rfc8927: { language: 'json', extension: '.jtd.json', baseName: 'schema' },
  arazzo: { language: 'yaml', extension: '.yaml', baseName: 'workflow' },
  workflows: { language: 'yaml', extension: '.yaml', baseName: 'workflow' },
  typespec: { language: 'typescript', extension: '.tsp', baseName: 'api' },
  // The FMT-EPIC-2 targets (FMT-2.7, #5425). Each `baseName`/`extension` pair is the
  // filename its emitter writes *by default*, so a Studio download lands with the name the
  // destination tool expects to read — `kong.yaml` is what `deck` looks for, and
  // `requests.http` is what both request-file editors key on. A per-emit option that
  // changes the serialization (the request-file target's `curl` mode writes a `.sh`
  // script) is not visible from the target id alone, and is not modelled here.
  'k8s-crd': { language: 'yaml', extension: '.yaml', baseName: 'crd' },
  kong: { language: 'yaml', extension: '.yaml', baseName: 'kong' },
  'gateway-api': { language: 'yaml', extension: '.yaml', baseName: 'httproute' },
  'http-file': { language: 'plaintext', extension: '.http', baseName: 'requests' },
  'llm-tools': { language: 'json', extension: '.json', baseName: 'tools' },
  wit: { language: 'plaintext', extension: '.wit', baseName: 'api' },
  sample: { language: 'plaintext', extension: '.txt', baseName: 'sample' },
};

/** Emitter format keys that collapse to a canonical export-target id (`proto3` → `protobuf`). */
const EXPORT_TARGET_ALIASES: Readonly<Record<string, string>> = {
  avsc: 'avro',
  asn: 'asn1',
  x12: 'edix12',
  edi: 'edix12',
  sunrpc: 'oncrpc',
  rpcgen: 'oncrpc',
  xdr: 'oncrpc',
  corba: 'corbaidl',
  idl: 'corbaidl',
  edmx: 'odata',
  fhirr4: 'fhir',
  structuredefinition: 'fhir',
  hl7: 'hl7v2',
  hl7v2x: 'hl7v2',
  copybook: 'cobolcopybook',
  cobol: 'cobolcopybook',
  'cobol-copybook': 'cobolcopybook',
  fixprotocol: 'fix',
  zos: 'zosconnect',
  'zos-connect': 'zosconnect',
  jsonschema: 'json-schema',
  jsontypedefinition: 'jtd',
  rfc8927: 'jtd',
  workflows: 'arazzo',
  tsp: 'typespec',
  cadl: 'typespec',
  gql: 'graphql',
  proto: 'protobuf',
  proto3: 'protobuf',
  sdl: 'graphql',
  // FMT-EPIC-2 spellings (FMT-2.7, #5425).
  'kubernetes-crd': 'k8s-crd',
  crd: 'k8s-crd',
  k8scrd: 'k8s-crd',
  'kong-declarative': 'kong',
  httproute: 'gateway-api',
  gatewayapi: 'gateway-api',
  httpfile: 'http-file',
  curl: 'http-file',
  llmtools: 'llm-tools',
  'function-calling': 'llm-tools',
  'openai-tools': 'llm-tools',
  'anthropic-tools': 'llm-tools',
};

/** Targets whose emitted serialization can vary (JSON default, YAML/XML sniffed from the bytes). */
const SERIALIZED_TARGETS: ReadonlySet<string> = new Set(['openapi', 'swagger', 'asyncapi']);

/** Monaco language id → file extension for a sniff-refined serialization. */
const LANGUAGE_EXTENSION: Readonly<Record<string, string>> = {
  json: '.json',
  yaml: '.yaml',
  xml: '.xml',
};

/**
 * File extension (with leading dot, lower-cased) → Monaco language id, spanning every format the
 * emitter registry can produce. This is the registry-driven half of language resolution: any emitter
 * whose artifact carries one of these extensions highlights correctly without a per-key entry above.
 * Formats Monaco ships no grammar for (thrift, ASN.1, COBOL copybooks) map to `plaintext` so the raw
 * text still renders with line numbers.
 */
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  // Structured serializations
  '.json': 'json',
  '.avsc': 'json', // Avro schema (JSON)
  '.avro': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.raml': 'yaml', // RAML is a YAML dialect
  '.xml': 'xml',
  '.xsd': 'xml',
  '.wsdl': 'xml',
  '.wadl': 'xml',
  // IDLs / schema languages
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.graphqls': 'graphql',
  '.gql': 'graphql',
  '.sdl': 'graphql',
  '.sql': 'sql',
  // Docs
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.apib': 'markdown', // API Blueprint
  // Grammar-less: render as plaintext rather than mis-highlight
  '.http': 'plaintext', // request file — no Monaco grammar for the `.http` dialects
  '.rest': 'plaintext',
  '.wit': 'plaintext', // WebAssembly Component Model interface types
  '.sh': 'shell', // the request-file target's `curl` output mode
  '.thrift': 'plaintext',
  '.asn1': 'plaintext',
  '.asn': 'plaintext',
  '.cpy': 'plaintext', // COBOL copybook
  '.fix': 'plaintext', // FIX tag=value message
  '.cbl': 'plaintext',
  '.cob': 'plaintext',
  '.copybook': 'plaintext',
  '.txt': 'plaintext',
};

/**
 * Media-type token → Monaco language id, matched as a case-insensitive substring so charset
 * parameters (`; charset=utf-8`) and vendor/suffix forms (`application/schema+json`,
 * `application/wsdl+xml`, `application/x-protobuf`) all resolve. Ordered most-specific first, since a
 * media type is tested against each token in turn. `text/plain` is deliberately absent — it names no
 * language, so an artifact served as plaintext falls through to its filename extension or a byte
 * sniff before defaulting to `plaintext`.
 */
const MEDIA_TYPE_LANGUAGE: ReadonlyArray<readonly [string, string]> = [
  ['graphql', 'graphql'],
  ['protobuf', 'protobuf'],
  ['x-proto', 'protobuf'],
  ['markdown', 'markdown'],
  ['json', 'json'],
  ['yaml', 'yaml'],
  ['xml', 'xml'],
  ['sql', 'sql'],
];

/**
 * Resolve a Monaco language from an artifact's media type (its `Content-Type`), or `undefined` when
 * the media type is absent or names no language Monaco highlights.
 */
function languageForMediaType(mediaType: string | null | undefined): string | undefined {
  const media = (mediaType ?? '').toLowerCase();
  if (!media) return undefined;
  for (const [token, language] of MEDIA_TYPE_LANGUAGE) {
    if (media.includes(token)) return language;
  }
  return undefined;
}

/**
 * Resolve a Monaco language from an artifact's filename via its extension, or `undefined` when the
 * filename is absent or carries no known extension.
 */
function languageForExtension(filename: string | null | undefined): string | undefined {
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_LANGUAGE[name.slice(dot)];
}

/**
 * Collapse an emitter `format`/`key` to its base target id: lower-cased, with any version or variant
 * suffix dropped (`openapi-3.1` → `openapi`, `swagger-2.0` → `swagger`). Returns `undefined` when the
 * base id is not a known export target.
 */
function resolveExportTargetId(target: string | null | undefined): string | undefined {
  const normalized = (target ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized in EXPORT_TARGET_LANGUAGE) return normalized;
  const aliased = EXPORT_TARGET_ALIASES[normalized];
  if (aliased) return aliased;
  const base = normalized.split(/[-\s]/, 1)[0];
  if (base in EXPORT_TARGET_LANGUAGE) return base;
  return EXPORT_TARGET_ALIASES[base];
}

/**
 * Sniff the serialization language from the first non-blank characters of an emitted artifact: an
 * object/array opener (`{`/`[`) is JSON, an angle bracket (`<`) is XML, and a YAML document marker
 * (`---`, `%YAML`) or a top-level `key:` mapping line is YAML. Returns `undefined` when the sample is
 * empty or inconclusive, so the caller keeps the target's canonical default.
 */
function sniffSerialization(sample: string | null | undefined): string | undefined {
  if (!sample) return undefined;
  const trimmed = sample.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first === '{' || first === '[') return 'json';
  if (first === '<') return 'xml';
  if (trimmed.startsWith('---') || trimmed.startsWith('%YAML')) return 'yaml';
  // A top-level `key:` line (not a comment, not already handled) reads as YAML.
  if (/^[^\s:#][^:\n]*:(\s|$)/.test(trimmed)) return 'yaml';
  return undefined;
}

/**
 * Resolve the Monaco editor language for an emitted export artifact.
 *
 * @param targetFormat The emitter `format` or `key` (any version variant), or null/undefined.
 * @param sample An optional sample of the emitted bytes used to refine JSON-or-YAML targets and to
 *   type otherwise-unknown targets; omit it to get the target's canonical default.
 * @returns A Monaco language id (`json`, `yaml`, `xml`, `plaintext`), defaulting to `'plaintext'` for
 *   unrecognised targets when the sample is absent or inconclusive.
 */
export function monacoLanguageForExportTarget(
  targetFormat: string | null | undefined,
  sample?: string | null,
): string {
  const id = resolveExportTargetId(targetFormat);
  if (!id) {
    return sniffSerialization(sample) ?? 'plaintext';
  }
  const base = EXPORT_TARGET_LANGUAGE[id].language;
  if (SERIALIZED_TARGETS.has(id)) {
    const sniffed = sniffSerialization(sample);
    if (sniffed) return sniffed;
  }
  return base;
}

/** Everything {@link monacoLanguageForArtifact} can learn about an emitted artifact. */
export interface ArtifactLanguageHints {
  /** The emitter `format` or `key`, when known (e.g. `openapi-3.1`, `graphql`); null for a bare file. */
  targetFormat?: string | null;
  /** The artifact's media type — its `Content-Type` (e.g. `application/graphql`); '' or null when absent. */
  mediaType?: string | null;
  /** The artifact's filename, whose extension types formats the media type doesn't (e.g. `schema.proto`). */
  filename?: string | null;
  /** A sample of the emitted bytes, used to refine JSON-or-YAML-or-XML serializations. */
  sample?: string | null;
}

/**
 * Resolve the Monaco editor language for an emitted artifact, registry-driven.
 *
 * Unlike {@link monacoLanguageForExportTarget} (which keys off the emitter id alone), this lets the
 * artifact describe itself, so an emitter the UI has never heard of still highlights from its
 * descriptor's `mediaType`/extension with no code change here:
 *
 *  - a **known** emitter with a fixed serialization (protobuf, GraphQL, Avro) is authoritative — its
 *    canonical language wins;
 *  - a **known** emitter whose serialization varies (OpenAPI/Swagger/AsyncAPI: JSON *or* YAML *or*
 *    XML) is decided by the actual bytes, then the media type, then the filename, then its default;
 *  - an **unknown** emitter is typed by its media type, then filename extension, then a byte sniff;
 *  - anything still unrecognised degrades to `plaintext`, never throwing.
 *
 * @param hints What is known about the artifact (emitter id, media type, filename, byte sample).
 * @returns A Monaco language id (e.g. `protobuf`, `graphql`, `xml`, `json`, `yaml`, `sql`, `markdown`),
 *   defaulting to `'plaintext'`.
 */
export function monacoLanguageForArtifact({
  targetFormat,
  mediaType,
  filename,
  sample,
}: ArtifactLanguageHints): string {
  const id = resolveExportTargetId(targetFormat);
  if (id) {
    const base = EXPORT_TARGET_LANGUAGE[id].language;
    if (!SERIALIZED_TARGETS.has(id)) return base;
    // JSON-or-YAML-or-XML emitter: the bytes are truth, then the headers/filename, then the default.
    return (
      sniffSerialization(sample) ??
      languageForMediaType(mediaType) ??
      languageForExtension(filename) ??
      base
    );
  }
  // Unknown emitter: the descriptor's media type / extension decide, then a byte sniff, else plaintext.
  return (
    languageForMediaType(mediaType) ??
    languageForExtension(filename) ??
    sniffSerialization(sample) ??
    'plaintext'
  );
}

/**
 * Resolve the file extension (with leading dot) for an emitted export artifact.
 *
 * @param targetFormat The emitter `format` or `key` (any version variant), or null/undefined.
 * @param sample An optional sample of the emitted bytes used to refine the serialization.
 * @returns An extension like `.json` / `.yaml`; `.txt` for unrecognised targets.
 */
export function fileExtensionForExportTarget(
  targetFormat: string | null | undefined,
  sample?: string | null,
): string {
  const id = resolveExportTargetId(targetFormat);
  if (id && SERIALIZED_TARGETS.has(id)) {
    const language = monacoLanguageForExportTarget(targetFormat, sample);
    const sniffedExtension = LANGUAGE_EXTENSION[language];
    if (sniffedExtension) return sniffedExtension;
  }
  return id ? EXPORT_TARGET_LANGUAGE[id].extension : '.txt';
}

/**
 * Resolve a download filename for an emitted export artifact, e.g. `openapi` → `openapi.json`
 * (or `openapi.yaml` when the sample bytes are YAML).
 *
 * @param targetFormat The emitter `format` or `key` (any version variant), or null/undefined.
 * @param sample An optional sample of the emitted bytes used to refine the serialization.
 * @returns A filename with extension; `export.txt` for unrecognised targets.
 */
export function downloadFileNameForExportTarget(
  targetFormat: string | null | undefined,
  sample?: string | null,
): string {
  const id = resolveExportTargetId(targetFormat);
  const baseName = id ? EXPORT_TARGET_LANGUAGE[id].baseName : 'export';
  return `${baseName}${fileExtensionForExportTarget(targetFormat, sample)}`;
}
