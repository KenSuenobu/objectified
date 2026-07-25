/**
 * Typed loader for the import example corpus manifest — IXH-1.1 (#5087).
 *
 * `apiome-ui/examples/` is the de facto import test corpus, and
 * `examples/corpus.manifest.json` is its machine-readable contract: one entry
 * per corpus file declaring what the file demonstrates, whether it is valid,
 * which adapter must claim it, and what detection/import outcome it is
 * expected to produce (published JSON Schema: `examples/corpus.schema.json`;
 * Python twin: `apiome-rest/tests/corpus_loader.py`).
 *
 * Tests select fixtures by tag, not by path:
 *
 * ```ts
 * import { loadCorpus, readCorpusFile } from '@lib/corpus/corpus';
 *
 * const [weather] = loadCorpus({ format: 'smithy' });
 * const text = readCorpusFile(weather);
 * ```
 *
 * Node-only (uses `fs`): intended for Jest tests and scripts, not for the
 * browser bundle.
 */

import * as fs from 'fs';
import * as path from 'path';

/** What kind of input a corpus file is, and therefore what it proves. */
export type ValidityClass = 'valid' | 'invalid' | 'adversarial' | 'scale';

/** What a full import of the file must do. */
export type ExpectedOutcome = 'imports' | 'rejects' | 'imports_with_warnings';

/** README grouping section for a corpus directory. */
export type CorpusCategory =
  | 'rest-http'
  | 'rpc'
  | 'event-messaging'
  | 'graph'
  | 'data-schema'
  | 'industry-messaging';

/**
 * The detection contract for one corpus file: format detection must report
 * `format` with at least `min_confidence` among its candidates
 * (`min_confidence` 0 means no detection guarantee).
 */
export interface ExpectedDetection {
  format: string;
  min_confidence: number;
}

/** One corpus file's manifest entry (see `examples/corpus.schema.json`). */
export interface CorpusEntry {
  /** File path relative to `apiome-ui/examples/`, POSIX separators. */
  path: string;
  /** Format family key — the `loadCorpus({ format })` selection key. */
  format: string;
  /** ImportSource registry key that must claim the file, or null. */
  adapter_key: string | null;
  validity_class: ValidityClass;
  expected_detection: ExpectedDetection;
  /** Tags for what the file demonstrates (e.g. `oneOf`, `occurs-depending-on`). */
  features: string[];
  expected_outcome: ExpectedOutcome;
  source: string;
  license: string;
  provenance: string;
  notes?: string;
}

/** Per-directory human-index metadata used to regenerate the README. */
export interface CorpusDirectoryMeta {
  label: string;
  category: CorpusCategory;
  paradigm: string;
  marker: string;
}

/** The parsed, validated corpus manifest. */
export interface CorpusManifest {
  $schema?: string;
  manifest_version: 1;
  directories: Record<string, CorpusDirectoryMeta>;
  entries: CorpusEntry[];
}

/** Filters for {@link loadCorpus}; all given filters must match (AND). */
export interface CorpusFilter {
  /** Format family key to match (e.g. `openapi`, `avro`). */
  format?: string;
  /** Validity class to match. */
  validityClass?: ValidityClass;
  /** Feature tag the entry must carry (exact match). */
  feature?: string;
  /** ImportSource registry key the entry must map to. */
  adapterKey?: string;
}

const VALIDITY_CLASSES: ReadonlySet<string> = new Set([
  'valid',
  'invalid',
  'adversarial',
  'scale',
]);
const EXPECTED_OUTCOMES: ReadonlySet<string> = new Set([
  'imports',
  'rejects',
  'imports_with_warnings',
]);

/**
 * Files under the corpus root that are corpus infrastructure, not fixtures —
 * excluded from {@link listCorpusFiles} and never listed in the manifest.
 */
export const NON_CORPUS_FILENAMES: ReadonlySet<string> = new Set([
  'README.md',
  'corpus.manifest.json',
  'corpus.schema.json',
]);

/** Absolute path of the corpus root (`apiome-ui/examples/`). */
export function corpusRoot(): string {
  return path.resolve(__dirname, '..', '..', 'examples');
}

/** Absolute path of `corpus.manifest.json`. */
export function manifestPath(): string {
  return path.join(corpusRoot(), 'corpus.manifest.json');
}

function fail(context: string, message: string): never {
  throw new Error(`corpus.manifest.json: ${context}: ${message}`);
}

