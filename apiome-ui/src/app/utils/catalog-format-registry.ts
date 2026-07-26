/**
 * Catalog format / protocol / source-material registry (MFI-23.5, #4014).
 *
 * The headline metadata a catalog item carries off its latest imported revision (MFI-7.1/7.2) is
 * its **source format** (e.g. `openapi-3.1`, `grpc`, `graphql`), its **protocol / paradigm** (the
 * canonical `ApiParadigm`: REST / RPC / event / graph / data-schema / agent) and the **source
 * material** it came from (an uploaded file, a URL, pasted text, or a live discovery endpoint).
 *
 * This module is the single, data-driven lookup behind the catalog pills — modeled on
 * `project-domain-categories.ts`: a flat registry of entries plus pure resolver functions, so the
 * pill components (`FormatPill`, `ProtocolPill`, `SourceBadge`) stay presentational and the
 * format→icon/colour mapping can be unit-tested without rendering. Every resolver degrades
 * gracefully: an unknown-but-present format resolves to a neutral pill (never throws, never an empty
 * gap), and absent data resolves to `undefined` so a consumer can render nothing.
 *
 * No React here — only data + lucide icon references — so the registry is a plain importable map.
 */

import {
  FileJson,
  FileCode,
  Network,
  Share2,
  Radio,
  Database,
  Hammer,
  FileText,
  BookMarked,
  Binary,
  Braces,
  Cloud,
  Bot,
  Workflow,
  Upload,
  Link2,
  ClipboardPaste,
  Radar,
  HeartPulse,
  Landmark,
  CreditCard,
  Server,
  Zap,
  TrendingUp,
  Boxes,
  Box,
  type LucideIcon,
} from 'lucide-react';

/**
 * The fixed palette a pill can be tinted with. Centralising the colour here (rather than letting
 * each registry entry carry raw Tailwind literals) keeps the pills visually consistent and means a
 * new format only has to name a tone, not invent a colour. Each value is the full light+dark
 * `bg`/`text` class set for a pill.
 */
export type CatalogPillTone =
  | 'sky'
  | 'emerald'
  | 'violet'
  | 'pink'
  | 'orange'
  | 'slate'
  | 'amber'
  | 'red'
  | 'blue'
  | 'cyan'
  | 'indigo'
  | 'teal'
  | 'lime'
  | 'stone'
  | 'neutral';

/** Light+dark pill classes per tone. The neutral tone is the unknown-format fallback. */
export const CATALOG_PILL_TONE_CLASS: Readonly<Record<CatalogPillTone, string>> = {
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  slate: 'bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  cyan: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  lime: 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300',
  stone: 'bg-stone-100 text-stone-800 dark:bg-stone-800/60 dark:text-stone-300',
  neutral: 'bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-300',
};

/** Normalise a raw token to a comparison key: lower-case, alphanumerics only (drops version/spacing). */
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ==================== Formats ====================

/** A single registered import format (icon + tone + display label). */
export interface CatalogFormat {
  /** Canonical id (lower-case, alphanumeric) used as the registry key. */
  id: string;
  /** Human-friendly display label (e.g. `OpenAPI`, `gRPC`). */
  label: string;
  /** The lucide icon shown in the pill. */
  icon: LucideIcon;
  /** The pill tint. */
  tone: CatalogPillTone;
  /**
   * Extra normalised aliases that also resolve to this entry (the canonical `id` is always matched
   * without being repeated here). Versioned/spelled variants (e.g. `openapi30`, `protobuf`).
   */
  aliases?: readonly string[];
  /**
   * One-line description of the format, shown in the catalog's supported-formats gallery
   * (MFI-23.12). Optional so a bare pill entry can omit it.
   */
  description?: string;
  /**
   * `true` for the two *native* / publishable formats (OpenAPI, Swagger) that flow to **Projects**.
   * Every other entry is an **alternative** format that lands in the **Catalog** — see
   * {@link ALTERNATIVE_CATALOG_FORMATS}. Absent means alternative.
   */
  native?: boolean;
  /**
   * `true` when the format can actually be **imported into the catalog today** — i.e. a
 * server-registered import-source adapter can parse it, so the catalog store-raw flow (MFI-23.7)
 * can persist it *unconverted* and convert it later. In practice this is gRPC/Protobuf, GraphQL,
 * AsyncAPI, Thrift, Connect RPC, FlatBuffers, Cap'n Proto and WSDL (OpenAPI/Swagger are native → Projects).
   *
   * The remaining entries are **recognized but not yet importable** — the registry knows the format
   * (so a pill renders and the gallery can list it) but no adapter exists to bring it into the
   * catalog yet. Keeping them here, clearly flagged, is deliberate: the gallery shows what's
   * supported *now* separately from what's on the roadmap, instead of over-promising. Absent means
   * not importable.
   */
  importable?: boolean;
}

