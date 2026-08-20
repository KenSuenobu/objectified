/**
 * The catalog gallery partitions on the import-source registry (FMT-1.2, #5413).
 *
 * The gallery used to split its formats on a hard-coded `importable` flag, making it a third source
 * of truth beside the server registry and the guide docs. These tests pin the replacement: the
 * split comes from `GET /api/import/sources`, with the local flag surviving only as the offline
 * fallback, and an unavailable-but-registered adapter staying importable rather than being demoted.
 */

import {
  ALTERNATIVE_CATALOG_FORMATS,
  IMPORTABLE_ALTERNATIVE_FORMATS,
  type CatalogFormat,
} from '../src/app/utils/catalog-format-registry';
import {
  partitionCatalogFormats,
  registryKeyForCatalogFormat,
} from '../src/app/utils/catalog-format-support';

/** Pick the gallery entries these tests name, so a fixture stays readable. */
function formatsById(...ids: string[]): CatalogFormat[] {
  return ids.map((id) => {
    const found = ALTERNATIVE_CATALOG_FORMATS.find((f) => f.id === id);
    if (!found) throw new Error(`no catalog format registered for ${id}`);
    return found;
  });
}

describe('registryKeyForCatalogFormat', () => {
  it('maps a gallery entry onto the REST adapter key it would import under', () => {
    const [grpc] = formatsById('grpc');
    // The two registries spell it differently; the importer's own map is what reconciles them.
    expect(registryKeyForCatalogFormat(grpc)).toBe('grpc');
  });

  it('honours the hyphenated JSON Schema registry key', () => {
    const [jsonschema] = formatsById('jsonschema');
    expect(registryKeyForCatalogFormat(jsonschema)).toBe('json-schema');
  });

  it('maps every alternative format, so none is demoted for want of a mapping', () => {
    // A missing mapping would silently move a working format to "not yet importable" — the exact
    // over-/under-claim this ticket exists to end.
    const unmapped = ALTERNATIVE_CATALOG_FORMATS.filter(
      (fmt) => registryKeyForCatalogFormat(fmt) === null,
    ).map((fmt) => fmt.id);
    expect(unmapped).toEqual([]);
  });
});

describe('partitionCatalogFormats', () => {
  it('calls a format importable when the registry reports its adapter', () => {
    const formats = formatsById('grpc', 'graphql', 'hl7v2');
    const { importable, recognized, fromRegistry } = partitionCatalogFormats(
      new Set(['grpc', 'graphql']),
      formats,
    );

    expect(fromRegistry).toBe(true);
    expect(importable.map((f) => f.id)).toEqual(['grpc', 'graphql']);
    expect(recognized.map((f) => f.id)).toEqual(['hl7v2']);
  });

  it('moves a format the moment its adapter is registered — with no UI edit', () => {
    const formats = formatsById('hl7v2');
    expect(partitionCatalogFormats(new Set(['grpc']), formats).recognized.map((f) => f.id)).toEqual([
      'hl7v2',
    ]);
    expect(partitionCatalogFormats(new Set(['grpc', 'hl7v2']), formats).importable.map((f) => f.id)).toEqual([
      'hl7v2',
    ]);
  });

  it('moves a format back when its adapter is retired', () => {
    const formats = formatsById('thrift');
    expect(partitionCatalogFormats(new Set(['thrift']), formats).importable).toHaveLength(1);
    expect(partitionCatalogFormats(new Set(['grpc']), formats).recognized).toHaveLength(1);
  });

  it('keeps a registered-but-unavailable adapter importable', () => {
    // "Supported, but this deployment has no `buf`" and "not yet importable" are different facts.
    // The gallery dims the first with a reason; demoting it to the second would be a lie.
    const formats = formatsById('grpc');
    const { importable, recognized } = partitionCatalogFormats(new Set(['grpc']), formats);
    expect(importable.map((f) => f.id)).toEqual(['grpc']);
    expect(recognized).toEqual([]);
  });

  it('preserves the registry declaration order within each group', () => {
    const formats = formatsById('graphql', 'grpc', 'thrift');
    const { importable } = partitionCatalogFormats(new Set(['graphql', 'grpc', 'thrift']), formats);
    expect(importable.map((f) => f.id)).toEqual(['graphql', 'grpc', 'thrift']);
  });

  it('falls back to the local flag before the registry resolves', () => {
    for (const keys of [null, undefined, new Set<string>()]) {
      const { importable, fromRegistry } = partitionCatalogFormats(keys);
      expect(fromRegistry).toBe(false);
      // The offline split is the shipped one, so the gallery is never blank.
      expect(importable.map((f) => f.id)).toEqual(IMPORTABLE_ALTERNATIVE_FORMATS.map((f) => f.id));
    }
  });

  it('partitions every alternative format when the whole registry is present', () => {
    const keys = new Set(
      ALTERNATIVE_CATALOG_FORMATS.map((fmt) => registryKeyForCatalogFormat(fmt) as string),
    );
    const { importable, recognized } = partitionCatalogFormats(keys);
    expect(recognized).toEqual([]);
    expect(importable).toHaveLength(ALTERNATIVE_CATALOG_FORMATS.length);
  });

  it('never loses or duplicates a format', () => {
    const { importable, recognized } = partitionCatalogFormats(new Set(['grpc', 'graphql']));
    const ids = [...importable, ...recognized].map((f) => f.id);
    expect(ids).toHaveLength(ALTERNATIVE_CATALOG_FORMATS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
