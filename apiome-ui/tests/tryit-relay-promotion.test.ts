/**
 * The promoted Try-It relay's shared seam — DWX-4.2 (private-suite#2691).
 *
 * `lib/tryit/relay.ts` and `lib/tryit/send.ts` moved here from `apiome-browse` so the designer's
 * Try-It console enforces the same SSRF policy rather than a second copy of it. The policy itself
 * is covered — 85 cases of it — by Browse's `lib/tryit/__tests__/relay.test.ts`, which runs against
 * this module through a re-export and was not touched by the promotion; that suite staying green is
 * the ticket's "no behaviour change" criterion and this file deliberately does not restate it.
 *
 * What is new is the *seam* the promotion added, and it is what these cases cover: an application
 * names the version a request belongs to in its own vocabulary, and mounts its relay at its own
 * path. Both are parameters with Browse's value as the default, so the two questions worth asking
 * are "does the default still behave exactly as Browse's did?" and "can a second application
 * substitute its own without reaching any other part of the envelope?".
 *
 * @jest-environment node
 */

import {
  executeRelay,
  isRelaySlug,
  MAX_SLUG_LENGTH,
  parseRelayEnvelope,
  parseRelaySlugContext,
  type RelayContextParser,
  type RelayHttpResponse,
  type RelayPolicy,
} from '@lib/tryit/relay';
import { DEFAULT_RELAY_PATH, sendTryIt, TryItSendError } from '@lib/tryit/send';

/** How the designer names a version: record ids, resolved against the session's own tenant. */
interface StudioContext {
  projectId: string;
  versionId: string;
}

/** A second application's context parser, in the shape the designer's BFF supplies one. */
const parseStudioContext: RelayContextParser<StudioContext> = (raw) => {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, detail: 'The relay request needs a studio context.' };
  }
  const { projectId, versionId } = raw as Record<string, unknown>;
  if (!isRelaySlug(projectId) || !isRelaySlug(versionId)) {
    return { ok: false, detail: 'The relay request needs context project and version ids.' };
  }
  return { ok: true, context: { projectId, versionId } };
};

/**
 * A valid relay envelope, overridable per case.
 *
 * @param over - Fields to replace.
 * @returns The raw JSON body a browser would post.
 */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://api.example.com/pets/42',
    method: 'GET',
    headers: {},
    body: null,
    target: { kind: 'custom', customHostConfirmed: true },
    context: { tenantSlug: 'acme', projectSlug: 'petstore', versionSlug: '1.2' },
    ...over,
  };
}

const openPolicy: RelayPolicy = { mockOrigin: null, specOrigins: [] };

/**
 * Wrap body text as the async-iterable stream shape the relay reads.
 *
 * @param text - The body text.
 * @returns A one-chunk stream.
 */
function bodyStream(text: string): RelayHttpResponse['body'] {
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text);
    },
  };
}

describe('the default relay context is still Browse’s', () => {
  it('accepts the public slug triple with no parser argument', () => {
    const parsed = parseRelayEnvelope(envelope());

    expect(parsed).toMatchObject({
      ok: true,
      request: { context: { tenantSlug: 'acme', projectSlug: 'petstore', versionSlug: '1.2' } },
    });
  });

  it('refuses a partial triple, exactly as before the promotion', () => {
    expect(parseRelayEnvelope(envelope({ context: {} }))).toMatchObject({ ok: false });
    expect(
      parseRelayEnvelope(envelope({ context: { tenantSlug: 'a', projectSlug: 'b' } }))
    ).toMatchObject({ ok: false });
  });

  it('is the same function the module exports for a caller to compose', () => {
    expect(parseRelaySlugContext({ tenantSlug: 'a', projectSlug: 'b', versionSlug: 'c' })).toEqual({
      ok: true,
      context: { tenantSlug: 'a', projectSlug: 'b', versionSlug: 'c' },
    });
    expect(parseRelaySlugContext(null)).toMatchObject({ ok: false });
  });
});

