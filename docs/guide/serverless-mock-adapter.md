# Serverless mock adapter (`apiome_mock.serverless`)

Some teams deploy a test mock as a short-lived **function** rather than as a long-running service.
The serverless adapter exposes the [portable mock runtime](portable-mock-runtime.md) through the
narrow function interfaces of the supported providers, so a
[mock bundle](mock-bundle-format.md) can be answered by a Lambda, a Cloud Run function, or an
Azure Function — no container, no open port, no idle cost.

| | |
|---|---|
| Runtime | `apiome-mock` ≥ 0.7.0 (the same wheel the CLI and the image use) |
| Providers | `aws-lambda` · `gcp-functions` · `azure-functions` |
| Preflight | `apiome-mock serverless --provider aws-lambda --bundle BUNDLE` |
| Conformance | `apiome-mock serverless --provider aws-lambda --conformance` |
| Configuration | `APIOME_MOCK_*` environment variables only (a function has no command line) |

The adapter adds **no mock semantics of its own**. It builds the same ASGI application
`apiome-mock run` serves and drives it in-process, so routing, validation, scenarios, chaos,
stateful CRUD, fixture packs, `/health`, and `/ready` are literally the same code as the hosted and
CLI runtimes. The whole [conformance corpus](portable-mock-runtime.md#conformance) is run *through
each provider's real event shape* in CI, so that is tested rather than asserted.

---

## Quick start

Export a bundle, put it next to your function, and point the runtime at it.

### AWS Lambda

```
my-function/
├── mock-bundle.json
└── requirements.txt        # apiome-mock==0.7.0
```

| Setting | Value |
|---|---|
| Handler | `apiome_mock.serverless.aws_lambda_handler` |
| `APIOME_MOCK_BUNDLE` | `/var/task/mock-bundle.json` |
| Route | `ANY /{proxy+}` (API Gateway) or a Lambda Function URL |

```bash
curl https://abc123.execute-api.eu-west-1.amazonaws.com/acme-corp/petstore/1.0.0/pets
```

Payload formats **1.0** (REST API, ALB) and **2.0** (HTTP API, Function URLs) are both decoded, and
the response is rendered in whichever format the event arrived in — one handler serves either
wiring.

### Google Cloud Run functions

```python
# main.py
import functions_framework
from apiome_mock.serverless import gcp_functions_handler

@functions_framework.http
def mock(request):
    return gcp_functions_handler(request)
```

```bash
gcloud functions deploy petstore-mock \
  --gen2 --runtime python312 --entry-point mock --trigger-http \
  --set-env-vars APIOME_MOCK_BUNDLE=/workspace/mock-bundle.json
```

### Azure Functions

```python
# function_app.py
import azure.functions as func
from apiome_mock.serverless import azure_functions_handler

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

@app.route(route="{*path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
def mock(req: func.HttpRequest) -> func.HttpResponse:
    return azure_functions_handler(req)
```

### Anything with an ASGI shim

`apiome_mock.serverless.asgi_app()` returns the runtime's ASGI application for the configured
bundle, which skips event translation entirely:

```python
import azure.functions as func
from apiome_mock.serverless import asgi_app

app = func.AsgiFunctionApp(app=asgi_app(), http_auth_level=func.AuthLevel.ANONYMOUS)
```

---

## Configuration

A function has no command line, so every knob comes from the **environment variables declared by
the portable runtime** — the same names, the same defaults, documented in
[portable-mock-runtime.md](portable-mock-runtime.md#configuration). No configuration file and no
`.env` are read.

| Variable | Meaning in a function |
|---|---|
| `APIOME_MOCK_BUNDLE` | Path to the bundle **inside the deployment package**. Required. |
| `APIOME_MOCK_BUNDLE_SECRET` | HMAC secret the bundle signature must verify against. Set it from the provider's secret store; never bake it into the package. |
| `APIOME_MOCK_REQUIRE_SIGNATURE` | Refuse to initialize unless the bundle is signed. |
| `APIOME_MOCK_BASE_PATH` | `version` mirrors the hosted URL shape; `root` serves spec paths at `/`. |
| `APIOME_MOCK_ACCESS_LOG` | `false` turns off the per-invocation `serverless_invocation` line. |
| `APIOME_MOCK_SESSION_*` | Session caps — but read [session state](#session-state) first. |

`APIOME_MOCK_HTTP_HOST` and `APIOME_MOCK_HTTP_PORT` are ignored: nothing binds a socket.

---

## Cold start

The bundle is read, verified, and compiled **once per execution environment**, at import time, and
reused by every warm invocation. What that costs is measured rather than guessed:

* logged as `serverless_cold_start`, with the split between verifying the bundle and starting the
  app;
* returned on **every** response as `X-Apiome-Mock-Cold-Start` (`true` on the invocation that paid
  for it) and `X-Apiome-Mock-Cold-Start-Ms`;
* checked against the provider's published budget by `apiome-mock serverless`.

```
$ apiome-mock serverless --provider aws-lambda --bundle petstore-1.0.0-mock-bundle.json
Serverless preflight: AWS Lambda (aws-lambda)
  handler    apiome_mock.serverless.aws_lambda_handler
  bundle     petstore-1.0.0-mock-bundle.json
  digest     sha256:90591f2f… (signed)
  size       126.4 KiB
  cold start 41 ms
  warm call  0.4 ms
  limits     https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html (read 2026-08-26)
[NOTE   ] bundle-fits-package-budget: The bundle is 126.4 KiB, 0.0% of the 250.0 MiB package budget on AWS Lambda.
[NOTE   ] cold-start-within-budget: Initialization took 41 ms …, 0.4% of the budget. AWS Lambda allows 10s for initialization.
AWS Lambda: ready (0 error(s), 0 warning(s))
```

Preflight actually performs the initialization it reports, so the number is real. `--json` emits
the whole report; exit code **7** means the bundle cannot be deployed as it stands.

Every response also carries `X-Apiome-Mock-Bundle-Digest`. Assert it: a green suite proves nothing
if nobody can tell which artifact answered it.

---

## Published limits

These are the **providers' own** published numbers, kept as data in
`apiome_mock/serverless_providers.py` so the preflight and this table cannot drift apart. Verify
them against the linked page before you rely on one — providers move them.

| | AWS Lambda | Google Cloud Run functions | Azure Functions |
|---|---|---|---|
| Package (uncompressed) | 250 MiB | 500 MiB | 1 GiB |
| Request payload | 10 MiB | 32 MiB | 100 MiB |
| Response payload | 6 MiB | 32 MiB | 100 MiB |
| Function timeout | 900 s | 3600 s | 600 s |
| Front-door timeout | **29 s** | 3600 s | **230 s** |
| Metered init budget | **10 s** | — (charged to the first request) | — (charged to the first request) |
| Limits page | [docs](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) | [docs](https://cloud.google.com/functions/quotas) | [docs](https://learn.microsoft.com/azure/azure-functions/functions-scale#service-limits) |

Two of these bite in practice:

**The front-door timeout, not the function timeout, is your deadline.** An API Gateway integration
gives up at 29 s however generous the Lambda's own 900 s is. A [chaos](portable-mock-runtime.md)
delay has to stay inside it.

**The package budget is shared.** The runtime and its dependencies live in the same package as the
bundle, so preflight warns once the bundle alone passes a quarter of the limit.

Payloads outside the limits are refused by the adapter as `application/problem+json` —
`413` for a request, `502` for a response — rather than truncated by the provider into something
that looks like a mock bug:

```json
{
  "type": "https://apiome.dev/problems/serverless-response-too-large",
  "title": "Bad Gateway",
  "status": 502,
  "detail": "The mock response is 7340032 bytes; AWS Lambda returns at most 6291456 bytes from a function.",
  "maxResponseBytes": 6291456
}
```

---

## Session state

`X-Mock-Session` state lives in the **execution environment's memory**. It survives warm
invocations on one instance and is absent on a cold one, and a provider that scales out will route
the next request to an instance that has never seen the session.

That is a property of function environments, not a defect — so plan around it:

* **Seed, don't accumulate.** Reset a session to a [fixture pack](mock-fixture-packs.md) at the
  start of a test (`POST …/__mock__/session/reset`) instead of relying on a resource an earlier
  request created.
* **Stateless assertions are portable.** Example-first responses, schema synthesis, scenarios,
  declarative rules, and chaos are all deterministic from the bundle alone and behave identically
  on every instance.
* **Need durable state?** Run the [container runtime](portable-mock-runtime.md) instead. One
  process, one session store.

Concurrency is serialized: an instance answers one invocation at a time. Where a provider allows
more than one concurrent request per instance (Cloud Run functions), raise the instance count
rather than the concurrency.

---

## No provider secret in the bundle

A bundle already [drops and re-checks credential-shaped content](mock-bundle-format.md) at export
and at load. The adapter adds a provider-specific layer on top, **before** the bundle is compiled:

| Code | What it catches |
|---|---|
| `aws-access-key-id` | `AKIA…` / `ASIA…` access key ids |
| `gcp-service-account-key` | a service-account key document, embedded as text *or* as structure |
| `gcp-api-key` | `AIza…` API keys |
| `azure-shared-key` | storage connection strings and shared access keys |
| `private-key-block` | PEM private key blocks |

Fixtures travel base64-encoded, so they are re-scanned after decoding rather than trusted for
having been unreadable. A bundle carrying any of these cannot be loaded at all, and preflight
reports it with a JSON pointer to the offending field:

```
[ERROR  ] provider-secret-aws-access-key-id: An AWS access key id (AKIA…/ASIA…) is embedded in the
          bundle. Remove it from /spec/info/description and re-export the bundle.
```

The bundle signing secret is read from `APIOME_MOCK_BUNDLE_SECRET` and nowhere else — never from
the event, and never from the bundle. Put it in the provider's secret store (Secrets Manager,
Secret Manager, Key Vault) and reference it as an environment variable, so it is not in the
deployment package a reader can download.

---

## Proving an invocation is faithful

`--conformance` runs the shared corpus through the provider's own event shape against the bundle
packaged with the runtime, which proves what an in-process call cannot: that the **translation** is
faithful, and therefore that a function invocation answers a bundle exactly as every other runtime
does.

```bash
apiome-mock serverless --provider aws-lambda --conformance
```

```
Conformance through AWS Lambda events:
[PASS] scenario-sequences-advance-per-session
…
30/30 conformance cases passed
```

Exit codes match the rest of the portable CLI: `0` success, `2` configuration, `3` invalid bundle,
`4` incompatible bundle, `5` conformance failure, `7` preflight failure.

---

## Structured logs

Every line is one JSON object, as in the served runtime.

| `event` | When | Notable fields |
|---|---|---|
| `serverless_cold_start` | Once per execution environment | `runtime`, `mount`, `coldStart`, `bundle` |
| `serverless_invocation` | One per invocation | `method`, `path`, `status`, `duration_ms`, `cold_start`, `remaining_ms`, `digest` |
| `serverless_response_too_large` | A response exceeded the provider's payload limit | `provider`, `bytes`, `limit`, `path` |

`remaining_ms` is the provider's own countdown when it reports one (AWS Lambda's
`get_remaining_time_in_millis`). It is logged and never acted on: a mock that behaved differently
near its deadline would not be deterministic.

---

## What the serverless adapter does not do

Everything the [portable runtime does not do](portable-mock-runtime.md#what-the-portable-runtime-does-not-do)
applies here too — plus:

* **Durable sessions.** See [session state](#session-state).
* **Streaming responses.** An invocation returns one buffered payload.
* **gRPC, SSE, and WebSocket.** HTTP only, as in the portable runtime.
* **Fetching a bundle at initialization.** The bundle ships inside the package. A network read at
  cold start is what turns a fast mock into a flaky one.
