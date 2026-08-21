/**
 * Registry-derived format counts (FMT-1.6, #5417).
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: cd apiome-rest && uv run python scripts/generate_format_counts.py
 *
 * Every count is measured from the import-source, emitter and capability registries by
 * `app.format_counts`, the same traversal behind `GET /v1/formats/matrix` and the
 * generated `docs/guide/supported-formats.md` page. Copy that states a format count
 * interpolates these constants so the number is resolved at build time and cannot go
 * stale; a hand-typed count in guarded copy fails `tests/test_format_counts.py`.
 *
 * The counts are deployment-independent: a format whose toolchain is missing from a
 * particular deployment is still a format Apiome supports, and is still counted here.
 */

/** One canonical paradigm and how many formats belong to it. */
export interface FormatParadigmCount {
  /** The stored paradigm value, e.g. `data_schema`. */
  readonly id: string;
  /** Display label, e.g. `Data schema`. */
  readonly label: string;
  /** Formats in this paradigm. */
  readonly total: number;
  /** Formats in this paradigm Apiome can read. */
  readonly importable: number;
  /** Formats in this paradigm Apiome can write. */
  readonly exportable: number;
}

/** The measured format surface. Field meanings match `FormatCounts` in apiome-rest. */
export interface FormatCounts {
  /** Contract version of this payload. */
  readonly version: string;
  /** Capability-registry version behind the matrix these counts were projected from. */
  readonly capabilityRegistryVersion: string;
  /** Formats Apiome reads or writes. */
  readonly total: number;
  /** Formats Apiome can read. */
  readonly importable: number;
  /** Formats Apiome can write. */
  readonly exportable: number;
  /** Formats Apiome can both read and write. */
  readonly roundTrip: number;
  /** Formats Apiome can read but not write. */
  readonly importOnly: number;
  /** Formats Apiome can write but not read. */
  readonly exportOnly: number;
  /** Formats whose adapter can introspect a live endpoint rather than read a file. */
  readonly liveDiscovery: number;
  /** Formats whose import mints a publishable Project. */
  readonly publishable: number;
  /** Formats whose import mints a catalog item. */
  readonly catalog: number;
  /** Formats that hard-require at least one external tool. */
  readonly toolchainGated: number;
  /** Per-paradigm breakdown, in canonical paradigm order. */
  readonly paradigms: readonly FormatParadigmCount[];
}

/**
 * The measured counts. Import this rather than writing a number into copy.
 */
export const FORMAT_COUNTS: FormatCounts = {
  version: '1',
  capabilityRegistryVersion: '3',
  total: 43,
  importable: 43,
  exportable: 39,
  roundTrip: 39,
  importOnly: 4,
  exportOnly: 0,
  liveDiscovery: 4,
  publishable: 1,
  catalog: 42,
  toolchainGated: 3,
  paradigms: [
    { id: 'rest', label: 'REST', total: 15, importable: 15, exportable: 14 },
    { id: 'rpc', label: 'RPC', total: 10, importable: 10, exportable: 9 },
    { id: 'event', label: 'Event-driven', total: 2, importable: 2, exportable: 2 },
    { id: 'graph', label: 'Graph', total: 1, importable: 1, exportable: 1 },
    { id: 'data_schema', label: 'Data schema', total: 13, importable: 13, exportable: 13 },
    { id: 'agent', label: 'Agent', total: 2, importable: 2, exportable: 0 },
  ],
};

/**
 * The canonical paradigm vocabulary, in canonical order — the values
 * `ApiParadigm` declares in apiome-rest. A facet built from this list can never
 * offer a paradigm no import produces, and gains a new one the moment the registry
 * does.
 */
export const FORMAT_PARADIGMS: readonly FormatParadigmCount[] = FORMAT_COUNTS.paradigms;
