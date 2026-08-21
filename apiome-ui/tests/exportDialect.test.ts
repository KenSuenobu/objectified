/**
 * `resolveExportDialect` — the emitted-version fidelity badge (FMT-3.2, #5427).
 *
 * AsyncAPI's emitter gained an `asyncapi_version` option: 3.1 natively, or a 2.6 downgrade
 * for consumers still on AsyncAPI 2.x. Choosing the older version is a fidelity decision —
 * the emitter records every 3.x-only construct 2.6 cannot express as a declared loss — but
 * the target card's tier badge is computed for the source *before* any option is chosen, so
 * on its own it cannot say which version is going out. This helper is what does.
 *
 * The rule under test is that the dialect option is discovered from the target's own options
 * schema (an `enum` option whose key ends in `_version`), so a target that gains a version
 * option is covered without a per-target table.
 */

import {
  resolveExportDialect,
  type ExportTargetEntry,
} from '../src/app/components/ade/dashboard/export/exportTargetCatalog';

/** The AsyncAPI target entry as `GET /api/export/targets` reports it after FMT-3.2. */
function asyncapiEntry(): ExportTargetEntry {
  return {
    descriptor: {
      key: 'asyncapi',
      format: 'asyncapi-3',
      label: 'AsyncAPI 3.1',
      description: 'Export as an AsyncAPI 3.1 JSON document.',
      icon: 'radio-tower',
      paradigm: 'event',
      multi_file: false,
      needs_toolchain: false,
      available: true,
      unavailable_reason: null,
    },
    capability_profile: { events: true },
    options_schema: {
      properties: {
        asyncapi_version: {
          type: 'string',
          enum: ['3.1', '2.6'],
          title: 'AsyncAPI version',
          description: 'AsyncAPI version to emit.',
          default: '3.1',
        },
        include_channels: { type: 'boolean', default: true },
      },
    },
    default_options: { asyncapi_version: '3.1', include_channels: true },
    fidelity: {
      tier: 'lossless',
      preserved_percent: 100,
      total: 8,
      preserved: 8,
      dropped: 0,
      approximated: 0,
      synthesized: 0,
    },
  };
}

/** A target with no version option at all — most of the registry. */
function avroEntry(): ExportTargetEntry {
  const entry = asyncapiEntry();
  return {
    ...entry,
    descriptor: { ...entry.descriptor, key: 'avro', format: 'avro-1.12', label: 'Apache Avro' },
    options_schema: { properties: { namespace: { type: 'string' } } },
    default_options: {},
  };
}

describe('resolveExportDialect', () => {
  it('reports the target default as the native version', () => {
    const dialect = resolveExportDialect(asyncapiEntry(), {});
    expect(dialect).not.toBeNull();
    expect(dialect!.optionKey).toBe('asyncapi_version');
    expect(dialect!.value).toBe('3.1');
    expect(dialect!.nativeValue).toBe('3.1');
    expect(dialect!.native).toBe(true);
    expect(dialect!.label).toBe('3.1 · native');
    expect(dialect!.detail).toContain('nothing is downgraded');
  });

  it('reports a chosen older version as a downgrade', () => {
    const dialect = resolveExportDialect(asyncapiEntry(), { asyncapi_version: '2.6' });
    expect(dialect!.value).toBe('2.6');
    expect(dialect!.native).toBe(false);
    expect(dialect!.label).toBe('2.6 · downgrade');
    expect(dialect!.detail).toContain('downgrade from 3.1');
  });

  it('tones the badge with the same fidelity vocabulary as the tier badge', () => {
    const native = resolveExportDialect(asyncapiEntry(), { asyncapi_version: '3.1' });
    const downgrade = resolveExportDialect(asyncapiEntry(), { asyncapi_version: '2.6' });
    expect(native!.tone).not.toBe(downgrade!.tone);
  });

  it('falls back to the native version when the chosen value is not an allowed one', () => {
    // A stale value carried across a target change must not invent a version.
    const dialect = resolveExportDialect(asyncapiEntry(), { asyncapi_version: '1.0' });
    expect(dialect!.value).toBe('3.1');
    expect(dialect!.native).toBe(true);
  });

  it('returns null for a target that emits a single version', () => {
    expect(resolveExportDialect(avroEntry(), {})).toBeNull();
  });

  it('returns null when there is no selected target', () => {
    expect(resolveExportDialect(null, { asyncapi_version: '2.6' })).toBeNull();
  });

  it('finds any _version enum option, not a hard-coded target list', () => {
    const entry = asyncapiEntry();
    const openapi: ExportTargetEntry = {
      ...entry,
      descriptor: { ...entry.descriptor, key: 'openapi', label: 'OpenAPI 3.1' },
      options_schema: {
        properties: {
          openapi_version: { type: 'string', enum: ['3.1', '3.0', '2.0'], default: '3.1' },
        },
      },
      default_options: { openapi_version: '3.1' },
    };
    const dialect = resolveExportDialect(openapi, { openapi_version: '2.0' });
    expect(dialect!.optionKey).toBe('openapi_version');
    expect(dialect!.label).toBe('2.0 · downgrade');
  });
});
