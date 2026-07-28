# Environment and Target Registry (ECA-1.2)

> apiome#4730 — the second half of Executable Contract Assurance Epic 1 (parent #4458).
> Consumes ECA-1.1 (#4729) suite digests; blocks ECA-1.3 (verification evidence) and
> ECA-2.1 (HTTP contract runner).

## Why

A compiled contract suite deliberately carries no URL and no credential: it describes requests
*relative* to nothing. Everything about **where** those requests go has, until now, lived outside
the platform — a CI variable here, a shell export there. That leaves four questions unanswerable:

* which target did this run actually use?
* who was allowed to select it?
* can a target be pointed at an internal address by accident?
* where did the credential go?

The registry answers all four with one tenant-scoped, **secret-free** definition plus an
append-only ledger of every change and every selection.

## Modules

| Module | Role |
|---|---|
| `app/verification_target.py` | The pure contract: vocabularies, credential reference, policy, URL validation, record/resolution models, error taxonomy. No I/O. |
| `app/verification_target_store.py` | The only door to the tables: validates before storing, resolves, and writes the audit ledger. |
| `app/verification_target_routes.py` | `/v1/tenants/{tenant}/verification-targets[...]`, gated on the `verification_targets` RBAC resource. |
| `apiome-db` V211 | `verification_target`, `verification_target_audit`, the retention sweep, and the RBAC grid update. |
| apiome-ui `api/verification-targets/[[...path]]` | Thin session-authenticated proxy; the tenant slug is resolved server-side. |

## A target never holds a secret

This is the invariant everything else is arranged around, and it is enforced twice — in the
Pydantic contract and again as a V211 CHECK constraint, so neither layer is the only thing between
a mistake and the database.

| `auth.kind` | `auth.ref` holds | Where the secret actually lives |
|---|---|---|
| `none` | nothing (scheme and ref must both be absent) | — |
| `env` | an environment-variable **name**, `^[A-Z_][A-Z0-9_]*$` | the runner's own environment; the platform never sees it |
| `stored` | a **UUID** | the existing encrypted credential vault (`apiome.mcp_endpoint_credentials`, V129) |

The env grammar is the load-bearing part: a bearer token, an API key, a base64 blob, and a JWT all
contain characters outside `[A-Z0-9_]` (a JWT contains `.`), so a pasted secret cannot masquerade
as a reference. `auth.scheme` (`bearer` / `header` / `basic`) and `auth.header_name` describe how
the resolved value is *presented* — shapes, not secrets — and the header name is held to the
RFC 9110 token grammar so a stored name can never split a request.

## URL validation blocks private-network SSRF by default

`validate_base_url()` runs every target URL through `app.ssrf_guard`, the same guard that protects
import-from-URL:

* **scheme** — `http`/`https` only. No `file:`, `data:`, `gopher:`.
* **authority** — no `user:pass@`. A credential in a URL is both a secret in a target record and a
  classic redirect-smuggling trick.
* **address** — for the default `network_class: public`, the host is resolved and **every**
  address it answers with must be globally routable. Loopback, RFC1918, link-local (including the
  `169.254.169.254` metadata endpoint), CGNAT, multicast, reserved, and IPv4-mapped IPv6 forms are
  all refused.

An internal target is still reachable — but only by declaring `network_class: private`, which
requires an `approval_reason` and records the authenticated caller as the approver. The exception
exists; it cannot be taken silently.

The address check runs **again at resolve time**. DNS moves: a hostname that resolved publicly when
the target was defined can point at an internal address today while the definition looks unchanged.
Resolution is the moment a definition becomes traffic, so that is where the check has to be true.

## Target selection is audited

`POST .../{target_ref}/resolve` is the audited seam. It writes a `target.resolve` entry **whether
it succeeds or not**:

| Situation | `outcome` | `reason` |
|---|---|---|
| a run selects `staging` | `success` | — |
| the target is disabled | `denied` | `target-disabled` |
| the slug does not exist (a probe) | `denied` | `target-not-found` |
| the URL now resolves inward | `failure` | `target-url-private-network` |

Each entry carries the actor and — via `actor_kind` — whether that was an interactive user or a CI
runner authenticating with an API key, which is exactly the distinction the acceptance criterion
"only authorized users and runners can resolve a target" is about.

What the ledger does *not* carry is as deliberate: an update records which **field names** changed,
never their values, and a successful resolve records the credential reference *kind* but never the
reference itself. A ledger that pointed at where a secret is kept would be a new disclosure surface.

The write is best-effort (a ledger hiccup must never fail the run it records) and every failure is
logged, matching `app.registry_audit`.

## Authorization

V211 adds a `verification_targets` RBAC resource to the built-in grids:

| Role | view | create / edit / delete |
|---|---|---|
| Owner, Admin | ✅ | ✅ |
| Editor (and any member with no explicit role) | ✅ | — |
| Viewer | ✅ | — |

Managing a target is a security decision — it names a URL and a credential reference — so it stays
with Owner and Admin. *Viewing* is what a resolve requires, and every member needs that to verify
their own work.

## Execution policy

The registry, not the runner, sets the ceiling: a target is a *permission* to send traffic at
someone's system.

| Field | Default | Why |
|---|---|---|
| `request_timeout_seconds` | 30 (1–300) | |
| `max_concurrency` | 4 (1–32) | |
| `retry_attempts` | 0 (0–5) | Transport failures only — a contract failure is never retried, or a flaky pass would mask a real incompatibility. |
| `allow_mutating_methods` | `false` | A contract run against a live system should not write to it unless someone said so. |
| `follow_redirects` | `false` | A redirect silently changes which host answered a case. |
| `verify_tls` | `true` | May only be disabled on an approved **private** target (a self-signed internal box). |
| `failure_action` | `block` | A gate that warns by default is not a gate. |
| `max_allowed_failures` | 0 | A contract is not partially binding. |

A stored policy that predates a field, or carries one that has since been removed, still loads:
unknown keys are dropped, missing ones take their defaults, and a value outside the current bounds
falls back to defaults. Configuration must not become unreadable across a release.

## A run records a target identity, never credentials

`target_identity(record)` is the ECA-1.3 seam — the block a run/evidence record embeds:

```json
{
  "target_id": "…", "slug": "staging", "environment": "staging",
  "network_class": "public", "base_url": "https://staging.example.com/api"
}
```

The credential reference is absent on purpose. Retired targets are **soft-deleted**, so an evidence
row that names a `target_id` keeps resolving (`GET .../{id}?include_deleted=true`) long after the
target is gone; the slug is freed for reuse.

## Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` | `/v1/tenants/{tenant}/verification-targets` | `verification_targets:view` |
| `POST` | `/v1/tenants/{tenant}/verification-targets` | `verification_targets:create` |
| `GET` | `/v1/tenants/{tenant}/verification-targets/{ref}` | `verification_targets:view` |
| `PATCH` | `/v1/tenants/{tenant}/verification-targets/{ref}` | `verification_targets:edit` |
| `DELETE` | `/v1/tenants/{tenant}/verification-targets/{ref}` | `verification_targets:delete` |
| `POST` | `/v1/tenants/{tenant}/verification-targets/{ref}/resolve` | `verification_targets:view` |
| `GET` | `/v1/tenants/{tenant}/verification-targets-audit` | `verification_targets:view` |

`{ref}` is a slug **or** an id, so CI can name a stable handle (`staging`) while an evidence record
names an immutable id. The ledger lives on a sibling path rather than `.../audit` so `audit` can
never be mistaken for a target named "audit".

### Refusal codes

Every refusal carries `{"code", "message"}`, so a client branches on the code rather than the prose.

| Code | HTTP | Meaning |
|---|---|---|
| `target-url-scheme` | 400 | Not `http`/`https`. |
| `target-url-credentials` | 400 | `user:pass@` in the authority. |
| `target-url-private-network` | 400 | A `public` target resolving to a non-routable address. |
| `target-url-unresolvable` | 400 | DNS could not answer; unknown is treated as unsafe. |
| `target-url-malformed` | 400 | Unparseable. |
| `target-private-not-approved` | 400 | `private` with no stated reason. |
| `target-policy-tls-required` | 400 | `verify_tls: false` outside a private target. |
| `target-slug-invalid` | 400 | Not a usable handle. |
| `target-auth-invalid` | 422 | The credential reference is malformed for its kind (raised by model validation). |
| `target-disabled` | 400 | The target exists but may not be resolved. |
| `target-not-found` | 404 | No such target in this tenant. |
| `target-slug-taken` | 409 | A live target already uses that slug. |

## Example

```bash
# Define a public staging target whose token the runner reads from its own environment.
curl -X POST /v1/tenants/acme/verification-targets \
  -H 'Authorization: Bearer …' -H 'Content-Type: application/json' \
  -d '{
        "slug": "staging",
        "name": "Staging",
        "environment": "staging",
        "base_url": "https://staging.example.com/api",
        "auth": {"kind": "env", "scheme": "bearer", "ref": "APIOME_STAGING_TOKEN"},
        "policy": {"max_concurrency": 2, "request_timeout_seconds": 15}
      }'

# Select it for a run against a specific compiled suite. This entry is what an auditor reads.
curl -X POST /v1/tenants/acme/verification-targets/staging/resolve \
  -H 'Authorization: Bearer …' -H 'Content-Type: application/json' \
  -d '{"suite_digest": "sha256:ab12…"}'
```

## Retention

`apiome.purge_verification_target_audit(p_retention_days DEFAULT 365)` hard-deletes ledger entries
older than the window, for the same scheduled maintenance job as the other purges. Target
definitions are never purged by age — a retired one is the record an evidence row resolves.
