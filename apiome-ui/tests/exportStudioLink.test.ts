/**
 * exportStudioHref — the Export Studio deep-link contract (MFX-41.1, #4348; MFX-41.4, #4351).
 *
 * The ExportDialog escalation, the Studio route, and the Studio's own "Copy link" agree on the
 * query string built here: a required `artifact`, plus the optional `version`, `label`,
 * pre-selected `target`, compact option overrides (`opts`), and resumable `step`.
 */

import {
  EXPORT_STUDIO_PATH,
  buildExportStudioShareUrl,
  exportStudioHref,
  parseExportStudioOptions,
  resolveStudioBack,
} from '../src/app/components/ade/dashboard/export/exportStudioLink';

describe('exportStudioHref', () => {
  it('builds a bare artifact-only link', () => {
    expect(exportStudioHref({ artifact: 'proj-1' })).toBe(`${EXPORT_STUDIO_PATH}?artifact=proj-1`);
  });

  it('includes version, label, target, origin, and sourceFormat when provided', () => {
    const href = exportStudioHref({
      artifact: 'proj-1',
      version: 'rev-9',
      label: 'Pet Store API',
      target: 'proto',
      origin: 'catalog',
      sourceFormat: 'graphql',
    });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith(`${EXPORT_STUDIO_PATH}?`)).toBe(true);
    expect(params.get('artifact')).toBe('proj-1');
    expect(params.get('version')).toBe('rev-9');
    expect(params.get('label')).toBe('Pet Store API');
    expect(params.get('target')).toBe('proto');
    expect(params.get('from')).toBe('catalog');
    expect(params.get('sourceFormat')).toBe('graphql');
  });

  it('omits empty and null optional fields', () => {
    const href = exportStudioHref({
      artifact: 'proj-1',
      version: null,
      label: '',
      target: undefined,
      origin: null,
      sourceFormat: '',
      options: null,
    });
    expect(href).toBe(`${EXPORT_STUDIO_PATH}?artifact=proj-1`);
  });

  it('encodes non-empty option overrides compactly and round-trips them (MFX-41.3/41.4)', () => {
    const options = { package: 'com.example', emit_services: false };
    const href = exportStudioHref({ artifact: 'proj-1', target: 'proto', options });
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('target')).toBe('proto');
    // Compact: base64url, so the link carries no braces/quotes to escape.
    expect(params.get('opts')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseExportStudioOptions(params.get('opts'))).toEqual(options);
  });

  it('omits the options param for an empty override map', () => {
    const href = exportStudioHref({ artifact: 'proj-1', target: 'proto', options: {} });
    expect(new URLSearchParams(href.split('?')[1]).has('opts')).toBe(false);
  });

  it('never carries a credential-shaped option (MFX-41.4)', () => {
    const href = exportStudioHref({
      artifact: 'proj-1',
      target: 'proto',
      options: { package: 'com.example', delivery_token: 'sk-live-1' },
    });
    const opts = new URLSearchParams(href.split('?')[1]).get('opts');
    expect(href).not.toContain('sk-live-1');
    expect(parseExportStudioOptions(opts)).toEqual({ package: 'com.example' });
  });

  it('carries the resumable step, omitting the default first step (MFX-41.4)', () => {
    const verify = exportStudioHref({ artifact: 'proj-1', target: 'proto', step: 'verify' });
    expect(new URLSearchParams(verify.split('?')[1]).get('step')).toBe('verify');
    const source = exportStudioHref({ artifact: 'proj-1', step: 'source' });
    expect(new URLSearchParams(source.split('?')[1]).has('step')).toBe(false);
  });
});

describe('buildExportStudioShareUrl (MFX-41.4)', () => {
  it('resolves the deep link against an explicit origin', () => {
    const url = buildExportStudioShareUrl(
      { artifact: 'proj-1', target: 'proto', step: 'verify' },
      'https://apiome.example.com',
    );
    expect(url.startsWith(`https://apiome.example.com${EXPORT_STUDIO_PATH}?`)).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('artifact')).toBe('proj-1');
    expect(params.get('target')).toBe('proto');
    expect(params.get('step')).toBe('verify');
  });

  it('defaults to the current browser origin', () => {
    expect(buildExportStudioShareUrl({ artifact: 'proj-1' })).toBe(
      `${window.location.origin}${EXPORT_STUDIO_PATH}?artifact=proj-1`,
    );
  });

  it('falls back to the root-relative href for an unusable origin', () => {
    expect(buildExportStudioShareUrl({ artifact: 'proj-1' }, 'not a url')).toBe(
      `${EXPORT_STUDIO_PATH}?artifact=proj-1`,
    );
  });
});

describe('parseExportStudioOptions', () => {
  it('parses a legacy JSON object of overrides (links minted before MFX-41.4)', () => {
    expect(parseExportStudioOptions('{"package":"com.example"}')).toEqual({ package: 'com.example' });
  });

  it('returns null for missing, malformed, or non-object values', () => {
    expect(parseExportStudioOptions(null)).toBeNull();
    expect(parseExportStudioOptions('')).toBeNull();
    expect(parseExportStudioOptions('not json')).toBeNull();
    expect(parseExportStudioOptions('[1,2,3]')).toBeNull();
    expect(parseExportStudioOptions('"a string"')).toBeNull();
    expect(parseExportStudioOptions('42')).toBeNull();
  });
});

describe('resolveStudioBack', () => {
  it('returns the Catalog screen for a catalog origin', () => {
    expect(resolveStudioBack('catalog')).toEqual({ href: '/ade/dashboard/catalog', label: 'Catalog' });
  });

  it('returns the Versions screen for a versions origin', () => {
    expect(resolveStudioBack('versions')).toEqual({ href: '/ade/dashboard/versions', label: 'Versions' });
  });

  it('falls back to Versions for a missing or unknown origin', () => {
    expect(resolveStudioBack(null)).toEqual({ href: '/ade/dashboard/versions', label: 'Versions' });
    expect(resolveStudioBack('mars')).toEqual({ href: '/ade/dashboard/versions', label: 'Versions' });
  });
});
