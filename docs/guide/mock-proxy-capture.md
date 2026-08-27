# Guarded proxy capture and replay (`apiome.mock.capture/v1`)

**Guarded proxy capture** lets a hosted mock forward a request to a *real* upstream, return the
real answer, and keep a redacted copy of the exchange as a reviewable fixture candidate. It turns
"our mock data is nothing like production" into a short recording session — without turning Apiome
into an SSRF pivot or a database full of bearer tokens.

Nothing here is on by default. Capture requires an explicit, expiring, owner-issued grant; it
records only what an allowlist authorizes; it stores only redacted content; and nothing it records
serves traffic until a person reviews and publishes it.

| | |
|---|---|
| Policy format id | `apiome.mock.capture-policy/v1` |
| Capture format id | `apiome.mock.capture/v1` |
| Grant | `PUT /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/capture-policy` |
| Revoke | `DELETE .../mock/capture-policy` |
| Review queue | `GET .../mock/captures` · `POST .../mock/captures/review` |
| Publish | `POST .../mock/captures/publish` |
| Discard | `DELETE .../mock/captures` |
| Permission | `versions:edit` to grant/review/publish, `versions:view` to read |
| Storage | `versions.mock_settings.proxyCapture` (policy) · `apiome.mock_capture_exchange` (records) |
| Producer | `app.mock_capture` (apiome-rest) |
| Consumer | `apiome_mock.capture` + `apiome_mock.capture_store` (apiome-mock ≥ 0.9.0, hosted only) |

---

## The five gates

Every capture passes all five, in order, and stops at the first that refuses.

1. **Opt-in.** A request is proxied only when it carries `X-Mock-Capture: on`. Everything else is
   mocked exactly as before — capture never happens by accident, and never changes how existing
   traffic is served.
2. **Authorization.** The version must hold a live grant (enabled, allowlisted, unexpired) *and*
   the caller must present a valid tenant API key, so every recorded exchange is attributable. A
   request that asks to capture without a grant gets a `403 capture-not-authorized` naming the gate
   that refused — never a silently mocked response.
3. **Allowlist.** The request path is resolved against the policy's upstreams. The joined path is
   normalized (`.`, `..`, duplicate separators) *before* the allowlist check, so traversal in the
   request cannot escape the entry it was built from.
4. **Address policy.** The fetch runs through Apiome's SSRF guard: `http`/`https` only, no
   credentials in the URL, public addresses only, re-validated on every hop, redirects never
   followed, bounded timeout and body size. This one is not configurable per version.
5. **Redaction and re-scan.** The exchange is reduced to a storable record, then the finished
   record is scanned again for credential-shaped content. **Anything still flagged is not stored
   at all.**

## Granting capture

```http
PUT /v1/versions/acme/petstore/9f1c…/mock/capture-policy
```

```jsonc
{
  "enabled": true,
  "acknowledged": true,                       // required: you are permitted to record these upstreams
  "upstreams": ["https://api.example.com/v1"],// the complete set of fetchable base URLs
  "ttlHours": 24,                             // clamped to 168 (7 days)
  "validateResponses": true,                  // check each capture against the declared contract
  "redaction": {
    "headers": ["X-Internal-Trace"],
    "queryParams": ["customer"],
    "bodyFields": ["ssn", "/customer/dateOfBirth"],
    "patterns": ["email"]
  }
}
```

The `authorization` block — who granted capture, when, and when it lapses — is **stamped by the
server** and cannot be supplied by the client. Capture stops on its own when the grant expires;
renew by issuing a new grant.

`GET .../mock/capture-policy` returns the stored policy, its digest, live capture counts by review
state, and a `state` field explaining exactly why capture is or is not running:

| `state` | Meaning |
|---|---|
| `authorized` | Capture is live. |
| `unconfigured` | No policy has ever been set. |
| `disabled` | A policy exists but `enabled` is false. |
| `no-upstreams` | The allowlist is empty. |
| `unauthorized` | No authorization block (a hand-edited policy). |
| `expired` | The grant has lapsed. |

`DELETE .../mock/capture-policy` revokes the grant outright. Already-recorded exchanges are left
alone on purpose: revoking permission to record must not destroy the record of what was recorded.
Discard those explicitly with `DELETE .../mock/captures`.

## Recording

Drive traffic at the mock with the opt-in header and a tenant API key:

```bash
curl -H 'X-Mock-Capture: on' \
     -H 'X-Api-Key: ak_live_…' \
     -H 'Authorization: Bearer <your upstream token>' \
     https://mock.apiome.dev/acme/petstore/1.0.0/pets/7
```

You get the upstream's real answer, plus headers describing what happened to it:

| Header | Meaning |
|---|---|
| `X-Mock-Capture` | `recorded` or `not-recorded` |
| `X-Mock-Capture-Id` | Review-queue id of the stored exchange |
| `X-Mock-Capture-Upstream` | The upstream that answered (query string removed) |
| `X-Mock-Capture-Redactions` | How many values redaction removed |
| `X-Mock-Capture-Reason` | Why an exchange was fetched but not stored |

`X-Mock-Capture-Reason` is one of `credential-scan-failed` (the final scan still saw something
credential-shaped), `review-queue-full` (500 unreviewed captures already), or `store-unavailable`
(the database could not take it). In every case the request itself still succeeds — capture is a
development aid layered on the data plane, never something that can break serving.

Note the shape of the exchange above: the upstream **does** receive your `Authorization` header —
it has to, or the fetch would fail — and that header is precisely what never reaches storage.

## What redaction removes

