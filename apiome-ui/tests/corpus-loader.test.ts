/**
 * Corpus manifest loader tests (TypeScript side) — IXH-1.1 (#5087).
 *
 * The Python twin (`apiome-rest/tests/test_corpus_manifest.py`) owns schema
 * validation, adapter-registry consistency, and README drift; this suite
 * proves the TypeScript loader honors the same contract from Jest:
 * completeness in both directions, typed loading, and tag-based selection.
 */

import {
  CorpusEntry,
  corpusFilePath,
  listCorpusFiles,
  loadCorpus,
  loadManifest,
  readCorpusFile,
} from '@lib/corpus/corpus';
import * as fs from 'fs';

describe('corpus manifest loader', () => {
  it('loads and validates the manifest', () => {
    const manifest = loadManifest();
    expect(manifest.manifest_version).toBe(1);
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.directories).length).toBeGreaterThan(0);
  });

  it('lists every corpus file in the manifest and every entry on disk', () => {
    const onDisk = listCorpusFiles();
    const listed = loadManifest()
      .entries.map((entry: CorpusEntry) => entry.path)
      .sort();

    const unlisted = onDisk.filter((file) => !listed.includes(file));
    const missing = listed.filter((file) => !onDisk.includes(file));
    expect({ unlisted, missing }).toEqual({ unlisted: [], missing: [] });
  });

  it('keeps entry paths unique and sorted', () => {
    const paths = loadManifest().entries.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort());
  });

  it('declares directory metadata for every entry directory', () => {
    const manifest = loadManifest();
    const entryDirs = new Set(manifest.entries.map((entry) => entry.path.split('/')[0]));
    for (const dir of entryDirs) {
      expect(manifest.directories[dir]).toBeDefined();
    }
    for (const dir of Object.keys(manifest.directories)) {
      expect(entryDirs.has(dir)).toBe(true);
    }
  });

  it('returns the full corpus with no filters', () => {
    expect(loadCorpus()).toHaveLength(loadManifest().entries.length);
  });

  it('filters by format', () => {
    const entries = loadCorpus({ format: 'openapi' });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.format).toBe('openapi');
      expect(entry.path.startsWith('openapi/')).toBe(true);
    }
  });

  it('filters by validity class', () => {
    const invalid = loadCorpus({ validityClass: 'invalid' });
    expect(invalid.map((entry) => entry.path)).toContain('arazzo/property-conflicts.yaml');
    for (const entry of invalid) {
      expect(entry.validity_class).toBe('invalid');
      expect(entry.expected_outcome).toBe('rejects');
    }
  });

  it('filters by feature tag', () => {
    const entries = loadCorpus({ feature: 'occurs-depending-on' });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.features).toContain('occurs-depending-on');
      expect(entry.format).toBe('cobolcopybook');
    }
  });

  it('filters by adapter key', () => {
    const entries = loadCorpus({ adapterKey: 'grpc' });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.adapter_key).toBe('grpc');
      expect(entry.path.startsWith('protobuf/')).toBe(true);
    }
  });

  it('composes filters with AND semantics', () => {
    const entries = loadCorpus({ format: 'avro', feature: 'enum' });
    expect(entries.map((entry) => entry.path)).toEqual(['avro/01-user-record.avsc']);
  });

  it('returns empty for unknown filter values', () => {
    expect(loadCorpus({ format: 'no-such-format' })).toEqual([]);
    expect(loadCorpus({ feature: 'no-such-feature' })).toEqual([]);
    expect(loadCorpus({ adapterKey: 'no-such-adapter' })).toEqual([]);
  });

  it('resolves and reads entry files', () => {
    const [weather] = loadCorpus({ format: 'smithy' });
    expect(fs.existsSync(corpusFilePath(weather))).toBe(true);
    expect(readCorpusFile(weather)).toContain('$version');
  });
});
