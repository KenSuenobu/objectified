/**
 * Export Studio URL state — deep links & resumable Studio state (MFX-41.4, #4351).
 *
 * Covers the ticket's contract at the encoding layer:
 *  1. A session round-trips through the URL: source, target, compact options, step.
 *  2. Stale/hand-edited links degrade — never crash, never silently wrong.
 *  3. No secrets in URLs: credential-shaped option keys never encode and never decode.
 *  4. A restored step is clamped to what the link can actually establish (no inherited verdict).
 */

import {
  EXPORT_STUDIO_STEP_ORDER,
  decodeStudioOptions,
  describeStudioSourceFailure,
  encodeStudioOptions,
  isExportStudioStep,
  parseExportStudioUrlState,
  resolveResumableStep,
  stripSecretOptions,
} from '../src/app/components/ade/dashboard/export/exportStudioUrlState';

/** A query string as the Studio route reads it. */
function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('stripSecretOptions', () => {
  it('keeps ordinary options and withholds credential-shaped keys', () => {
    const { safe, redacted } = stripSecretOptions({
      package: 'com.example',
      api_key: 'sk-live-1',
      webhookToken: 't-1',
      registry_password: 'hunter2',
      partition_key: 'tenant',
    });
    expect(safe).toEqual({ package: 'com.example', partition_key: 'tenant' });
    expect(redacted).toEqual(['api_key', 'webhookToken', 'registry_password']);
  });

  it('returns null when nothing shareable remains', () => {
    expect(stripSecretOptions({ auth_token: 'x' })).toEqual({ safe: null, redacted: ['auth_token'] });
    expect(stripSecretOptions(null)).toEqual({ safe: null, redacted: [] });
    expect(stripSecretOptions({})).toEqual({ safe: null, redacted: [] });
  });
});

describe('encodeStudioOptions / decodeStudioOptions', () => {
  it('round-trips overrides through the compact form', () => {
    const options = { package: 'com.example', emit_services: false, depth: 3 };
    const encoded = encodeStudioOptions(options);
    expect(encoded).toBeTruthy();
    // Compact means base64url: no braces, quotes, or percent-escapes to paste around.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeStudioOptions(encoded)).toEqual(options);
  });

  it('round-trips non-ASCII option values', () => {
    const options = { title: 'Café — Ünicode ✅' };
    expect(decodeStudioOptions(encodeStudioOptions(options))).toEqual(options);
  });

  it('never encodes credential-shaped keys', () => {
    const encoded = encodeStudioOptions({ package: 'com.example', delivery_token: 'sk-live-1' });
    expect(decodeStudioOptions(encoded)).toEqual({ package: 'com.example' });
  });

  it('encodes nothing when every override is a credential', () => {
    expect(encodeStudioOptions({ password: 'hunter2' })).toBeNull();
    expect(encodeStudioOptions({})).toBeNull();
    expect(encodeStudioOptions(null)).toBeNull();
  });

  it('drops an over-long payload rather than minting an unusable link', () => {
    expect(encodeStudioOptions({ blob: 'x'.repeat(4000) })).toBeNull();
  });

  it('decodes the legacy plain-JSON options param (MFX-41.3 links keep working)', () => {
    expect(decodeStudioOptions('{"package":"com.example"}')).toEqual({ package: 'com.example' });
  });

  it('strips credentials out of a hand-crafted link', () => {
    expect(decodeStudioOptions('{"package":"p","api_key":"sk-1"}')).toEqual({ package: 'p' });
  });

  it('returns null for missing, malformed, or non-object payloads', () => {
    expect(decodeStudioOptions(null)).toBeNull();
    expect(decodeStudioOptions('')).toBeNull();
    expect(decodeStudioOptions('not json at all')).toBeNull();
    expect(decodeStudioOptions('[1,2,3]')).toBeNull();
    expect(decodeStudioOptions('"a string"')).toBeNull();
    expect(decodeStudioOptions('42')).toBeNull();
    expect(decodeStudioOptions('x'.repeat(4000))).toBeNull();
  });
});