function assertEntry(value: unknown, index: number): CorpusEntry {
  const context = `entries[${index}]`;
  if (typeof value !== 'object' || value === null) fail(context, 'not an object');
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== 'string' || !entry.path) fail(context, 'missing path');
  if (typeof entry.format !== 'string' || !entry.format) fail(context, 'missing format');
  if (entry.adapter_key !== null && typeof entry.adapter_key !== 'string') {
    fail(context, 'adapter_key must be a string or null');
  }
  if (!VALIDITY_CLASSES.has(entry.validity_class as string)) {
    fail(context, `invalid validity_class ${JSON.stringify(entry.validity_class)}`);
  }
  const detection = entry.expected_detection as Record<string, unknown> | undefined;
  if (
    typeof detection !== 'object' ||
    detection === null ||
    typeof detection.format !== 'string' ||
    typeof detection.min_confidence !== 'number' ||
    detection.min_confidence < 0 ||
    detection.min_confidence > 1
  ) {
    fail(context, 'invalid expected_detection');
  }
  if (
    !Array.isArray(entry.features) ||
    entry.features.length === 0 ||
    entry.features.some((feature) => typeof feature !== 'string' || !feature)
  ) {
    fail(context, 'features must be a non-empty string array');
  }
  if (!EXPECTED_OUTCOMES.has(entry.expected_outcome as string)) {
    fail(context, `invalid expected_outcome ${JSON.stringify(entry.expected_outcome)}`);
  }
  for (const field of ['source', 'license', 'provenance'] as const) {
    if (typeof entry[field] !== 'string' || !entry[field]) fail(context, `missing ${field}`);
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    fail(context, 'notes must be a string when present');
  }
  return value as CorpusEntry;
}

function assertManifest(value: unknown): CorpusManifest {
  if (typeof value !== 'object' || value === null) fail('<root>', 'not an object');
  const manifest = value as Record<string, unknown>;
  if (manifest.manifest_version !== 1) {
    fail('<root>', `unsupported manifest_version ${JSON.stringify(manifest.manifest_version)}`);
  }
  if (typeof manifest.directories !== 'object' || manifest.directories === null) {
    fail('<root>', 'missing directories map');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail('<root>', 'missing entries array');
  }
  manifest.entries.forEach(assertEntry);
  return value as CorpusManifest;
}

let cachedManifest: CorpusManifest | null = null;

/**
 * Load and validate the corpus manifest (cached per process).
 *
 * @returns The validated manifest.
 * @throws If the manifest is missing or fails the shape checks.
 */
export function loadManifest(): CorpusManifest {
  if (cachedManifest === null) {
    const raw = fs.readFileSync(manifestPath(), 'utf-8');
    cachedManifest = assertManifest(JSON.parse(raw));
  }
  return cachedManifest;
}

/**
 * Return the corpus entries matching every given filter (AND semantics).
 *
 * @param filter - Optional format / validity class / feature / adapter-key
 *   filters; with no filters the full corpus is returned.
 * @returns Matching entries in manifest (path-sorted) order.
 */
export function loadCorpus(filter: CorpusFilter = {}): CorpusEntry[] {
  const { format, validityClass, feature, adapterKey } = filter;
  return loadManifest().entries.filter(
    (entry) =>
      (format === undefined || entry.format === format) &&
      (validityClass === undefined || entry.validity_class === validityClass) &&
      (feature === undefined || entry.features.includes(feature)) &&
      (adapterKey === undefined || entry.adapter_key === adapterKey),
  );
}

/**
 * Absolute filesystem path of a corpus entry's file.
 *
 * @param entry - The manifest entry.
 * @returns The absolute path under `apiome-ui/examples/`.
 */
export function corpusFilePath(entry: CorpusEntry): string {
  return path.join(corpusRoot(), ...entry.path.split('/'));
}

/**
 * Read a corpus entry's file content as UTF-8 text.
 *
 * @param entry - The manifest entry.
 * @returns The file content.
 */
export function readCorpusFile(entry: CorpusEntry): string {
  return fs.readFileSync(corpusFilePath(entry), 'utf-8');
}

/**
 * List every corpus fixture file on disk (paths relative to the corpus root,
 * POSIX separators, sorted). This is the ground truth the completeness test
 * compares the manifest against.
 */
export function listCorpusFiles(): string[] {
  const root = corpusRoot();
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(absolute);
      } else if (dirent.isFile() && !NON_CORPUS_FILENAMES.has(dirent.name)) {
        results.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return results.sort();
}
