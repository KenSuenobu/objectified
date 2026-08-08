/**
 * The promoted Try-It snippet and example helpers — DWX-4.7 (private-suite#2696).
 *
 * `lib/tryit/snippet.ts` and `lib/tryit/examples.ts` moved here from `apiome-browse` so the
 * designer's Try-It console and its inspector Quick actions grid render one command per request
 * rather than two that agree by coincidence. The renderers themselves are covered — 30 cases of
 * them — by Browse's `lib/tryit/__tests__/snippet.test.ts` and `examples.test.ts`, which run
 * against these modules through a re-export and were not touched by the promotion; that suite
 * staying green is the "no behaviour change" half of the move and this file deliberately does not
 * restate it.
 *
 * What is new is the *caller*, and that is what these cases cover. Browse always reaches the
 * renderer through `buildSnippetRequest`, which composes a request from its own panel state. The
 * studio cannot: it renders cookie parameters Browse's `ParamSpec` has no location for, and adds
 * mock-runtime headers Browse never sends, so it composes its own request and hands over a
 * finished {@link SnippetRequest}. These are the two questions that raises — does a
 * self-composed request render identically to a Browse-composed one, and does credential
 * redaction still apply to a caller that never went through the composer?
 */

import { collectBodyExamples, formatBodyForEditor } from '@lib/tryit/examples';
import {
  buildSnippetRequest,
  generateSnippet,
  type SnippetRequest,
} from '@lib/tryit/snippet';

/** A request composed the way the designer's console composes one: finished, by hand. */
const composed: SnippetRequest = {
  method: 'PATCH',
  url: 'https://mock.test/acme/billing/1.4.0/customers/cust_01HZ',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: '{"email":"new@acme.io"}',
};

describe('a second application composes its own request', () => {
  it('renders it identically to one the Browse composer built', () => {
    const viaComposer = buildSnippetRequest({
      method: 'PATCH',
      serverUrl: 'https://mock.test/acme/billing/1.4.0',
      path: '/customers/{id}',
      params: [
        { name: 'id', location: 'path', required: true, schema: { type: 'string' } },
        { name: 'Accept', location: 'header', required: false, schema: { type: 'string' } },
      ],
      values: { 'path:id': 'cust_01HZ', 'header:Accept': 'application/json' },
      extraHeaders: [],
      body: '{"email":"new@acme.io"}',
      contentType: 'application/json',
    });

    expect(viaComposer).toEqual(composed);
    for (const target of ['curl', 'fetch', 'httpx'] as const) {
      expect(generateSnippet(target, composed)).toBe(generateSnippet(target, viaComposer));
    }
  });

  it('renders all three targets from the finished request alone', () => {
    expect(generateSnippet('curl', composed)).toBe(
      "curl -X PATCH 'https://mock.test/acme/billing/1.4.0/customers/cust_01HZ' " +
        "-H 'Accept: application/json' -H 'Content-Type: application/json' " +
        `--data-raw '{"email":"new@acme.io"}'`
    );
    expect(generateSnippet('fetch', composed)).toContain("  method: 'PATCH',");
    expect(generateSnippet('httpx', composed)).toContain('import httpx');
  });

  it('carries a header the runtime reads without treating it as anything special', () => {
    // The studio sends `X-Mock-Scenario` and `Prefer: code=` for the hosted mock. Neither is a
    // credential and neither is composed by this module — they arrive as headers like any other,
    // and the snippet must reproduce them or it would not reproduce the request.
    const withScenario: SnippetRequest = {
      ...composed,
      headers: { ...composed.headers, 'X-Mock-Scenario': 'quota-exceeded', Prefer: 'code=429' },
    };

    expect(generateSnippet('curl', withScenario)).toContain(
      "-H 'X-Mock-Scenario: quota-exceeded' -H 'Prefer: code=429'"
    );
  });
});

describe('credential redaction reaches the self-composed caller too', () => {
  it('replaces an inferred credential header without being asked', () => {
    const authed: SnippetRequest = {
      ...composed,
      headers: { ...composed.headers, Authorization: 'Bearer eyJhbGciOi.real.token' },
    };

    const snippet = generateSnippet('curl', authed);

    expect(snippet).toContain("-H 'Authorization: $AUTHORIZATION'");
    expect(snippet).not.toContain('eyJhbGciOi.real.token');
  });

  it('replaces a scheme-named header the inference cannot know about', () => {
    // An `apiKey` scheme may name any header it likes; only the application holding the version's
    // security schemes knows which one, so it supplies the placeholder explicitly.
    const authed: SnippetRequest = {
      ...composed,
      headers: { ...composed.headers, 'X-Acme-Portal-Key': 'live_secret_value' },
    };

    const snippet = generateSnippet('curl', authed, { 'x-acme-portal-key': '$API_KEY' });

    expect(snippet).toContain("-H 'X-Acme-Portal-Key: $API_KEY'");
    expect(snippet).not.toContain('live_secret_value');
  });

  it('replaces a credential carried in the query string', () => {
    const authed: SnippetRequest = {
      ...composed,
      url: 'https://mock.test/acme/billing/1.4.0/customers?api_key=live_secret_value',
    };

    const snippet = generateSnippet('httpx', authed);

    expect(snippet).toContain('api_key=%24API_KEY');
    expect(snippet).not.toContain('live_secret_value');
  });
});

describe('the promoted example helpers', () => {
  it('read the OpenAPI order and invent nothing for a variant that declares none', () => {
    expect(
      collectBodyExamples({
        contentType: 'application/json',
        examples: { rename: { summary: 'Rename', value: { email: 'new@acme.io' } } },
        example: { email: 'lone@acme.io' },
      })
    ).toEqual([
      { name: 'rename', summary: 'Rename', value: { email: 'new@acme.io' } },
      { name: 'example', value: { email: 'lone@acme.io' } },
    ]);

    expect(collectBodyExamples({ contentType: 'application/json' })).toEqual([]);
  });

  it('formats a payload for an editor by media type, not by guesswork', () => {
    expect(formatBodyForEditor({ email: 'new@acme.io' }, true)).toBe(
      '{\n  "email": "new@acme.io"\n}'
    );
    expect(formatBodyForEditor('plain text', false)).toBe('plain text');
    expect(formatBodyForEditor(undefined, true)).toBe('');
  });
});
