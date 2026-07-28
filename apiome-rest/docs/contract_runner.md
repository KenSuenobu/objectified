# HTTP Contract Runner (ECA-2.1)

> apiome#4732 — the first half of Executable Contract Assurance Epic 2 (parent #4943 / umbrella #4941).
> Consumes ECA-1.1 (#4729) suites, ECA-1.2 (#4730) targets, and always writes ECA-1.3 (#4731) evidence.
> Blocks ECA-2.2 (`apiome verify contract`) and feeds ECA-3.1 policy evaluation.

## Why

A compiled suite and a registered target are inert until something **executes** the cases, judges
the responses, and leaves evidence a gate can cite. Without a bounded runner:

* CI invents ad-hoc curl scripts with inconsistent timeouts and no SSRF guard;
* a flaky retry can turn a real contract failure into a green build;
* there is no durable record of which suite digest ran against which target.

The runner closes that gap inside `apiome-rest`.

## Modules

| Module | Role |
|---|---|
| `app/contract_runner.py` | Pure execution: build requests, honour policy, assert status/schema, transport-only retries. |
| `app/contract_runner_service.py` | Compile → resolve → run → `record_run`. |
| `app/contract_runner_routes.py` | `POST /v1/tenants/{tenant}/contracts/{version_ref}/run`. |
| `app/ssrf_guard.build_guarded_client(allow_private=…)` | Private-network targets (e.g. localhost mock) skip public-IP filtering but keep scheme/credential rules. |

## Endpoint

```
POST /v1/tenants/{tenant_slug}/contracts/{version_ref}/run
```

Body:

```json
{
  "target_ref": "mock",
  "options": {},
  "idempotency_key": "ci-build-42",
  "context": { "commit": "abc123", "branch": "main" }
}
```

Permissions: `versions:view` **and** `verification_evidence:create`. Target selection is audited via
the existing resolve path.

* **201** — new evidence was written (`created: true`).
* **200** — idempotent replay, or `ok: false` with a taxonomy `error` (no executable cases, auth
  unavailable, compile refusal).
* **400/404/422** — addressing or target faults.

## Policy the runner honours

From the ECA-1.2 target `VerificationPolicy`:

| Field | Behaviour |
|---|---|
| `request_timeout_seconds` | Per-case httpx timeout |
| `max_concurrency` | Thread-pool size across cases |
| `retry_attempts` / `retry_backoff_ms` | **Transport failures only** |
| `allow_mutating_methods` | When false, POST/PUT/PATCH/DELETE cases are `skipped` |
| `follow_redirects` / `verify_tls` | Passed to the guarded client |

A status or schema mismatch **never** retries. `attempts > 1` on an evidence case always means
the transport was retried.

## Failure codes

| Code | When |
|---|---|
| `status-mismatch` | Response status outside `expect.status_codes` (incl. `2XX` / `4XX`) |
| `response-schema-mismatch` | Body fails IXH-5.1 `validate_json_instance` |
| `transport-error` / `timeout` | Could not get an answer to judge |
| `auth-unavailable` | Env/stored credential could not be materialised (run refuses before cases) |
| `mutating-method-blocked` | Case skipped by policy |

## Manual golden path (hosted SIM / mock)

1. Publish a petstore (or golden-path) version and enable the Apiome mock.
2. Register a verification target:
   - `environment: mock`
   - `network_class: private` with an `approval_reason` (required for `http://localhost:8775/…`)
   - `base_url`: `http://localhost:8775/{tenant}/{project}/{version}`
   - `auth.kind: none` (or env/stored as needed)
3. `POST …/contracts/project/{slug}/{version}/run` with `"target_ref": "<slug>"`.
4. Expect `ok: true`, `run.outcome: passed` (modulo skipped mutating cases), and a retrievable
   evidence record / JUnit export.

Deliberate break: point the same suite at a stub that returns 500 or drops a required field —
evidence must be `failed` with `status-mismatch` or `response-schema-mismatch`.

## Out of scope

* CLI `apiome verify contract` — ECA-2.2 (#4733)
* Policy evaluator — ECA-3.1 (#4734)
* Portable mock runtime packaging — PMR
