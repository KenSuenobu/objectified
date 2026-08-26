# Mock callbacks and webhooks (`apiome.mock.callback/v1`)

A mock that only answers inbound requests exercises half a contract. A **callback definition**
covers the other half: the callbacks and webhooks a provider promises to *send*. It tells the
mock runtime what to send, where it is allowed to send it, what the payload must look like, and
how to retry — so a consumer can drive its own webhook handler against a pinned contract instead
of hand-rolling a fake producer.

| | |
|---|---|
| Format id | `apiome.mock.callback/v1` |
| Author | `PUT /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/callbacks` |
| Inspect | `GET /v1/versions/{tenant}/{project_id}/{version_record_id}/mock/callbacks` |
| Permission | `versions:edit` to save, `versions:view` to read |
| Storage | `versions.mock_settings.callbacks` (travels inside portable bundles) |
| Producer | `app.mock_callbacks` (apiome-rest) |
| Consumer | `apiome_mock.callbacks` + `apiome_mock.callback_dispatch` (apiome-mock ≥ 0.8.0) |

---

## Definition shape

```jsonc
{
  "callbacks": {
    "order-created": {                              // name: [A-Za-z0-9][A-Za-z0-9._-]{0,63}
      "callbackFormat": "apiome.mock.callback/v1",  // optional; defaults to the current format
      "callbackFormatVersion": 1,                   // optional; defaults to the current version
      "description": "Order created.",              // optional, ≤ 500 chars
      "trigger": {                                  // optional; omit for trigger-on-demand only
        "operation": "POST /orders",                // must exist in this version's spec
        "statuses": [201]                           // optional; omit to fire on any 2xx
      },
      "destinations": [                             // REQUIRED allowlist, 1-10 absolute URLs
        "https://hooks.example.com/orders"
      ],
      "request": {                                  // optional; the outbound message
        "method": "POST",                           // POST (default), PUT, PATCH, DELETE, GET
        "headers": {"X-Event": "order.created"},    // values may embed {{ ... }} templates
        "body": {                                   // the payload; templates render per delivery
          "event": "order.created",
          "id": "{{request.body#/id}}",
          "sample": "{{fixture.orderEvent}}"
        }
      },
      "payloadSchema": {                            // optional; inline schema or a local $ref
        "$ref": "#/components/schemas/OrderEvent"
      },
      "retry": {                                    // optional; defaults shown
        "maxAttempts": 3,                           // 1-10, the first attempt included
        "backoffMs": 100,                           // 0-60000
        "backoffMultiplier": 2.0,                   // 1.0-10.0, applied per retry
        "retryOn": [408, 425, 429, 500, 502, 503, 504],
        "timeoutMs": 5000                           // 1-30000, per attempt
      }
    }
  }
}
```

Limits: 20 callbacks per version, 64 KiB canonical JSON per definition, 10 destinations, 20
headers, and 10 trigger/`retryOn` statuses. A definition's retry schedule must also fit a **60 s
worst case** — every attempt's timeout plus every backoff — because deliveries are awaited before
the triggering response returns; a schedule that could exceed it is rejected on save rather than
truncated at delivery time, which would make the timeline non-deterministic.
Unknown keys, a trigger naming an operation the spec does not have, an unresolvable
`payloadSchema` `$ref`, a malformed template, and a destination that is not a safe absolute
`http`/`https` URL all fail validation with a 422 listing every error.