/**
 * The known import formats. Drawn from the formats the import adapters declare, the `ApiParadigm`
 * doc comments, and the sample specs shipped under `examples/` (MFI-23.12): the native REST formats
 * OpenAPI/Swagger flow to Projects, while every *alternative* format (gRPC, GraphQL, AsyncAPI,
 * Avro, Protobuf, FHIR, HL7 v2, EDI X12, ISO 20022/8583, FIX, Cap'n Proto, FlatBuffers, ASN.1,
 * COBOL copybooks, …) is catalogued. New formats append here; unknown formats fall back to a
 * neutral pill via {@link resolveCatalogFormat}.
 */
export const CATALOG_FORMATS: readonly CatalogFormat[] = [
  // ---- Native / publishable (Projects) ----
  { id: 'openapi', label: 'OpenAPI', icon: FileJson, tone: 'sky', native: true, importable: true, aliases: ['openapi30', 'openapi31', 'openapi32', 'oas', 'oas3'], description: 'OpenAPI 3.x REST API description.' },
  { id: 'swagger', label: 'Swagger', icon: FileJson, tone: 'teal', native: true, importable: true, aliases: ['swagger20', 'oas2'], description: 'Swagger 2.0 REST API description.' },

  // ---- RPC ----
  { id: 'grpc', label: 'gRPC', icon: Network, tone: 'emerald', importable: true, aliases: ['protobufservice'], description: 'gRPC service defined in Protocol Buffers.' },
  { id: 'protobuf', label: 'Protobuf', icon: Binary, tone: 'teal', importable: true, aliases: ['proto', 'proto3'], description: 'Protocol Buffers messages (.proto).' },
  { id: 'thrift', label: 'Thrift', icon: Network, tone: 'lime', importable: true, description: 'Apache Thrift IDL services & structs.' },
  { id: 'connectrpc', label: 'Connect', icon: Network, tone: 'emerald', importable: true, aliases: ['connect'], description: 'Connect RPC (Protobuf-based) services.' },
  { id: 'capnproto', label: "Cap'n Proto", icon: Zap, tone: 'lime', importable: true, aliases: ['capnp'], description: "Cap'n Proto schema & RPC interfaces." },
  { id: 'flatbuffers', label: 'FlatBuffers', icon: Boxes, tone: 'teal', importable: true, aliases: ['fbs'], description: 'FlatBuffers serialization schema (.fbs).' },
  { id: 'corbaidl', label: 'CORBA IDL', icon: Network, tone: 'red', importable: true, aliases: ['corba', 'idl'], description: 'CORBA interface definition language.' },
  { id: 'oncrpc', label: 'ONC RPC', icon: Network, tone: 'slate', importable: true, aliases: ['sunrpc', 'rpcgen', 'xdr'], description: 'ONC/Sun RPC (XDR) interface definition.' },
  { id: 'xmlrpc', label: 'XML-RPC', icon: FileCode, tone: 'stone', importable: true, aliases: ['xml-rpc'], description: 'XML-RPC method interface.' },
  { id: 'openrpc', label: 'OpenRPC', icon: Workflow, tone: 'blue', importable: true, aliases: ['jsonrpc'], description: 'OpenRPC JSON-RPC 2.0 service description.' },

  // ---- Graph ----
  { id: 'graphql', label: 'GraphQL', icon: Share2, tone: 'pink', importable: true, aliases: ['gql', 'sdl'], description: 'GraphQL schema (SDL) or introspection.' },

  // ---- Event ----
  { id: 'asyncapi', label: 'AsyncAPI', icon: Radio, tone: 'violet', importable: true, aliases: ['async'], description: 'Event-driven API (AsyncAPI 2.x/3.x).' },
  { id: 'cloudevents', label: 'CloudEvents', icon: Cloud, tone: 'sky', importable: true, aliases: ['cloud-events'], description: 'CloudEvents 1.0 structured-mode event envelope.' },

  // ---- REST (non-OpenAPI) ----
  { id: 'raml', label: 'RAML', icon: BookMarked, tone: 'red', importable: true, description: 'RAML 1.0 REST API definition.' },
  { id: 'postman', label: 'Postman', icon: FileJson, tone: 'orange', importable: true, aliases: ['postmancollection'], description: 'Postman v2.1 request collection.' },
  { id: 'http-file', label: 'HTTP Request File', icon: FileCode, tone: 'orange', importable: true, aliases: ['httpfile', 'http', 'rest', 'curl'], description: 'VS Code / JetBrains .http/.rest request file or cURL paste (inferred surface).' },
  { id: 'odata', label: 'OData', icon: Database, tone: 'orange', importable: true, aliases: ['edmx'], description: 'OData EDMX / CSDL service metadata.' },
  { id: 'wsdl', label: 'WSDL', icon: FileCode, tone: 'slate', importable: true, aliases: ['soap'], description: 'SOAP web service description (WSDL).' },
  { id: 'wadl', label: 'WADL', icon: FileCode, tone: 'slate', importable: true, aliases: ['restdescription'], description: 'WADL REST resource description.' },
  { id: 'discovery', label: 'Google Discovery', icon: Radar, tone: 'blue', importable: true, aliases: ['google-discovery', 'googlediscovery'], description: 'Google API Discovery rest description.' },
  { id: 'apiblueprint', label: 'API Blueprint', icon: FileText, tone: 'blue', importable: true, aliases: ['blueprint', 'apib'], description: 'API Blueprint 1A markdown API description.' },
  { id: 'smithy', label: 'Smithy', icon: Hammer, tone: 'amber', importable: true, description: 'Smithy 2.x service / protocol model.' },
  { id: 'typespec', label: 'TypeSpec', icon: FileCode, tone: 'cyan', importable: true, aliases: ['tsp', 'cadl'], description: 'Microsoft TypeSpec API definition.' },

  // ---- Workflows ----
  { id: 'arazzo', label: 'Arazzo', icon: Workflow, tone: 'violet', importable: true, aliases: ['workflows'], description: 'Arazzo API workflow description.' },

  // ---- Agent ----
  { id: 'llm-tools', label: 'LLM Tools', icon: Bot, tone: 'amber', importable: true, aliases: ['llmtools', 'function-calling', 'openai-tools', 'anthropic-tools'], description: 'OpenAI / Anthropic / bare LLM tool or function-calling schema bundle.' },

  // ---- Data schema ----
  { id: 'jsonschema', label: 'JSON Schema', icon: Braces, tone: 'indigo', importable: true, aliases: ['json'], description: 'JSON Schema type definitions.' },
  { id: 'k8s-crd', label: 'Kubernetes CRD', icon: Box, tone: 'blue', importable: true, aliases: ['kubernetes-crd', 'crd', 'k8scrd'], description: 'Kubernetes CustomResourceDefinition structural schema.' },
  { id: 'avro', label: 'Avro', icon: Binary, tone: 'cyan', importable: true, aliases: ['avsc'], description: 'Apache Avro record schema (.avsc).' },
  { id: 'jtd', label: 'JSON Type Definition', icon: Braces, tone: 'indigo', importable: true, aliases: ['jsontypedefinition', 'rfc8927'], description: 'JSON Type Definition (RFC 8927).' },
  { id: 'xsd', label: 'XSD', icon: FileCode, tone: 'stone', importable: true, aliases: ['xmlschema'], description: 'XML Schema Definition (XSD).' },
  { id: 'asn1', label: 'ASN.1', icon: Binary, tone: 'stone', importable: true, aliases: ['asn'], description: 'ASN.1 data structure definitions.' },
  { id: 'cobolcopybook', label: 'COBOL Copybook', icon: FileCode, tone: 'slate', importable: true, aliases: ['copybook', 'cobol', 'cobol-copybook'], description: 'COBOL copybook record layout.' },

  // ---- Healthcare ----
  { id: 'fhir', label: 'FHIR', icon: HeartPulse, tone: 'red', importable: true, aliases: ['fhirr4', 'structuredefinition'], description: 'HL7 FHIR healthcare resource definition.' },
  { id: 'hl7v2', label: 'HL7 v2', icon: HeartPulse, tone: 'pink', importable: true, aliases: ['hl7', 'hl7v2x'], description: 'HL7 v2.x healthcare messaging.' },

  // ---- Finance / B2B ----
  { id: 'edix12', label: 'EDI X12', icon: FileText, tone: 'orange', importable: true, aliases: ['x12', 'edi'], description: 'ANSI X12 EDI transaction sets.' },
  { id: 'iso20022', label: 'ISO 20022', icon: Landmark, tone: 'amber', importable: true, description: 'ISO 20022 financial messaging schema.' },
  { id: 'iso8583', label: 'ISO 8583', icon: CreditCard, tone: 'orange', importable: true, description: 'ISO 8583 card transaction messaging.' },
  { id: 'fix', label: 'FIX', icon: TrendingUp, tone: 'emerald', importable: true, aliases: ['fixprotocol'], description: 'FIX financial trading protocol.' },

  // ---- Mainframe ----
  { id: 'zosconnect', label: 'z/OS Connect', icon: Server, tone: 'blue', importable: true, aliases: ['zos', 'zos-connect'], description: 'z/OS Connect mainframe API.' },
] as const;