Four rule families run over every exchange. Every removal is recorded as an RFC 6901 pointer, the
rule that fired, and a sentence explaining it. Redaction **removes**; it never masks, because a
masked secret still leaks its length and shape.

| Family | What it drops | Configurable? |
|---|---|---|
| Always-on headers | `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-amz-security-token`, … | No — a policy can only add |
| Always-on query params | `access_token`, `token`, `api_key`, `key`, `code`, `signature`, … | No — a policy can only add |
| Credential-shaped fields | Any key containing `secret`/`password`/`token`/`apikey`/`privatekey`/…, plus PEM blocks and `Bearer …` values — the same definition portable bundles use | No |
| JWT values | Compact JWTs anywhere they appear | No |
| Policy rules | The header names, query parameters, and body fields this version's owner declared | Yes |
| Pattern detectors | `email`, `phone`, `creditCard`, `nationalId`, `ipv4` | Yes, opt-in per version |

`bodyFields` entries take two forms: a bare name (`ssn`) matches that field at any depth, and an
entry starting with `/` (`/customer/dateOfBirth`) is a **body-relative** RFC 6901 pointer.

Bodies over 64 KiB, and bodies that are not JSON/text, are dropped whole — with a
`body-too-large` or `body-not-textual` decision recorded, so a reviewer sees *why* a body is
missing rather than assuming there was none.

## Reviewing and publishing

`GET .../mock/captures` is the review queue. Each entry carries the provenance of the fetch (which
upstream, which allowlist entry, which operation, which policy digest, when, and under which API
key), the full redaction decision list, and whether the captured response matched the version's
declared contract. Add `?includeExchange=true` to read the full redacted document; the summary
alone is enough to triage.

A capture that does **not** match the contract is still recorded — a real upstream disagreeing with
the spec is exactly what you want to see — but it is flagged rather than quietly published.

```http
POST .../mock/captures/review
{"captureIds": ["…"], "decision": "approve", "note": "matches the staging shape"}

POST .../mock/captures/publish
{"packName": "from-staging", "description": "Recorded 2026-08-26."}
```

Publishing converts **approved** captures into a [fixture pack](mock-fixture-packs.md):

- a successful JSON response whose operation identifies a CRUD collection becomes seed resources
  for that collection (`GET /pets/{petId}` seeds `/pets`);
- anything else becomes named template fixture data;
- anything that could not be converted is reported in `notes` rather than dropped silently.

Publishing is terminal for the captures it consumes: they move to `published` and can no longer be
re-decided, because the pack that carries their provenance would otherwise be left claiming a
source that disowns it.

## Replay says where the data came from

A published pack carries a `provenance` block, and packs that carry one declare fixture pack format
version **2**. (A pack declares the lowest version that can express it, so every pre-existing pack
still declares — and digests as — v1.)

```jsonc
"provenance": {
  "source": "capture",
  "capturedFrom": ["https://api.example.com/v1"],
  "captures": 12,
  "redactions": 37,
  "approvedBy": "…",
  "approvedAt": "2026-08-26T19:00:00Z"
}
```

The runtime reports it back wherever it describes a pack, so a fixture replayed months later still
says what it is:

- `GET /{tenant}/{project}/{version}/__mock__/fixture-packs` — each pack's `origin`
  (`authored` / `capture`), `redactionStatus` (`not-applicable` / `clean` / `redacted`), and full
  `provenance` block;
- `POST .../__mock__/session/reset` — the same fields in the response body, plus
  `X-Mock-Fixture-Origin` and `X-Mock-Fixture-Redaction` headers.

Capture provenance cannot be typed by hand: `PUT .../mock/fixture-packs` refuses a pack claiming
`source: capture` unless it matches what publishing already stored under that name. Editing a
capture-derived pack in the normal editor therefore keeps its provenance; minting a fresh claim is
impossible.

## Deployment

Capture is **hosted-only**. It needs the control-plane database for both the grant and the review
queue, and `proxyCapture` is not a bundled settings key — a portable bundle can neither carry a
grant nor act on one.

| Environment variable | Default | Meaning |
|---|---|---|
| `APIOME_MOCK_CAPTURE_ENABLED` | `false` | Whether this deployment may proxy and record at all |
| `APIOME_MOCK_CAPTURE_ALLOW_PRIVATE_UPSTREAMS` | `false` | Permit loopback/private upstream addresses |
| `APIOME_MOCK_CAPTURE_TIMEOUT_SECONDS` | `10` | Ceiling on one upstream fetch |
| `APIOME_MOCK_CAPTURE_MAX_BODY_BYTES` | `65536` | Largest body a capture stores |
| `APIOME_MOCK_CAPTURE_RETENTION_HOURS` | `168` | How long a recorded exchange survives |

Enabling the deployment flag grants nothing on its own — every capture still needs a live
per-version authorization. Turning it off removes the proxy entirely, so no policy, header, or
stored grant can make that deployment record.

## Retention and audit

Recorded traffic is the one thing here that should never accumulate. Every capture is stored with
an `expires_at`, and `apiome.purge_mock_capture_exchanges()` deletes anything past it; expired rows
are invisible to the API even before they are physically removed. An owner can discard them sooner
with `DELETE .../mock/captures?state=rejected` (or with no filter, for all of them).

Every stored capture also appends an unsampled `mock.capture` row to the tenant's hash-chained
access ledger, carrying the coordinates, the upstream, the policy digest, and the redaction count —
never any captured content. Served traffic (`mock.request`) stays sampled; recording does not,
because "which upstream did this deployment fetch, under whose key" is exactly the question asked
after the fact.