describe('a second application substitutes its own context', () => {
  it('parses its identifiers and carries them through verbatim', () => {
    const parsed = parseRelayEnvelope(
      envelope({ context: { projectId: 'proj-1', versionId: 'ver-1' } }),
      parseStudioContext
    );

    expect(parsed).toEqual({
      ok: true,
      request: {
        url: 'https://api.example.com/pets/42',
        method: 'GET',
        headers: {},
        body: null,
        target: { kind: 'custom', customHostConfirmed: true },
        context: { projectId: 'proj-1', versionId: 'ver-1' },
      },
    });
  });

  it('surfaces its own refusal wording for a context it cannot read', () => {
    const parsed = parseRelayEnvelope(envelope({ context: { projectId: 'proj-1' } }), parseStudioContext);

    expect(parsed).toEqual({
      ok: false,
      detail: 'The relay request needs context project and version ids.',
    });
  });

  it('does not loosen anything else about the envelope', () => {
    const studio = { projectId: 'proj-1', versionId: 'ver-1' };

    // Every one of these is refused by the shared rules, whichever context is in use.
    expect(parseRelayEnvelope(envelope({ context: studio, url: '/pets' }), parseStudioContext)).toMatchObject({ ok: false });
    expect(parseRelayEnvelope(envelope({ context: studio, method: 'CONNECT' }), parseStudioContext)).toMatchObject({ ok: false });
    expect(
      parseRelayEnvelope(
        envelope({ context: studio, headers: { 'X-Bad': 'a\r\nHost: evil' } }),
        parseStudioContext
      )
    ).toMatchObject({ ok: false });
    expect(
      parseRelayEnvelope(envelope({ context: studio, target: { kind: 'custom' } }), parseStudioContext)
    ).toMatchObject({ ok: true }); // unconfirmed is a *policy* refusal, not an envelope one
  });

  it('bounds its identifiers with the module’s own limit rather than a second one', () => {
    expect(isRelaySlug('ver-1')).toBe(true);
    expect(isRelaySlug('')).toBe(false);
    expect(isRelaySlug('x'.repeat(MAX_SLUG_LENGTH))).toBe(true);
    expect(isRelaySlug('x'.repeat(MAX_SLUG_LENGTH + 1))).toBe(false);
    expect(isRelaySlug(42)).toBe(false);
  });

  it('relays with a context the exchange never reads', async () => {
    const parsed = parseRelayEnvelope(
      envelope({ context: { projectId: 'proj-1', versionId: 'ver-1' } }),
      parseStudioContext
    );
    if (!parsed.ok) throw new Error(parsed.detail);

    const outcome = await executeRelay(parsed.request, openPolicy, {
      httpRequest: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: bodyStream('ok'),
      }),
      resolve: async () => ['93.184.216.34'],
    });

    expect(outcome).toMatchObject({ kind: 'response', envelope: { status: 200, body: 'ok' } });
  });
});

describe('the relay path is the hosting application’s', () => {
  /** The last request the stubbed fetch saw. */
  let seen: { url: string; body: unknown };

  /**
   * A fetch stub answering one relay envelope and recording the call.
   *
   * @param status - The relay's HTTP status.
   * @returns The stub.
   */
  function fetchStub(status = 200): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        json: async () => ({ status: 200, body: 'relayed', headers: {} }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const request = {
    method: 'GET',
    url: 'https://api.example.com/pets',
    headers: {},
    body: null,
    target: { kind: 'custom' as const, customHostConfirmed: true },
    context: { projectId: 'proj-1', versionId: 'ver-1' },
  };

  it('posts to Browse’s path when none is configured', async () => {
    await sendTryIt(request, { pageOrigin: 'https://browse.example', fetchImpl: fetchStub() });

    expect(seen.url).toBe(DEFAULT_RELAY_PATH);
    expect(DEFAULT_RELAY_PATH).toBe('/api/try-it');
  });

  it('posts to the designer’s BFF path when one is, with the same envelope', async () => {
    const result = await sendTryIt(request, {
      pageOrigin: 'https://studio.example',
      fetchImpl: fetchStub(),
      relayPath: '/api/workspace/try-it',
    });

    expect(seen.url).toBe('/api/workspace/try-it');
    expect(seen.body).toEqual({
      url: 'https://api.example.com/pets',
      method: 'GET',
      headers: {},
      body: null,
      target: { kind: 'custom', customHostConfirmed: true },
      context: { projectId: 'proj-1', versionId: 'ver-1' },
    });
    expect(result).toMatchObject({ status: 200, bodyText: 'relayed', via: 'proxy' });
  });

  it('names the configured path when the relay is not deployed', async () => {
    await expect(
      sendTryIt(request, {
        pageOrigin: 'https://studio.example',
        fetchImpl: fetchStub(404),
        relayPath: '/api/workspace/try-it',
      })
    ).rejects.toMatchObject({
      kind: 'proxy-unavailable',
      message: expect.stringContaining('/api/workspace/try-it'),
    });
  });

  it('still raises the shared error type, so one viewer phrases both applications', async () => {
    await expect(
      sendTryIt(
        { ...request, url: 'not-a-url' },
        { pageOrigin: 'https://studio.example', fetchImpl: fetchStub() }
      )
    ).rejects.toBeInstanceOf(TryItSendError);
  });
});