/** Ids of the *native* / publishable formats (OpenAPI, Swagger) that route to Projects, not the Catalog. */
export const NATIVE_FORMAT_IDS: ReadonlySet<string> = new Set(
  CATALOG_FORMATS.filter((f) => f.native).map((f) => f.id),
);

/**
 * The *alternative* import formats — every registered format except the native OpenAPI/Swagger pair.
 * These are the formats surfaced by the catalog's supported-formats gallery and its import flow
 * (MFI-23.12); an item imported in any of them lands in the Catalog rather than Projects.
 */
export const ALTERNATIVE_CATALOG_FORMATS: readonly CatalogFormat[] = CATALOG_FORMATS.filter(
  (f) => !f.native,
);

/**
 * The alternative formats that can be **imported into the catalog today** — the ones a
 * server-registered adapter can parse, so the store-raw flow persists them unconverted: gRPC,
 * Protobuf, GraphQL, AsyncAPI, Thrift, Connect RPC, FlatBuffers, Cap'n Proto, WSDL, ASN.1, EDI X12, ONC RPC, CORBA IDL, OData, and FHIR. The catalog gallery lists these as available now.
 */
export const IMPORTABLE_ALTERNATIVE_FORMATS: readonly CatalogFormat[] =
  ALTERNATIVE_CATALOG_FORMATS.filter((f) => f.importable);

