/**
 * Unit tests for the catalog convert-to-OpenAPI back-link helpers (MFI-23.11, #4020).
 *
 * These pin the pure presentation logic behind the "Converted → {project}" state the Catalog card,
 * table and detail render: the project href, the friendly label (name → slug → short id), the
 * live-vs-deleted link decision, and the convert-vs-re-convert action label.
 */
import {
  convertActionLabel,
  convertPreviewDialogTitle,
  convertedProjectHref,
  convertedProjectLabel,
  isConvertedLinkLive,
  isDirectProjectConvertFormat,
  type CatalogConversion,
} from '../src/app/utils/catalog-conversion';

function makeConversion(overrides: Partial<CatalogConversion> = {}): CatalogConversion {
  return {
    projectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    projectName: 'Acme OpenAPI',
    projectSlug: 'acme-openapi',
    projectDeleted: false,
    versionId: '1.0.0',
    versionRecordId: 'ver-1',
    reconverted: false,
    convertedAt: '2026-03-01T00:00:00.000Z',
    fidelityGrade: 'B',
    fidelityTier: 'medium',
    ...overrides,
  };
}

describe('convertedProjectHref', () => {
  it('links to the converted project’s versions screen with an encoded id', () => {
    const href = convertedProjectHref(makeConversion({ projectId: 'a b/c' }));
    expect(href).toBe('/ade/dashboard/versions?projectId=a%20b%2Fc');
  });
});

describe('convertedProjectLabel', () => {
  it('prefers the project name', () => {
    expect(convertedProjectLabel(makeConversion())).toBe('Acme OpenAPI');
  });

  it('falls back to the slug when the name is missing', () => {
    expect(convertedProjectLabel(makeConversion({ projectName: null }))).toBe('acme-openapi');
  });

  it('falls back to a shortened id when name and slug are missing', () => {
    const label = convertedProjectLabel(
      makeConversion({ projectName: null, projectSlug: null, projectId: 'abcdef0123456789' }),
    );
    expect(label).toBe('project abcdef01');
  });

  it('ignores whitespace-only name/slug', () => {
    expect(convertedProjectLabel(makeConversion({ projectName: '   ', projectSlug: 'acme-openapi' }))).toBe(
      'acme-openapi',
    );
  });
});

describe('isConvertedLinkLive', () => {
  it('is true for a converted, non-deleted target', () => {
    expect(isConvertedLinkLive(makeConversion())).toBe(true);
  });

  it('is false when the target project was deleted', () => {
    expect(isConvertedLinkLive(makeConversion({ projectDeleted: true }))).toBe(false);
  });

  it('is false for a null/undefined conversion', () => {
    expect(isConvertedLinkLive(null)).toBe(false);
    expect(isConvertedLinkLive(undefined)).toBe(false);
  });
});

describe('isDirectProjectConvertFormat', () => {
  it('is true for OpenAPI and Arazzo sources', () => {
    expect(isDirectProjectConvertFormat('openapi-3.1')).toBe(true);
    expect(isDirectProjectConvertFormat('arazzo')).toBe(true);
  });

  it('is false for other catalog formats', () => {
    expect(isDirectProjectConvertFormat('protobuf')).toBe(false);
    expect(isDirectProjectConvertFormat('graphql')).toBe(false);
    expect(isDirectProjectConvertFormat(null)).toBe(false);
  });
});

describe('convertActionLabel', () => {
  it('reads "Convert to OpenAPI Project" for an unconverted non-OpenAPI item', () => {
    expect(convertActionLabel(null, 'protobuf')).toBe('Convert to OpenAPI Project');
    expect(convertActionLabel(undefined, 'asyncapi')).toBe('Convert to OpenAPI Project');
  });

  it('reads "Convert to Project" for an unconverted OpenAPI or Arazzo item', () => {
    expect(convertActionLabel(null, 'openapi-3.1')).toBe('Convert to Project');
    expect(convertActionLabel(null, 'arazzo')).toBe('Convert to Project');
  });

  it('reads "Re-convert to OpenAPI Project" once a non-OpenAPI item has been converted', () => {
    expect(convertActionLabel(makeConversion(), 'protobuf')).toBe('Re-convert to OpenAPI Project');
  });

  it('reads "Re-convert to Project" once an OpenAPI or Arazzo item has been converted', () => {
    expect(convertActionLabel(makeConversion(), 'openapi-3.1')).toBe('Re-convert to Project');
    expect(convertActionLabel(makeConversion(), 'arazzo')).toBe('Re-convert to Project');
  });
});

describe('convertPreviewDialogTitle', () => {
  it('uses the OpenAPI Project prefix for non-OpenAPI sources', () => {
    expect(convertPreviewDialogTitle('Acme API', 'protobuf')).toBe('Convert to OpenAPI Project — Acme API');
  });

  it('uses the shorter Project prefix for OpenAPI and Arazzo sources', () => {
    expect(convertPreviewDialogTitle('Acme API', 'openapi-3.1')).toBe('Convert to Project — Acme API');
    expect(convertPreviewDialogTitle('Acme API', 'arazzo')).toBe('Convert to Project — Acme API');
  });
});

describe('CPDO-3.3 provenance linkage fields', () => {
  it('carrying provenanceId/manifestHash leaves the href/live helpers untouched', () => {
    const conversion = makeConversion({
      provenanceId: 'prov-1',
      manifestHash: 'a'.repeat(64),
    });
    expect(isConvertedLinkLive(conversion)).toBe(true);
    expect(convertedProjectHref(conversion)).toBe(
      '/ade/dashboard/versions?projectId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });

  it('pre-manifest conversions carry null linkage without breaking anything', () => {
    const conversion = makeConversion({ provenanceId: null, manifestHash: null });
    expect(isConvertedLinkLive(conversion)).toBe(true);
  });
});