describe('parseExportStudioUrlState', () => {
  it('validates a full session link', () => {
    const encoded = encodeStudioOptions({ package: 'com.example' });
    const { state, issues } = parseExportStudioUrlState(
      params(
        `artifact=proj-1&version=rev-9&label=Pet+Store+API&target=proto&from=catalog&sourceFormat=graphql&opts=${encoded}&step=verify`,
      ),
    );
    expect(issues).toEqual([]);
    expect(state).toEqual({
      artifact: 'proj-1',
      version: 'rev-9',
      label: 'Pet Store API',
      target: 'proto',
      origin: 'catalog',
      sourceFormat: 'graphql',
      options: { package: 'com.example' },
      step: 'verify',
    });
  });

  it('reads a bare artifact-only link', () => {
    const { state, issues } = parseExportStudioUrlState(params('artifact=proj-1'));
    expect(issues).toEqual([]);
    expect(state.artifact).toBe('proj-1');
    expect(state.target).toBeNull();
    expect(state.options).toBeNull();
    expect(state.step).toBeNull();
  });

  it('reports no artifact for a bare link (the route shows its empty state)', () => {
    expect(parseExportStudioUrlState(params('')).state.artifact).toBeNull();
    expect(parseExportStudioUrlState(params('artifact=%20%20')).state.artifact).toBeNull();
  });

  it('falls back to the first step for an unknown step, without a notice', () => {
    const { state, issues } = parseExportStudioUrlState(params('artifact=proj-1&step=teleport'));
    expect(state.step).toBeNull();
    expect(issues).toEqual([]);
  });

  it('accepts every declared step', () => {
    for (const step of EXPORT_STUDIO_STEP_ORDER) {
      expect(parseExportStudioUrlState(params(`artifact=p&step=${step}`)).state.step).toBe(step);
    }
  });

  it('ignores an unusable scalar and says so', () => {
    const { state, issues } = parseExportStudioUrlState(
      params(`artifact=proj-1&target=${'t'.repeat(600)}`),
    );
    expect(state.artifact).toBe('proj-1');
    expect(state.target).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('param-invalid');
    expect(issues[0].message).toContain('target');
  });

  it('degrades an unreadable options payload to a notice', () => {
    const { state, issues } = parseExportStudioUrlState(params('artifact=proj-1&opts=%7Bnope'));
    expect(state.options).toBeNull();
    expect(issues.map((issue) => issue.code)).toEqual(['options-unreadable']);
  });

  it('withholds credential-shaped options from a hand-crafted link and says why', () => {
    const { state, issues } = parseExportStudioUrlState(
      params(`artifact=proj-1&options=${encodeURIComponent('{"package":"p","api_key":"sk-1"}')}`),
    );
    expect(state.options).toEqual({ package: 'p' });
    expect(issues.map((issue) => issue.code)).toEqual(['options-redacted']);
    expect(issues[0].message).toContain('api_key');
  });

  it('prefers the compact param when a link carries both encodings', () => {
    const encoded = encodeStudioOptions({ package: 'compact' });
    const { state } = parseExportStudioUrlState(
      params(
        `artifact=proj-1&opts=${encoded}&options=${encodeURIComponent('{"package":"legacy"}')}`,
      ),
    );
    expect(state.options).toEqual({ package: 'compact' });
  });
});

describe('resolveResumableStep', () => {
  const ready = { hasTarget: true, optionsValid: true };

  it('opens at Source for a link with no step', () => {
    expect(resolveResumableStep(null, ready)).toBe('source');
    expect(resolveResumableStep('source', ready)).toBe('source');
  });

  it('resumes a fully-established link at its step', () => {
    expect(resolveResumableStep('target', ready)).toBe('target');
    expect(resolveResumableStep('options', ready)).toBe('options');
    expect(resolveResumableStep('verify', ready)).toBe('verify');
  });

  it('never resumes at Review — a verdict is not a URL parameter', () => {
    expect(resolveResumableStep('review', ready)).toBe('verify');
  });

  it('falls back to Target when the link’s target did not resolve', () => {
    const noTarget = { hasTarget: false, optionsValid: false };
    expect(resolveResumableStep('options', noTarget)).toBe('target');
    expect(resolveResumableStep('verify', noTarget)).toBe('target');
    expect(resolveResumableStep('review', noTarget)).toBe('target');
  });

  it('falls back to Options when the restored options do not validate', () => {
    const invalid = { hasTarget: true, optionsValid: false };
    expect(resolveResumableStep('verify', invalid)).toBe('options');
    expect(resolveResumableStep('review', invalid)).toBe('options');
  });
});

describe('describeStudioSourceFailure', () => {
  it('explains a deleted source or version', () => {
    expect(describeStudioSourceFailure(404, 'Not found')).toMatch(/no longer exists/i);
  });

  it('explains a source outside the viewer’s tenant', () => {
    expect(describeStudioSourceFailure(403, 'Forbidden')).toMatch(/not available in your workspace/i);
  });

  it('explains an expired session', () => {
    expect(describeStudioSourceFailure(401, 'Unauthorized')).toMatch(/sign in again/i);
  });

  it('passes any other failure through unchanged', () => {
    expect(describeStudioSourceFailure(500, 'Could not load export targets.')).toBe(
      'Could not load export targets.',
    );
    expect(describeStudioSourceFailure(null, 'Could not load export targets.')).toBe(
      'Could not load export targets.',
    );
  });
});

describe('isExportStudioStep', () => {
  it('accepts the declared steps and nothing else', () => {
    expect(isExportStudioStep('review')).toBe(true);
    expect(isExportStudioStep('Review')).toBe(false);
    expect(isExportStudioStep(null)).toBe(false);
    expect(isExportStudioStep(2)).toBe(false);
  });
});
