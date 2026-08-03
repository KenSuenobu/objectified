/**
 * Protocol / format browse facets (MFI-6.1, #3753).
 *
 * The directory now spans many API description formats, so browsing has to be narrowable by
 * **protocol** — the canonical paradigm an artifact was imported as (REST, RPC, event-driven,
 * graph, data schema, agent) — and by **specific format** (`openapi-3.1`, `protobuf`, `graphql`, …).
 * Both values are recorded per published revision by the import pipeline (MFI-7.1) and rolled up
 * per project / organization by the queries in `lib/db/helper.ts`.
 *
 * This module is the framework-free half of that feature: the vocabulary, the label lookup, the
 * facet-count roll-up and the filter predicate. Keeping it free of React and of `pg` means the
 * behaviour is unit-testable (`lib/__tests__/browseFacets.test.ts`) and the chip components stay
 * purely presentational. It intentionally mirrors `app/browse_facets.py` in apiome-rest so the
 * public API and this app describe the same facet with the same words.
 */

/** One selectable value on a facet axis, with how many entries carry it. */
export interface BrowseFacetOption {
  /** The stored value, used as the filter token (e.g. `data_schema`, `openapi-3.1`). */
  value: string;
  /** Display label (e.g. `Data schema`, `OpenAPI 3.1`). */
  label: string;
  /** How many entries in the current scope carry this value. */
  count: number;
}

/** The currently selected facet values; `null` on an axis means "any". */
export interface BrowseFacetSelection {
  protocol: string | null;
  format: string | null;
}

/** Anything the facets can be computed over — a project or organization row. */
export interface FacetedEntity {
  /** Distinct protocols across the entry's listed versions. */
  protocols?: string[] | null;
  /** Distinct source formats across the entry's listed versions. */
  formats?: string[] | null;
}

/** The two facet axes. */
export type BrowseFacetAxis = 'protocol' | 'format';

/** The empty selection — nothing narrowed. */
export const NO_FACET_SELECTION: BrowseFacetSelection = { protocol: null, format: null };

/**
 * The canonical paradigms, in presentation order. This is the same vocabulary the import adapters
 * declare (`ApiParadigm` in apiome-rest), so a facet can never offer a protocol no import produces.
 */
export const BROWSE_PROTOCOLS: readonly { id: string; label: string }[] = [
  { id: 'rest', label: 'REST' },
  { id: 'rpc', label: 'RPC' },
  { id: 'event', label: 'Event-driven' },
  { id: 'graph', label: 'Graph' },
  { id: 'data_schema', label: 'Data schema' },
  { id: 'agent', label: 'Agent' },
] as const;

const PROTOCOL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  BROWSE_PROTOCOLS.map((p) => [p.id, p.label])
);

const PROTOCOL_ORDER: Readonly<Record<string, number>> = Object.fromEntries(
  BROWSE_PROTOCOLS.map((p, index) => [p.id, index])
);

/**
 * Display labels for the format keys the import adapters emit, keyed by the key with any trailing
 * version segment removed (`openapi-3.1` → `openapi`). A key the table does not know still renders
 * — as itself — so a newly added adapter never leaves a blank chip.
 */
const FORMAT_LABELS: Readonly<Record<string, string>> = {
  openapi: 'OpenAPI',
  swagger: 'Swagger',
  arazzo: 'Arazzo',
  asyncapi: 'AsyncAPI',
  cloudevents: 'CloudEvents',
  graphql: 'GraphQL',
  protobuf: 'gRPC / Protobuf',
  grpc: 'gRPC / Protobuf',
  connectrpc: 'Connect RPC',
  thrift: 'Thrift',
  capnproto: "Cap'n Proto",
  flatbuffers: 'FlatBuffers',
  corbaidl: 'CORBA IDL',
  oncrpc: 'ONC RPC',
  xmlrpc: 'XML-RPC',
  openrpc: 'OpenRPC',
  smithy: 'Smithy',
  typespec: 'TypeSpec',
  raml: 'RAML',
  postman: 'Postman',
  'http-file': 'HTTP Request File',
  kong: 'Kong Declarative Config',
  'gateway-api': 'Gateway API HTTPRoute',
  odata: 'OData',
  wsdl: 'WSDL',
  wadl: 'WADL',
  discovery: 'Google Discovery',
  apiblueprint: 'API Blueprint',
  zosconnect: 'z/OS Connect',
  'json-schema': 'JSON Schema',
  jtd: 'JSON Type Definition',
  'k8s-crd': 'Kubernetes CRD',
  avro: 'Avro',
  xsd: 'XSD',
  asn1: 'ASN.1',
  cobolcopybook: 'COBOL Copybook',
  fhir: 'FHIR',
  hl7v2: 'HL7 v2',
  edix12: 'EDI X12',
  iso20022: 'ISO 20022',
  iso8583: 'ISO 8583',
  fix: 'FIX',
  'llm-tools': 'LLM Tools',
};

/**
 * Splits a versioned format key into base + version (`openapi-3.1` → `openapi` / `3.1`). The
 * version may be multi-part (`json-schema-2020-12`) and must be separated from the base, so keys
 * that merely end in digits (`iso20022`, `hl7v2`, `asn1`) are left whole.
 */
const VERSIONED_FORMAT_RE = /^(.+?)[-_.](\d+(?:[.-]\d+)*)$/;

/**
 * Normalize a raw facet value to the stored form: trimmed and lower-cased.
 *
 * @param value A value from a row, a URL query, or a chip click.
 * @returns The normalized value, or `null` when it is absent or blank.
 */
export function normalizeFacetValue(value: string | null | undefined): string | null {
  const token = (value ?? '').trim().toLowerCase();
  return token ? token : null;
}

