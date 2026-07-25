# Licensing entity model (ER)

How Apiome attaches licenses to tenants and users, as of **V195** (plan quota limits, #64; auto-issue
Free from **V183**, OLO-5.2, #4212; `tenant_licenses` from **V182**, OLO-5.1, #4211). The catalog and
feature-flag tables come from **V097**; user entitlements from **V071/V097**.

This page is the table-level view. For the platform-level model — the catalog → attachment →
enforcement chain, where each limit is enforced, and the licensing ownership boundary with #3484 —
see [`docs/LICENSING_MODEL.md`](../../docs/LICENSING_MODEL.md) (OLO-5.6, #4216).

## The split: user entitlement vs. tenant license

| Concept | Table | Answers |
|---------|-------|---------|
| **User entitlement** | `user_entitlements` | *How many tenants may this user create?* (`max_tenants`, via `license_id` → catalog `seats`, falling back to legacy raw limit columns) |
| **Tenant license** | `tenant_licenses` | *What may this tenant do?* — seat capacity (`max_users_per_tenant` from the plan's `seats` JSONB), plan quotas (`max_projects`, `max_versions`, `max_ai_requests`, V195/#64) and bundled features (`license_feature_flags`) |

Both point at the same `licenses` catalog; they license different subjects. A user's entitlement is
consulted when they try to **create** a tenant; a tenant's license is consulted for everything the
tenant does afterwards (adding members, gated features).

## Entity-relationship diagram

```mermaid
erDiagram
    licenses ||--o{ tenant_licenses : "plan held by tenant"
    licenses ||--o{ user_entitlements : "plan assigned to user"
    licenses ||--o{ license_feature_flags : "bundles"
    feature_flags ||--o{ license_feature_flags : "bundled into"
    feature_flags ||--o{ tenant_feature_flags : "tenant override"
    feature_flags ||--o{ user_feature_flags : "user override"
    tenants ||--o| tenant_licenses : "holds at most one"
    tenants ||--o{ tenant_feature_flags : "overrides"
    users ||--o| user_entitlements : "entitled"
    users ||--o{ user_feature_flags : "overrides"
    users ||--o{ tenant_licenses : "issued_by"

    licenses {
        uuid id PK
        varchar name
        varchar license_type "free | paid | sponsor"
        jsonb seats "max_tenants, max_users_per_tenant, max_projects, max_versions, max_ai_requests"
        boolean enabled
    }

    tenant_licenses {
        uuid id PK
        uuid tenant_id FK "UNIQUE - one active license per tenant"
        uuid license_id FK "ON DELETE RESTRICT"
        timestamptz issued_at
        uuid issued_by FK "nullable, ON DELETE SET NULL"
        text notes
    }

    user_entitlements {
        uuid user_id FK
        uuid license_id FK "nullable - legacy accounts use raw limits"
        int max_tenants "user-scoped cap"
    }

    license_feature_flags {
        uuid license_id PK, FK
        uuid feature_flag_id PK, FK
    }

    tenant_feature_flags {
        uuid tenant_id PK, FK
        uuid feature_flag_id PK, FK
        boolean enabled "true grant, false revoke"
    }

    user_feature_flags {
        uuid user_id PK, FK
        uuid feature_flag_id PK, FK
        boolean enabled "true grant, false revoke"
    }

    feature_flags {
        uuid id PK
        varchar name UK "machine slug"
        jsonb url_patterns "routes guarded by flag"
        boolean is_preview
        boolean enabled
    }
```

## Invariants

- **One active license per tenant** — `tenant_licenses.tenant_id` is `UNIQUE`
  (`uq_tenant_licenses_tenant_id`). A plan change is an upsert of the tenant's single row; history
  is not kept in this table (the `notes` column records provenance of the current attachment).
- **A held plan cannot vanish** — `tenant_licenses.license_id` → `licenses.id` is
  `ON DELETE RESTRICT`: deleting a catalog plan is refused while any tenant holds it.
- **License rows follow their tenant** — `tenant_id` is `ON DELETE CASCADE`; deleting a tenant
  removes its license attachment.
- **Provenance survives admin deletion** — `issued_by` → `users.id` is `ON DELETE SET NULL`;
  system-issued licenses (e.g. auto-issued Free, OLO-5.2) leave it `NULL`.
- **Every tenant holds a license from birth** (V183, OLO-5.2) —
  `apiome.attach_free_license(tenant_id)` is the single service function that attaches the Free
  plan; an `AFTER INSERT` trigger on `tenants` calls it for **every** create path in the same
  transaction as the insert, and V183 backfilled all pre-existing tenants. The function is
  idempotent (`ON CONFLICT (tenant_id) DO NOTHING`), so it never downgrades a tenant that already
  holds a plan.

## Capacity keys on `licenses.seats` (V195, #64)

Every limit is a JSONB key so a new limit needs no schema change (V097's design). Canonical keys,
with the Free-tier fallback applied when a key is absent:

| Key | Subject | Free | Paid | Sponsor |
|-----|---------|------|------|---------|
| `max_tenants` | user (`user_entitlements`) | 1 | 5 | 20 |
| `max_users_per_tenant` | tenant (`tenant_licenses`) | 5 | 25 | 100 |
| `max_projects` | plan quota | 1 | 10 | −1 |
| `max_versions` | plan quota | 3 | 50 | −1 |
| `max_ai_requests` | plan quota | 0 | 1000 | −1 |

A negative value means **unlimited**. V195 fills keys in only where absent
(`jsonb_build_object(...) || seats`), so limits customised through the admin license manager survive
migration. Which of these limits are actually enforced — and against which subject — is documented in
[`docs/LICENSING_MODEL.md` §3](../../docs/LICENSING_MODEL.md#3-where-each-limit-is-enforced);
`max_ai_requests` is stored and reported only, with no usage meter yet.

## Feature composition (unchanged by V182)

A tenant's effective feature set remains, as established by V097:

```
license_feature_flags(plan)  ∪  tenant_feature_flags(tenant overrides, enabled=true)
                             ∖  tenant_feature_flags(enabled=false)
```

with `user_feature_flags` applying per-user grant/revoke on top. `tenant_licenses` only determines
*which plan* feeds the left-hand side.

## Related work

- **OLO-5.2 (#4212)** — ✅ auto-issue Free on tenant creation + backfill existing tenants (V183).
- **OLO-5.3 (#4213)** — ✅ enforcement guards (seats, tenant caps).
- **OLO-5.4/5.5 (#4214/#4215)** — ✅ REST surface (`GET /v1/tenants/{slug}/license`) and settings UI
  reading this model.
- **#64** — ✅ closed: the license table it asked for is V097 + V182; its three limits shipped as the
  V195 quota keys above.
- **OLO-5.6 (#4216)** — ✅ platform model + ownership boundary documented in
  [`docs/LICENSING_MODEL.md`](../../docs/LICENSING_MODEL.md).
- **#3484** — Platform Foundations & Licensing epic; still owns paid plan assignment, billing,
  upgrades and AI metering (no write path to `tenant_licenses` exists other than
  `attach_free_license`).