/**
 * The alternative formats the registry *recognizes* (so a pill renders and detection can name them)
 * but which have **no catalog importer yet** — HL7 v2, ISO 20022/8583, FIX, and the rest. Listed separately in the gallery as "not yet
 * importable" so support is never over-stated.
 */
export const RECOGNIZED_ALTERNATIVE_FORMATS: readonly CatalogFormat[] =
  ALTERNATIVE_CATALOG_FORMATS.filter((f) => !f.importable);

/** Build the alias→entry lookup once (canonical id plus every declared alias). */
const FORMAT_BY_KEY: ReadonlyMap<string, CatalogFormat> = (() => {
  const map = new Map<string, CatalogFormat>();
  for (const fmt of CATALOG_FORMATS) {
    map.set(fmt.id, fmt);
    for (const alias of fmt.aliases ?? []) map.set(normalizeToken(alias), fmt);
  }
  return map;
})();

/**
 * Resolve a raw `sourceFormat` string to a registered {@link CatalogFormat}.
 *
 * Matching is version-insensitive: `openapi-3.1`, `OpenAPI 3.0` and `openapi` all resolve to the
 * OpenAPI entry. The raw token is also tried with a trailing version segment stripped (so
 * `swagger-2.0` → `swagger`).
 *
 * @param format The raw format string off the item, or null/undefined.
 * @returns The matching registry entry, or `undefined` when the format is empty or unrecognised
 *   (callers render a neutral pill for the unrecognised-but-present case).
 */
