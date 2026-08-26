/**
 * The export test-drive mock model (MFX-44.5, #4371).
 *
 * Pins the pure half of the Studio's mock binding — the decisions the panel must not re-derive:
 * which targets get a panel at all (capability data, never a format switch), how an absent mock
 * backend degrades, the expiry countdown, the try-it path builder, and the words each log row
 * says about a served request.
 */

import {
  COUNTDOWN_DANGER_SECONDS,
  COUNTDOWN_WARN_SECONDS,
  buildRequestPath,
  countdownTone,
  describeMockInstance,
  formatCountdown,
  formatLogTime,
  mockAvailabilityNotice,
  mockIsLive,
  mockSupportsTarget,
  operationKey,
  pathParameters,
  requestOutcomeLabel,
  requestOutcomeTone,
  statusTone,
  type ExportMockCapability,
  type ExportMockInstance,
  type ExportMockRequestEntry,
} from '../src/app/components/ade/dashboard/export/exportMockTestDrive';

const CAPABILITY: ExportMockCapability = {
  available: true,
  reason: null,
  supportedTargets: ['openapi'],
  defaultTtlMinutes: 30,
  maxTtlMinutes: 240,
  maxPerTenant: 3,
  rateLimitPerMinute: 60,
};

function instance(overrides: Partial<ExportMockInstance> = {}): ExportMockInstance {
  return {
    id: 'mock-1',
    baseUrl: 'http://localhost:8000/v1/mock/mock-1',
    status: 'active',
    target: 'openapi-3.1',
    targetKey: 'openapi',
    targetLabel: 'OpenAPI 3.1',
    artifact: 'artifact-1',
    version: '1.0.0',
    operationCount: 2,
    operations: [
      { method: 'GET', path: '/widgets', operationId: 'listWidgets' },
      { method: 'GET', path: '/widgets/{widgetId}', operationId: 'getWidget' },
    ],
    scenarios: ['happy-path', 'server-error'],
    activeScenario: 'happy-path',
    rateLimitPerMinute: 60,
    requestCount: 0,
    expiresInSeconds: 1800,
    ...overrides,
  };
}

function entry(overrides: Partial<ExportMockRequestEntry> = {}): ExportMockRequestEntry {
  return {
    at: '2026-08-26T14:22:07.000Z',
    method: 'GET',
    path: '/widgets',
    status: 200,
    matched: true,
    scenario: 'happy-path',
    operationId: 'GET /widgets',
    schemaValid: true,
    durationMs: 4,
    ...overrides,
  };
}

describe('which targets get a test-drive panel', () => {
  it('asks the capability report, so a new mockable emitter needs no UI change', () => {
    expect(mockSupportsTarget(CAPABILITY, 'openapi')).toBe(true);
    expect(mockSupportsTarget(CAPABILITY, 'protobuf')).toBe(false);
  });

  it('supports nothing while the capability is unknown or no target is chosen', () => {
    expect(mockSupportsTarget(null, 'openapi')).toBe(false);
    expect(mockSupportsTarget(CAPABILITY, null)).toBe(false);
    expect(mockSupportsTarget(CAPABILITY, undefined)).toBe(false);
  });
});

describe('how an absent mock backend degrades', () => {
  it('holds off while the capability call is still in flight', () => {
    expect(mockAvailabilityNotice(null, 'openapi', true)).toEqual({ kind: 'pending' });
  });

  it('hides the panel for a target the engine cannot serve', () => {
    expect(mockAvailabilityNotice(CAPABILITY, 'protobuf', false)).toEqual({ kind: 'hidden' });
  });

  it('disables the panel with the server’s own reason when the infrastructure is absent', () => {
    const unavailable = { ...CAPABILITY, available: false, reason: 'The Mock Server is off.' };
    expect(mockAvailabilityNotice(unavailable, 'openapi', false)).toEqual({
      kind: 'disabled',
      reason: 'The Mock Server is off.',
    });
  });

  it('states a generic reason when the server reports none', () => {
    const unavailable = { ...CAPABILITY, available: false, reason: null };
    const outcome = mockAvailabilityNotice(unavailable, 'openapi', false);
    expect(outcome.kind).toBe('disabled');
    expect(outcome.kind === 'disabled' && outcome.reason).toMatch(/not available/i);
  });

  it('treats a failed capability load as no infrastructure, never as available', () => {
    // Offering Start on a capability that never arrived would promise something unverified.
    const outcome = mockAvailabilityNotice(null, 'openapi', false);
    expect(outcome.kind).toBe('disabled');
  });

  it('renders the panel when the server can mock and the target is mockable', () => {
    expect(mockAvailabilityNotice(CAPABILITY, 'openapi', false)).toEqual({ kind: 'available' });
  });
});