Payload and header templates are the same bounded language scenario responses use — see
[Declarative matching and templates](../../apiome-mock/README.md#declarative-matching-and-templates-pmr-21).
Fixture data (`{{fixture.<name>}}`) comes from the version's flat `fixtures` map and from
[fixture packs](mock-fixture-packs.md), so an event body can be driven by the same reviewable
seed data as the rest of a test.

## Versioning and digests

Every definition declares `callbackFormat` and `callbackFormatVersion`. A breaking layout change
mints `/v2`; additive optional fields bump the version, and a runtime **skips** definitions whose
version it does not support rather than misreading them.

A definition's **digest** is `sha256:<hex>` over the canonical JSON of its canonicalized document.
Canonicalization normalizes destinations (lower-case scheme and host, default port dropped, no
trailing slash, no query or fragment), upper-cases the method and the trigger's operation key, and
drops unknown keys — so cosmetic differences never change the digest. The digest is returned on
save, listed by the runtime's `__mock__/callbacks` endpoint, and carried on every delivery record,
so a test can pin exactly which callback contract it exercised.

## What a delivery does

Every delivery runs four gates, in order, and stops at the first that fails:

1. **Render.** Payload and header templates render with seeded randomness (`__seed`), so the same
   event and seed produce byte-identical output.
2. **Validate.** The rendered payload is checked against `payloadSchema`. A payload that does not
   validate is *never* delivered — the mock refuses to teach a consumer a shape the contract does
   not promise. Outcome: `invalid-payload`.
3. **Authorize.** The target must match a `destinations` entry *and* satisfy the deployment's
   outbound network policy. Outcome: `rejected`.
4. **Deliver.** Attempts follow the retry schedule. Outcome: `delivered` (a 2xx/3xx on the final
   attempt) or `failed`.

Two more outcomes cover the edges: `render-failed` when a payload template exhausts its render
budget, and `error` when delivery faults unexpectedly. Neither ever fails the *mocked* response —
the inbound answer is already correct, and a callback problem is reported as a callback outcome.

Deliveries are awaited before the triggering response is returned, so the response header
`X-Mock-Callback: order-created=delivered` reports what actually happened and a test never has to
poll. Each outbound request carries `X-Mock-Callback: <name>` and `X-Mock-Callback-Attempt: <n>`,
so a receiver can tell a retry from a fresh event.

### Authorized destinations

`destinations` is an allowlist, not a hint. A target is authorized when, after normalization, it
shares an entry's scheme, host, and port and its path is that entry's path or a descendant at a
segment boundary:

| Entry | Authorizes | Refuses |
|---|---|---|
| `https://hooks.example.com/orders` | `…/orders`, `…/orders/42`, `…/orders?token=x` | `…/orders-archive`, `…/`, `http://…`, `https://hooks.example.com:8443/orders` |
| `https://hooks.example.com/` | anything on that origin | any other origin |

A consumer chooses among authorized targets with the `X-Mock-Callback-Url` request header (or
`destination` in an explicit trigger); with neither, the first entry is used. Naming a destination
is a choice among authorized ones — never a way to add one.

On top of the allowlist, every target is vetted by the shared SSRF policy: `http`/`https` only, no
credentials in the URL, and every resolved address must be public. That second check is what stops
an allowlisted-but-internal address (`http://169.254.169.254/…`) from turning the mock into a
confused deputy. Redirects are never followed — chasing one would deliver to a URL no entry
authorized. A deployment whose receiver legitimately runs beside it (a CI job's own listener) opts
into private targets explicitly with `--callback-allow-private`.

### Deterministic retries

The delay before each retry is `backoffMs × backoffMultiplier ⁿ`, truncated to whole milliseconds.
There is **no jitter and no clock input**, so the schedule is a pure function of the stored
definition: replaying the same fixture-driven event always produces the same attempt timeline, and
a test asserts the exact sequence rather than a tolerance band. With the defaults, a callback whose
receiver answers `503` twice is attempted at 0 ms, 100 ms, and 300 ms and then gives up.

## Control endpoints

Every mock version reserves the `__mock__` path segment for the runtime's control plane, under the
same version prefix as the mocked API — identically on the hosted runtime and the portable one.

### `GET …/{version}/__mock__/callbacks`

Lists the version's definitions and whether this deployment delivers at all. Header *names* travel;
their (possibly templated, possibly secret-bearing) values do not.

```json
{
  "enabled": true,
  "allowPrivateDestinations": false,
  "callbacks": [
    {
      "name": "order-created",
      "description": "Order created.",
      "digest": "sha256:…",
      "callbackFormat": "apiome.mock.callback/v1",
      "callbackFormatVersion": 1,
      "trigger": {"operation": "POST /orders", "statuses": [201]},
      "destinations": ["https://hooks.example.com/orders"],
      "method": "POST",
      "headers": ["X-Event"],
      "hasPayloadSchema": true,
      "retry": {"maxAttempts": 3, "delaysMs": [100, 200], "retryOn": [503], "timeoutMs": 5000}
    }
  ]
}
```

### `POST …/{version}/__mock__/callbacks/{name}/trigger`

Delivers one callback now, without driving its triggering operation. Every body field is optional:
`destination` (must be allowlisted), `payload` (replaces the template — still schema-validated),
and `seed` (makes a templated payload reproducible).

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"destination": "https://hooks.example.com/orders/tenant-a", "seed": 7}' \
  "$MOCK/demo/orders/1.0.0/__mock__/callbacks/order-created/trigger"
```

The response is the delivery record. The trigger itself fails only on caller errors: 400
`unknown-callback` (with `availableCallbacks`), 403 `destination-not-allowed` (with
`allowedDestinations`), 503 `callbacks-disabled`.

### `GET …/{version}/__mock__/callbacks/deliveries`

The runtime's recent delivery records — every attempt, its scheduled delay, and its outcome.
Optional `callback=<name>` and `limit=<n>` narrow the list. This is the assertable form of
"delivery outcome is visible in mock logs": the same facts the `mock_callback_attempt` and
`mock_callback_delivery` log lines carry, in a shape a test can read back.

```json
{
  "enabled": true,
  "deliveries": [
    {
      "id": "delivery-1",
      "callback": "order-created",
      "digest": "sha256:…",
      "outcome": "delivered",
      "detail": "Destination accepted the callback with 200.",
      "destination": "https://hooks.example.com/orders",
      "method": "POST",
      "trigger": "POST /orders",
      "status": 200,
      "session": "ci-42",
      "attempts": [
        {"attempt": 1, "delayMs": 0, "status": 503, "error": null, "durationMs": 1.9},
        {"attempt": 2, "delayMs": 100, "status": 200, "error": null, "durationMs": 1.4}
      ]
    }
  ]
}
```

Records and log lines carry the destination's origin and path but **never** its query string,
never header values, and never the payload — a webhook URL routinely carries a token in its query,
and a mock must not be the thing that writes it to a CI log. The log is in-memory and bounded (100
records), so observability never becomes a place data accumulates.

## Enabling delivery

Outbound delivery is **off by default** in both runtimes: a mock makes no network connections
unless it is told to.

| Runtime | Enable | Private destinations | Attempt ceiling |
|---|---|---|---|
| Portable (`apiome-mock run`) | `--callbacks` / `APIOME_MOCK_CALLBACKS_ENABLED` | `--callback-allow-private` | `--callback-timeout SECONDS` |
| Hosted (`apiome-mock serve`) | `APIOME_MOCK_CALLBACKS_ENABLED` | `APIOME_MOCK_CALLBACK_ALLOW_PRIVATE` | `APIOME_MOCK_CALLBACK_TIMEOUT_SECONDS` |

A deployment with delivery disabled still *lists* its definitions (marked `"enabled": false`), so a
consumer can see the outbound contract without the mock being able to act on it.

## In CI (portable runtime)

Definitions travel inside the portable bundle's settings — they are part of the manifest's settings
digest and are credential-scanned like every bundled setting — so a pinned bundle carries its
outbound contract with it:

```bash
# a webhook receiver the test owns, on loopback
python -m http.server 9000 &

apiome-mock run --bundle orders-1.0.0-mock-bundle.json \
  --callbacks --callback-allow-private &

curl -X POST -H "Content-Type: application/json" \
  -H "X-Mock-Callback-Url: http://127.0.0.1:9000/hook" \
  -d '{"id": "order-9"}' "http://127.0.0.1:8775/demo/orders/1.0.0/orders"
# -> 201, X-Mock-Callback: order-created=delivered

curl "http://127.0.0.1:8775/demo/orders/1.0.0/__mock__/callbacks/deliveries"
```

The receiver's URL still has to be allowlisted in the definition — `--callback-allow-private` only
lifts the public-address rule, never the allowlist.

Related guides: [mock-fixture-packs.md](mock-fixture-packs.md),
[mock-bundle-format.md](mock-bundle-format.md),
[portable-mock-runtime.md](portable-mock-runtime.md).