export function resolveCatalogFormat(format: string | null | undefined): CatalogFormat | undefined {
  if (!format || !format.trim()) return undefined;
  const key = normalizeToken(format);
  if (FORMAT_BY_KEY.has(key)) return FORMAT_BY_KEY.get(key);
  // Try the leading non-numeric portion, so `openapi30` / `swagger20` match `openapi` / `swagger`.
  const leading = key.replace(/[0-9].*$/, '');
  if (leading && leading !== key && FORMAT_BY_KEY.has(leading)) return FORMAT_BY_KEY.get(leading);
  return undefined;
}

/** gRPC and Protobuf share one import adapter and land as ``sourceFormat: protobuf`` in the catalog. */
const PROTOBUF_FORMAT_FAMILY_ID = 'protobuf';

/**
 * Collapse near-duplicate format ids to a single catalog filter/stats family.
 *
 * gRPC imports persist ``protobuf`` as the canonical format while the registry also exposes a
 * separate ``grpc`` entry — without this, format filtering and search for "gRPC" miss protobuf
 * catalog items.
 */
export function catalogFormatFamilyId(format: string | null | undefined): string | undefined {
  const resolved = resolveCatalogFormat(format);
  if (!resolved) return undefined;
  if (resolved.id === 'grpc' || resolved.id === 'protobuf') return PROTOBUF_FORMAT_FAMILY_ID;
  return resolved.id;
}

/** Human label for a {@link catalogFormatFamilyId} value (used by the format facet). */
export function catalogFormatFamilyLabel(familyId: string): string {
  if (familyId === PROTOBUF_FORMAT_FAMILY_ID) return 'gRPC / Protobuf';
  return resolveCatalogFormat(familyId)?.label ?? familyId;
}

/** Search tokens that should match a catalog format family (labels + common aliases). */
export function catalogFormatSearchTokens(format: string | null | undefined): string[] {
  const resolved = resolveCatalogFormat(format);
  if (!resolved) return [];
  const familyId = catalogFormatFamilyId(format) ?? resolved.id;
  const tokens = new Set<string>([
    resolved.id,
    resolved.label.toLowerCase(),
    catalogFormatFamilyLabel(familyId).toLowerCase(),
  ]);
  if (familyId === PROTOBUF_FORMAT_FAMILY_ID) {
    tokens.add('grpc');
    tokens.add('protobuf');
    tokens.add('proto');
  }
  for (const alias of resolved.aliases ?? []) tokens.add(alias.toLowerCase());
  return [...tokens];
}