describe('the expiry countdown', () => {
  it('renders minutes and seconds under an hour', () => {
    expect(formatCountdown(1781)).toBe('29:41');
    expect(formatCountdown(61)).toBe('1:01');
    expect(formatCountdown(9)).toBe('0:09');
  });

  it('renders hours when there are any', () => {
    expect(formatCountdown(3723)).toBe('1:02:03');
  });

  it('reads as expired at (and below) zero, and for a non-finite count', () => {
    expect(formatCountdown(0)).toBe('Expired');
    expect(formatCountdown(-30)).toBe('Expired');
    expect(formatCountdown(Number.NaN)).toBe('Expired');
  });

  it('escalates its tone as the mock approaches teardown', () => {
    expect(countdownTone(1800)).toBe('ok');
    expect(countdownTone(COUNTDOWN_WARN_SECONDS)).toBe('warn');
    expect(countdownTone(COUNTDOWN_DANGER_SECONDS)).toBe('danger');
    expect(countdownTone(0)).toBe('danger');
  });

  it('calls an instance live only while it has both an active status and time left', () => {
    expect(mockIsLive(instance())).toBe(true);
    expect(mockIsLive(instance({ status: 'expired' }))).toBe(false);
    expect(mockIsLive(instance({ expiresInSeconds: 0 }))).toBe(false);
    expect(mockIsLive(null)).toBe(false);
  });

  it('summarizes a live instance and an expired one differently', () => {
    expect(describeMockInstance(instance())).toContain('expires in 30:00');
    expect(describeMockInstance(instance({ expiresInSeconds: 0 }))).toContain('expired');
    expect(describeMockInstance(instance({ operationCount: 1 }))).toContain('1 operation)');
  });
});

describe('building a try-it request path', () => {
  it('finds the placeholders a templated path declares, in order and de-duplicated', () => {
    expect(pathParameters('/tenants/{tenantId}/widgets/{widgetId}')).toEqual([
      'tenantId',
      'widgetId',
    ]);
    expect(pathParameters('/widgets')).toEqual([]);
    expect(pathParameters('/a/{id}/b/{id}')).toEqual(['id']);
  });

  it('substitutes the values the user typed', () => {
    expect(buildRequestPath('/widgets/{widgetId}', { widgetId: '42' })).toBe('/widgets/42');
  });

  it('falls back to a usable stand-in rather than sending a literal placeholder', () => {
    expect(buildRequestPath('/widgets/{widgetId}')).toBe('/widgets/1');
    expect(buildRequestPath('/widgets/{widgetId}', { widgetId: '   ' })).toBe('/widgets/1');
  });

  it('percent-encodes a value, so it cannot invent a path segment', () => {
    expect(buildRequestPath('/widgets/{widgetId}', { widgetId: 'a/../b' })).toBe(
      '/widgets/a%2F..%2Fb',
    );
  });

  it('always returns an absolute path', () => {
    expect(buildRequestPath('widgets')).toBe('/widgets');
    expect(buildRequestPath('')).toBe('/');
  });

  it('keys an operation the same way the mock’s request log names it', () => {
    expect(operationKey({ method: 'GET', path: '/widgets/{widgetId}' })).toBe(
      'GET /widgets/{widgetId}',
    );
  });
});

describe('what a request log row says', () => {
  it('states a schema-shaped response in words', () => {
    expect(requestOutcomeLabel(entry())).toBe('Schema-shaped response');
    expect(requestOutcomeTone(entry())).toBe('ok');
  });

  it('flags a body that drifted from the schema as the finding it is', () => {
    const drifted = entry({ schemaValid: false });
    expect(requestOutcomeLabel(drifted)).toBe('Body did not match the schema');
    expect(requestOutcomeTone(drifted)).toBe('danger');
  });

  it('separates "no operation matched" from a schema failure', () => {
    const unmatched = entry({ matched: false, status: 404, schemaValid: null, operationId: null });
    expect(requestOutcomeLabel(unmatched)).toBe('No operation matched');
    expect(requestOutcomeTone(unmatched)).toBe('warn');
  });

  it('claims nothing about a schema when none was checked on a match', () => {
    const unchecked = entry({ schemaValid: null });
    expect(requestOutcomeLabel(unchecked)).toBe('Matched');
    expect(requestOutcomeTone(unchecked)).toBe('ok');
  });

  it('tones a status code by its class', () => {
    expect(statusTone(200)).toBe('ok');
    expect(statusTone(404)).toBe('warn');
    expect(statusTone(429)).toBe('warn');
    expect(statusTone(500)).toBe('danger');
    expect(statusTone(0)).toBe('danger');
  });

  it('renders a timestamp as a clock, and passes an unparseable one through', () => {
    expect(formatLogTime('2026-08-26T14:22:07.000Z')).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(formatLogTime('not-a-date')).toBe('not-a-date');
  });
});
