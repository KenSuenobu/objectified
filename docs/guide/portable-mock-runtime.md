# Portable mock runtime (`apiome mock run` and the official image)

A **portable mock** is a [mock bundle](mock-bundle-format.md) served by the same runtime the hosted
mock uses — on a laptop, in CI, or inside an air-gapped network. There is no database, no control
plane connection, and no tenant credential anywhere in the picture: the bundle is the whole
configuration.

| | |
|---|---|
| CLI | `apiome mock run BUNDLE` |
| Runtime | `apiome-mock run --bundle BUNDLE` (apiome-mock ≥ 0.3.0) |
| Image | `ghcr.io/apiome/apiome-mock` — `linux/amd64`, `linux/arm64` |
| Liveness | `GET /health` |
| Readiness | `GET /ready` |
| Conformance | `apiome-mock selftest` · `apiome-mock conformance --base-url URL` |

Both the CLI and the image execute the **identical runtime**, and both are held to the same
[mock conformance corpus](#conformance) — that is what "portable" is allowed to mean here.

---

## Quick start

Export a bundle for a mock-enabled version, then run it:

```bash
curl -sS -H "Authorization: Bearer $APIOME_TOKEN" \
  "http://localhost:8000/v1/versions/acme-corp/$PROJECT_ID/$VERSION_RECORD_ID/mock/bundle" \
  -o petstore-1.0.0-mock-bundle.json

apiome mock run petstore-1.0.0-mock-bundle.json
```

```
Starting mock (local) at http://127.0.0.1:8775/acme-corp/petstore/1.0.0
  readiness  http://127.0.0.1:8775/ready
  command    apiome-mock run --bundle /home/you/petstore-1.0.0-mock-bundle.json --host 127.0.0.1 --port 8775 --base-path version
```

```bash
curl http://127.0.0.1:8775/acme-corp/petstore/1.0.0/pets
```

`apiome mock run` prefers a locally installed `apiome-mock`, and otherwise launches the official
image. Force either one with `--runtime local` / `--runtime docker`, and preview the exact command
with `--dry-run`.

### Docker directly

```bash
docker run --rm -p 8775:8775 \
  -v "$PWD/petstore-1.0.0-mock-bundle.json:/bundle/mock-bundle.json:ro" \
  ghcr.io/apiome/apiome-mock:latest run
```

The image defaults `APIOME_MOCK_BUNDLE=/bundle/mock-bundle.json` and
`APIOME_MOCK_HTTP_HOST=0.0.0.0`, so mounting a bundle at that path is all `run` needs. The same
image still runs the hosted, database-backed mock as its default command (`serve`).

Build it for every supported architecture:

```bash
apiome-mock/scripts/build-image.sh --push ghcr.io/apiome/apiome-mock:0.3.0
# PLATFORMS=linux/amd64 apiome-mock/scripts/build-image.sh --load apiome-mock:dev   # local testing
```

---

## URL shape

By default the runtime serves the spec under the **hosted URL shape**, so a request that works
against the hosted mock works against the portable one by changing only the host:

```
http://127.0.0.1:8775/{tenant}/{project}/{version}/{spec path}
```

Pass `--base-path root` to serve spec paths directly at `/` instead
(`http://127.0.0.1:8775/pets`). `/health` and `/ready` are reserved in both modes and are never
routed to the spec.

Anything outside the mounted prefix answers `404` as `application/problem+json`, naming the prefix
that *is* mounted.

## Readiness

| Endpoint | Meaning | Codes |
|---|---|---|
| `GET /health` | **Liveness.** The process is up and serving HTTP. | `200` |
| `GET /ready` | **Readiness.** The bundle is verified, compiled, and mounted. | `200`, `503` while starting |

Wait on `/ready`, not `/health`: a bundle that fails verification never reaches ready (the process
exits instead), and `/health` cannot tell you *which* bundle answered.

```json
{
  "status": "ready",
  "runtime": {
    "name": "apiome-mock",
    "version": "0.3.0",
    "mode": "portable",
    "basePath": "version",
    "mount": "/acme-corp/petstore/1.0.0"
  },
  "bundle": {
    "digest": "sha256:90591f2f…",
    "tenant": "acme-corp",
    "project": "petstore",
    "version": "1.0.0",
    "signed": true,
    "operations": 5,
    "scenarios": ["quota-exceeded"],
    "fixtures": []
  }
}
```

`bundle.digest` is the bundle's stable identity — assert it in CI to prove the job ran against the
artifact it thinks it did.

The container image's `HEALTHCHECK` polls `/health`. In a Compose or Kubernetes deployment, wire
`/health` to the liveness probe and `/ready` to the readiness probe.

## Structured logs

Every line on stdout is a single JSON object — including uvicorn's own lifecycle lines — so a log
collector needs exactly one parser. Common keys: `event`, `level`, `timestamp` (ISO-8601 UTC).

| `event` | When | Notable fields |
|---|---|---|
| `portable_runtime_starting` | Before the bundle is loaded | `runtime_version`, `host`, `port`, `config` (secrets redacted), `digest` |
| `portable_runtime_ready` | Application startup complete | `digest`, `tenant`, `project`, `version`, `mount`, `operations`, `scenarios`, `signed` |
| `mock_request` | One per served request | `method`, `path`, `status`, `duration_ms`, `digest` |
| `portable_runtime_stopped` | Application shutdown | `digest` |
| `bundle_invalid` / `bundle_incompatible` | The bundle was rejected at startup | `problems[]` with stable `code`s |

```json
{"method": "GET", "path": "/acme-corp/petstore/1.0.0/pets", "status": 200, "duration_ms": 0.4, "digest": "sha256:90591f2f…", "event": "mock_request", "level": "info", "timestamp": "2026-07-28T03:18:42.876956Z"}
```

Turn the per-request line off with `--no-access-log` (lifecycle events still emit). Raise or lower
verbosity with `--log-level`.

## Configuration

Configuration comes from **declared flags and declared environment variables only**. No
configuration file is read, and no `.env` file is picked up from the working directory — a laptop
and a container given the same flags and environment resolve to identical configuration. A flag
always wins over its environment variable; omitting a flag leaves the environment in charge.

| Flag | Environment variable | Default | Meaning |
|---|---|---|---|
| `--bundle PATH` | `APIOME_MOCK_BUNDLE` | *(none)* | Bundle document to serve. Required. |
| `--host ADDR` | `APIOME_MOCK_HTTP_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address. |
| `--port PORT` | `APIOME_MOCK_HTTP_PORT` | `8775` | TCP port. |
| `--base-path {version,root}` | `APIOME_MOCK_BASE_PATH` | `version` | URL shape (see above). |
| `--require-signature` | `APIOME_MOCK_REQUIRE_SIGNATURE` | `false` | Refuse to start on an unsigned bundle. |
| *(none — env only)* | `APIOME_MOCK_BUNDLE_SECRET` | *(none)* | Shared HMAC secret the signature must verify against. |
| `--log-level LEVEL` | `APIOME_MOCK_LOG_LEVEL` | `INFO` | Structured log level. |
| `--no-access-log` | `APIOME_MOCK_ACCESS_LOG` | `true` | Per-request `mock_request` line. |
| `--session-ttl SECONDS` | `APIOME_MOCK_SESSION_TTL_SECONDS` | `3600` | Sliding TTL for `X-Mock-Session` state. |
| `--session-max-resources COUNT` | `APIOME_MOCK_SESSION_MAX_RESOURCES` | `200` | Resources per session. |
| `--session-max-bytes BYTES` | `APIOME_MOCK_SESSION_MAX_BYTES` | `1048576` | JSON bytes per session. |
| `--session-max-sessions COUNT` | `APIOME_MOCK_SESSION_MAX_SESSIONS` | `10000` | Concurrent sessions. |

The signing secret is deliberately **environment-only**: a value on a command line is readable by
every user on the machine through `ps`. `apiome mock run --runtime docker` forwards it by name
(`--env APIOME_MOCK_BUNDLE_SECRET`), so the value passes through the daemon without ever appearing
in an argument list.

Print exactly what a given invocation resolved to:

```bash
apiome-mock run --bundle ./mock-bundle.json --port 9000 --print-config
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `2` | Configuration error — a missing or invalid flag/environment value. |
| `3` | Bundle verification failed — malformed, tampered, unsigned when required, or credential-bearing. |
| `4` | Bundle is well-formed but incompatible with this runtime version. |
| `5` | Conformance failures. |

Check a bundle before a job depends on it:

```bash
apiome-mock verify --bundle ./mock-bundle.json --json
```

## Conformance

The runtime ships a shared conformance corpus: a declarative set of requests and expected
responses, run against a *running* mock. Passing it is what lets the CLI and the image claim
identical behavior — and it is the corpus a CI action (PMR-3.1) will extend.

```bash
apiome-mock selftest                                    # serve the packaged bundle, run the corpus
docker run --rm ghcr.io/apiome/apiome-mock:latest selftest
apiome-mock conformance --base-url http://127.0.0.1:8775  # run it against a mock you started
```

`selftest` needs no mount, no published port, and no external corpus, so "this image passes the
corpus" is one reproducible command. Both commands exit `5` on any failure and print (or, with
`--json`, emit) the failing case, the reason, and what the case exists to pin down.

The corpus covers example-first responses, path parameters, request validation, `405`/`404`/`406`
handling, forced statuses (`Prefer: code=`), scenarios and scenario sequences, chaos injection and
delay reporting, session-scoped CRUD and its isolation, seeded deterministic synthesis, and the two
operational endpoints.

## What the portable runtime does not do

Everything that is inherently hosted stays hosted, because it needs the control-plane database:

* API-key authentication, private-draft access, per-tenant quotas, and usage accounting;
* gRPC, SSE, and WebSocket transports (the portable runtime serves HTTP);
* live publish invalidation — a bundle is a pin, and re-pinning means exporting a new bundle.

Everything else — routing, request validation, example-first resolution, schema synthesis,
scenarios, chaos, and stateful CRUD — is literally the same code as the hosted runtime.