// ==================== Protocols (paradigms) ====================

/** A single API paradigm / protocol family (the canonical `ApiParadigm`, plus `agent`). */
export interface CatalogProtocol {
  /** Canonical id (lower-case, alphanumeric). */
  id: string;
  /** Display label (e.g. `REST`, `Data Schema`). */
  label: string;
  /** The lucide icon shown in the pill. */
  icon: LucideIcon;
  /** The pill tint. */
  tone: CatalogPillTone;
  /** Extra normalised aliases that resolve here (the canonical id is always matched). */
  aliases?: readonly string[];
}

/**
 * The protocols a catalog item can declare — the canonical `ApiParadigm` (REST / RPC / event /
 * graph / data-schema) plus `agent` (MCP-style agent surfaces). Unknown protocols degrade to a
 * neutral pill via {@link resolveCatalogProtocol}.
 */
export const CATALOG_PROTOCOLS: readonly CatalogProtocol[] = [
  { id: 'rest', label: 'REST', icon: Network, tone: 'indigo' },
  { id: 'rpc', label: 'RPC', icon: Workflow, tone: 'emerald' },
  { id: 'event', label: 'Event', icon: Radio, tone: 'violet', aliases: ['events', 'messaging'] },
  { id: 'graph', label: 'Graph', icon: Share2, tone: 'pink', aliases: ['graphql'] },
  { id: 'dataschema', label: 'Data Schema', icon: Braces, tone: 'cyan', aliases: ['dataschemas', 'schema', 'data'] },
  { id: 'agent', label: 'Agent', icon: Bot, tone: 'amber', aliases: ['mcp', 'agentic'] },
] as const;

/** Build the alias→entry lookup once (canonical id plus every declared alias). */
const PROTOCOL_BY_KEY: ReadonlyMap<string, CatalogProtocol> = (() => {
  const map = new Map<string, CatalogProtocol>();
  for (const proto of CATALOG_PROTOCOLS) {
    map.set(proto.id, proto);
    for (const alias of proto.aliases ?? []) map.set(normalizeToken(alias), proto);
  }
  return map;
})();

/**
 * Resolve a raw `protocol` / paradigm string to a registered {@link CatalogProtocol}.
 *
 * Matching is punctuation-insensitive, so `data_schema`, `data-schema` and `dataschema` all resolve
 * to the Data Schema entry.
 *
 * @param protocol The raw protocol string off the item, or null/undefined.
 * @returns The matching registry entry, or `undefined` when empty or unrecognised.
 */
export function resolveCatalogProtocol(protocol: string | null | undefined): CatalogProtocol | undefined {
  if (!protocol || !protocol.trim()) return undefined;
  return PROTOCOL_BY_KEY.get(normalizeToken(protocol));
}

// ==================== Source material ====================

/** The input kind a catalog item was imported from (mirrors the REST `InputKind` enum). */
export type CatalogSourceKind = 'file' | 'url' | 'paste' | 'discovery';

/** Display metadata for a source kind: a fallback label and the icon for its input kind. */
export interface CatalogSourceKindMeta {
  kind: CatalogSourceKind;
  /** Label used when the item carries no specific source label. */
  fallbackLabel: string;
  icon: LucideIcon;
}

/** Per-kind icon + fallback label. The discovery kind is the live-introspection case. */
export const CATALOG_SOURCE_KIND_META: Readonly<Record<CatalogSourceKind, CatalogSourceKindMeta>> = {
  file: { kind: 'file', fallbackLabel: 'Uploaded file', icon: Upload },
  url: { kind: 'url', fallbackLabel: 'Source URL', icon: Link2 },
  paste: { kind: 'paste', fallbackLabel: 'Pasted content', icon: ClipboardPaste },
  discovery: { kind: 'discovery', fallbackLabel: 'Live discovery', icon: Radar },
};

