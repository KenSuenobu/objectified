# Webhook source-IP allowlist

REPO-7.6 (#2804). `POST /v1/repositories/webhook/{provider}` is the one repository route with
no bearer token — a provider cannot hold one — so the HMAC signature over the raw body is its
authentication (REPO-4.3, #2781). That check is sound. What it does not do is decide *who gets
to attempt it*: without a network filter, every unsigned POST from every scanner on the
internet buys a subscription lookup, a constant-time comparison against a real secret, and a
ledger row.

The allowlist filters on the source address **before** any of that runs. "We reject every
forgery" becomes "we never look at one".

## Where the check happens

In `repository_webhook_routes.ingest_repository_webhook`, immediately after the body is read
and **before** `ingest_webhook_delivery` is called. That placement is the acceptance criterion,
not an implementation detail: a blocked delivery is never given a chance to verify, which is
why the guard is not a branch inside the dispatcher.

```
provider path segment → 400 if unsupported
body read
guard_webhook_delivery(...)  ← REPO-7.6; 403 if refused
ingest_webhook_delivery(...) ← REPO-4.3; HMAC verification lives here
```

## The two halves of the allowlist

| Half | Table | Source |
|---|---|---|
| Provider-published ranges | `apiome.webhook_provider_ip_range` | Fetched daily from the provider's own endpoint, plus deployment-configured ranges |
| Per-tenant additional ranges | `apiome.tenant_webhook_ip_allowlist` | Added by tenant administrators |

Provider sources:

| Provider | Endpoint | Read |
|---|---|---|
| `github` | `https://api.github.com/meta` | The `hooks` array only — `actions` and `web` never deliver a webhook |
| `bitbucket` | `https://ip-ranges.atlassian.com/` | Entries whose `product` contains `bitbucket` |
| `gitlab` | *(none published)* | `APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITLAB` |

The same `..._IP_RANGES_{PROVIDER}` setting exists for all three, for self-hosted instances no
public endpoint knows about. Configured ranges are stored with `source = 'configured'`, so an
operator can tell a range the provider vouches for from one we were told about.

## The decision, in order

1. Enforcement off deployment-wide → **allow** (`enforcement-disabled`).
2. Address in the provider's cached ranges → **allow** (`provider-range`). One cached read; no
   tenant context needed, which is the common case.
3. Resolve the tenants that registered the repository the payload names, then per tenant:
   - policy `enforcement_enabled = false` → **allow** (`tenant-bypass`);
   - address in that tenant's enabled entries → **allow** (`tenant-allowlist`).
4. No usable client address → **block** (`client-ip-unknown`).
5. No ranges cached for the provider → **allow** with a warning, or **block** in strict mode
   (`ranges-unavailable`).
6. Otherwise → **block** (`ip-not-allowed`).

Two subtleties are deliberate:

**Tenant ranges are scoped to the tenant.** The repository name is read out of the payload —
parsing, not authentication; no secret is touched — so that a workspace's own ranges are
consulted only for its own repositories. A union across all tenants would let any one
workspace widen the filter protecting every other.

**The tenant bypass outranks an unidentifiable address.** A bypass means "do not filter this
tenant", and a deployment whose proxy configuration yields no usable address is exactly the
situation an operator reaches for the bypass to escape.

## Failure modes, and why they were chosen

| Situation | Behaviour | Why |
|---|---|---|
| Feature never enabled | Allow | Enforcement that switched itself on during an upgrade would 403 every existing deployment's deliveries, and providers retrying into a 403 is a near-silent outage |
| Provider cache empty | Allow + warn (strict: block) | Blocking would reject every delivery for a provider on the strength of a cache we failed to populate |
| Provider fetch returns `[]` | Refresh recorded as `failure`; previous cache stands | An empty answer is far likelier to be an upstream incident than a withdrawal of every address |
| Provider fetch errors, configured ranges exist | Refresh recorded as `success` with the error attached | There are still ranges to filter on; the panel says the provider has been unreachable |
| Database read fails | Treated as "no ranges"; not cached | A blip must not pin the guard into its unavailable posture for the whole TTL |
| Ledger or audit write fails on a block | Block still stands | An evidence problem must not become an availability problem, in either direction |

## `X-Forwarded-For`

`APIOME_REPOSITORY_WEBHOOK_TRUSTED_PROXY_HOPS` says how many reverse proxies the deployment
operates in front of this service.

- **0 (default)** — the socket peer is the source and the header is ignored entirely.
  Honouring an unverified header would let any caller name its own source address, which is
  the whole filter defeated in one line.
- **N > 0** — the client is the Nth entry from the *right*. The leftmost entry is whatever the
  first hop claimed; only the entries our own proxies appended can be trusted. A header with
  fewer than N entries means the request did not traverse the chain the deployment described,
  so the address is reported as unknown rather than guessed from attacker-written values.

## Refresh cadence

An hourly background tick (`_repository_webhook_ip_range_sweep` in `main.py`) refreshes every
provider whose **last success** is older than
`APIOME_REPOSITORY_WEBHOOK_IP_REFRESH_INTERVAL_SECONDS` (default 86400). Measuring from the
last success rather than the last attempt is what makes a failing provider a one-hour gap
instead of a one-day one. The first tick runs ~20s after startup, so a fresh deployment has
ranges before anyone turns enforcement on.

A process-local TTL cache (`APIOME_REPOSITORY_WEBHOOK_IP_CACHE_SECONDS`, default 60) sits in
front of the range read, so a flood of blocked deliveries on the unauthenticated route is not
also a flood of queries. A refresh invalidates the entry it rewrote.

## Evidence

| Where | What |
|---|---|
| `apiome.repository_webhook_event` | One row per blocked delivery: `outcome = 'rejected'`, `reason = 'ip-not-allowed'` (or the reason that applied) |
| `apiome.workflow_audit` | `repository.webhook.ip_blocked` per owning tenant; `repository.webhook.ip_allowlist_updated` and `repository.webhook.ip_policy_updated` for changes |

All three actions carry the `repository.` prefix, so they appear in the REPO-7.5 compliance
export (`GET /v1/tenants/{slug}/repository-audit-export`) with no further wiring. A policy
change that *disables* enforcement is audited with the `failure` outcome — turning a security
control off is not a routine success, and an outcome an alert can key on is the difference
between noticing and not.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST` | `false` | Master switch |
| `APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST_STRICT` | `false` | Empty range cache blocks instead of allowing |
| `APIOME_REPOSITORY_WEBHOOK_TRUSTED_PROXY_HOPS` | `0` | Hops of `X-Forwarded-For` to trust |
| `APIOME_REPOSITORY_WEBHOOK_IP_REFRESH_INTERVAL_SECONDS` | `86400` | Provider refresh cadence |
| `APIOME_REPOSITORY_WEBHOOK_IP_CACHE_SECONDS` | `60` | Process-local range cache TTL |
| `APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITHUB` | `""` | Extra CIDRs, comma-separated |
| `APIOME_REPOSITORY_WEBHOOK_IP_RANGES_GITLAB` | `""` | The only source for GitLab |
| `APIOME_REPOSITORY_WEBHOOK_IP_RANGES_BITBUCKET` | `""` | Extra CIDRs, comma-separated |

## Rollout

1. Deploy. The sweep populates the range cache within a minute; enforcement is still off.
2. Open **Repositories → Webhook IPs** and confirm each provider you use shows cached ranges
   and a recent successful refresh.
3. Add any ranges of your own (a self-hosted runner, an egress gateway), each with a reason.
4. Set `APIOME_REPOSITORY_WEBHOOK_IP_ALLOWLIST=true`.
5. Watch `apiome.repository_webhook_event` for `reason = 'ip-not-allowed'`. A legitimate
   sender showing up there means a range is missing, not that the sender is hostile.