/**
 * Display label for a protocol value.
 *
 * @param value The stored protocol (e.g. `data_schema`).
 * @returns The label, falling back to the raw value for anything outside the canonical vocabulary.
 */
export function protocolLabel(value: string): string {
  const key = normalizeFacetValue(value);
  if (!key) return '';
  return PROTOCOL_LABELS[key] ?? value.trim();
}

/**
 * Display label for a source-format key (`openapi-3.1` → `OpenAPI 3.1`).
 *
 * A versioned key is labelled from its family name plus the version, so `openapi-3.0` and
 * `openapi-3.1` stay distinguishable as chips instead of collapsing to one word.
 *
 * @param formatKey The stored format key.
 * @returns The label; never empty for a non-empty key.
 */
export function formatLabel(formatKey: string): string {
  const key = normalizeFacetValue(formatKey);
  if (!key) return '';
  const direct = FORMAT_LABELS[key];
  if (direct) return direct;
  const match = VERSIONED_FORMAT_RE.exec(key);
  if (match) {
    const family = FORMAT_LABELS[match[1]];
    if (family) return `${family} ${match[2]}`;
  }
  return formatKey.trim();
}

/**
 * Display label for a value on either axis.
 *
 * @param axis Which facet the value belongs to.
 * @param value The stored value.
 * @returns The label for that axis.
 */
export function facetLabel(axis: BrowseFacetAxis, value: string): string {
  return axis === 'protocol' ? protocolLabel(value) : formatLabel(value);
}

/** The values an entry carries on one axis, normalized and de-duplicated. */
function entityValues(entity: FacetedEntity, axis: BrowseFacetAxis): string[] {
  const raw = axis === 'protocol' ? entity.protocols : entity.formats;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    const token = normalizeFacetValue(typeof value === 'string' ? value : String(value ?? ''));
    if (token) seen.add(token);
  }
  return [...seen];
}

/**
 * Roll entries up into the chip row for one axis.
 *
 * An entry counts once per distinct value it carries, so a project published in both OpenAPI and
 * gRPC appears under both chips. Counts deliberately ignore the current facet selection — the row
 * answers "what else could I pick", which is what makes a facet navigable — matching the
 * `facets` block the `/v1/browse/*` API returns.
 *
 * @param entities The entries in scope (already narrowed by any text search).
 * @param axis Which axis to count.
 * @returns Options ordered as the API orders them: protocols in canonical order, formats by
 *   descending count with ties broken by value.
 */
export function computeFacetOptions(
  entities: readonly FacetedEntity[],
  axis: BrowseFacetAxis
): BrowseFacetOption[] {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    for (const value of entityValues(entity, axis)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const options = [...counts.entries()].map(([value, count]) => ({
    value,
    label: facetLabel(axis, value),
    count,
  }));

  if (axis === 'protocol') {
    const rank = (value: string) => PROTOCOL_ORDER[value] ?? BROWSE_PROTOCOLS.length;
    return options.sort(
      (a, b) => rank(a.value) - rank(b.value) || a.value.localeCompare(b.value)
    );
  }
  return options.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Keep only the entries matching the selection.
 *
 * The two axes compose with AND, and each is satisfied when the entry carries the value on *any*
 * of its versions — the same "at least one version" rule the API's SQL filter uses.
 *
 * @param entities The entries in scope.
 * @param selection The selected protocol/format, either of which may be null for "any".
 * @returns The matching entries, in their original order.
 */
export function filterByFacets<T extends FacetedEntity>(
  entities: readonly T[],
  selection: BrowseFacetSelection
): T[] {
  const protocol = normalizeFacetValue(selection.protocol);
  const format = normalizeFacetValue(selection.format);
  if (!protocol && !format) return [...entities];
  return entities.filter((entity) => {
    if (protocol && !entityValues(entity, 'protocol').includes(protocol)) return false;
    if (format && !entityValues(entity, 'format').includes(format)) return false;
    return true;
  });
}

/**
 * Toggle a chip: selecting the active value clears the axis, anything else replaces it.
 *
 * @param selection The current selection.
 * @param axis The axis whose chip was clicked.
 * @param value The clicked value, or null to clear the axis.
 * @returns The next selection (a new object; the input is not mutated).
 */
export function toggleFacet(
  selection: BrowseFacetSelection,
  axis: BrowseFacetAxis,
  value: string | null
): BrowseFacetSelection {
  const next = normalizeFacetValue(value);
  const current = normalizeFacetValue(axis === 'protocol' ? selection.protocol : selection.format);
  const resolved = next && next === current ? null : next;
  return axis === 'protocol'
    ? { ...selection, protocol: resolved }
    : { ...selection, format: resolved };
}

/**
 * Whether anything is selected — the "Clear filters" affordance hangs off this.
 *
 * @param selection The current selection.
 * @returns True when at least one axis is narrowed.
 */
export function hasFacetSelection(selection: BrowseFacetSelection): boolean {
  return Boolean(normalizeFacetValue(selection.protocol) || normalizeFacetValue(selection.format));
}

/**
 * A short human summary of the active selection, for empty-state copy.
 *
 * @param selection The current selection.
 * @returns Something like `REST · OpenAPI 3.1`, or an empty string when nothing is selected.
 */
export function describeFacetSelection(selection: BrowseFacetSelection): string {
  const parts: string[] = [];
  const protocol = normalizeFacetValue(selection.protocol);
  const format = normalizeFacetValue(selection.format);
  if (protocol) parts.push(protocolLabel(protocol));
  if (format) parts.push(formatLabel(format));
  return parts.join(' · ');
}