/** A resolved source-material descriptor: an input kind and a human label to show on the badge. */
export interface CatalogSource {
  kind: CatalogSourceKind;
  /** The label to display (file name / URL host / "Live discovery"). */
  label: string;
  /** The full, untruncated source value (file name or URL) for a tooltip; may equal `label`. */
  title: string;
}

/** Normalise a raw input-kind token to a {@link CatalogSourceKind}, or undefined when unknown. */
function normalizeSourceKind(value: string | null | undefined): CatalogSourceKind | undefined {
  if (!value) return undefined;
  const key = normalizeToken(value);
  if (key === 'file' || key === 'upload') return 'file';
  if (key === 'url' || key === 'uri' || key === 'link') return 'url';
  if (key === 'paste' || key === 'clipboard' || key === 'pasted' || key === 'inline') return 'paste';
  if (key === 'discovery' || key === 'livediscovery' || key === 'live' || key === 'endpoint') return 'discovery';
  return undefined;
}

/** Reduce a URL to a compact host (+path head) label; returns the raw string if it does not parse. */
function compactUrlLabel(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '');
  } catch {
    return raw;
  }
}

/** The candidate keys, in priority order, that may carry the source label across metadata shapes. */
const SOURCE_LABEL_KEYS = ['sourceLabel', 'source_label', 'sourceUri', 'source_uri', 'sourceUrl', 'source_url', 'fileName', 'file_name', 'filename'] as const;
/** The candidate keys, in priority order, that may carry the input kind across metadata shapes. */
const SOURCE_KIND_KEYS = ['inputKind', 'input_kind', 'sourceKind', 'source_kind'] as const;

/** Read the first present, non-empty string value among `keys` from a loose metadata bag. */
function firstString(bag: Record<string, unknown> | null | undefined, keys: readonly string[]): string | undefined {
  if (!bag) return undefined;
  for (const k of keys) {
    const v = bag[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Derive the source-material descriptor for a catalog item from its loose metadata bags.
 *
 * The import path records source provenance onto the item's `formatMetadata` (preferred) or generic
 * `metadata` (MFI-7.x). This reads the kind (`inputKind`/`input_kind`/…) and a label
 * (`sourceLabel`/`sourceUri`/`fileName`/…) from either bag — tolerating both camelCase and
 * snake_case — and produces a compact, display-ready {@link CatalogSource}. When no kind is
 * recorded it is inferred from the label (a parseable `http(s)` URL → `url`, otherwise `file`).
 *
 * @param formatMetadata The item's `formatMetadata` bag (preferred source of provenance).
 * @param metadata The item's generic `metadata` bag (fallback).
 * @returns The resolved source, or `undefined` when no source material is recorded (badge hidden).
 */
export function resolveCatalogSource(
  formatMetadata: Record<string, unknown> | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): CatalogSource | undefined {
  const rawLabel = firstString(formatMetadata, SOURCE_LABEL_KEYS) ?? firstString(metadata, SOURCE_LABEL_KEYS);
  const rawKind = firstString(formatMetadata, SOURCE_KIND_KEYS) ?? firstString(metadata, SOURCE_KIND_KEYS);

  let kind = normalizeSourceKind(rawKind);

  // Infer the kind from the label when none was recorded.
  if (!kind) {
    if (!rawLabel) return undefined;
    kind = /^https?:\/\//i.test(rawLabel) ? 'url' : 'file';
  }

  // Discovery without a label still renders (it is meaningful on its own).
  if (!rawLabel) {
    if (kind === 'discovery') {
      const meta = CATALOG_SOURCE_KIND_META[kind];
      return { kind, label: meta.fallbackLabel, title: meta.fallbackLabel };
    }
    return undefined;
  }

  const label = kind === 'url' ? compactUrlLabel(rawLabel) : rawLabel;
  return { kind, label, title: rawLabel };
}
