# Production Deployment Runbook

**Status:** RC1 baseline (ticket RC1-3.3 / #3618) · **Owner:** Platform / on-call · **Scope:** the
Apiome spine (Postgres · migrations · `apiome-rest` · `apiome-mcp`) behind TLS.

This runbook promotes the local `docker-compose` stack to a **documented, reproducible production
deploy**: TLS via Let's Encrypt, fail-closed secrets, a **gated** migration step, the RC1-1.3
backups wired in, and a documented rollback. Following it on a clean host produces a working,
HTTPS-served stack.

It builds on two existing runbooks — read them alongside this one:
[`BACKUP_AND_DR.md`](BACKUP_AND_DR.md) (backups / restore / DR drills) and
[`../security/RC1_HARDENING_CHECKLIST.md`](../security/RC1_HARDENING_CHECKLIST.md) (auth/secret bar).

---

## 1. What gets deployed

The production stack is the base [`docker-compose.yml`](../../docker-compose.yml) with the
[`docker-compose.prod.yml`](../../docker-compose.prod.yml) overlay applied on top:

```
                         Internet
                            │  :80 (ACME + redirect) · :443 (HTTPS / HTTP-3)
                     ┌──────▼──────┐
                     │    caddy    │  automatic Let's Encrypt TLS
                     └──┬───┬───┬──┘
            api.<domain>│   │   │studio.<domain>
                  ┌─────▼─┐ │ ┌─▼──────┐
                  │ rest  │ │ │ studio │      (designer — NOT published on host)
                  └─────┬─┘ │ └────────┘
        mcp.<domain>    │   │
                  ┌─────▼─┐ │
                  │  mcp  │ │
                  └─────┬─┘ │
                        └───┬───┘
                      ┌─────▼─────┐
                      │ postgres  │
                      └───────────┘
   migrate (gated, `migrate` profile)   backup (scheduled, `ops` profile)   seed (`dev-only`, never in prod)
```

Only **80** and **443** are exposed to the network. `rest` (:8000) and `mcp` (:8765) are reached by
Caddy over the internal compose network; Postgres is internal-only. The overlay's header comment
enumerates every change versus the dev base.

---

## 2. Prerequisites (fresh host)

| Requirement | Notes |
|-------------|-------|
| Linux host with **Docker Engine** + **Docker Compose v2.24+** | v2.24 is required for the `!override` / `!reset` merge tags used by the overlay. Check: `docker compose version`. |
| Public **DNS** records | `A`/`AAAA` for `DEPLOY_API_DOMAIN`, `DEPLOY_MCP_DOMAIN`, and `DEPLOY_STUDIO_DOMAIN` pointing at this host **before** first boot — Caddy needs them resolvable to pass the ACME challenge. |
| Inbound **firewall** | Allow **80/tcp** and **443/tcp** (+ **443/udp** for HTTP/3). Block everything else; the app and DB ports are intentionally not published. |
| Outbound 443 | For Let's Encrypt + pulling images. |
| A **secret manager** | To hold the values in §3 and especially the backup encryption key. |

---

## 3. One-time setup

```bash
# 1. Get the code on the host.
git clone https://github.com/objectified-project/objectified.git /opt/apiome
cd /opt/apiome

# 2. Create the production .env (next to docker-compose.yml) from the template and fill it in.
cp docker-compose.prod.env.example .env
$EDITOR .env
```

Generate each secret with the commands documented inline in
[`docker-compose.prod.env.example`](../../docker-compose.prod.env.example):

```bash
openssl rand -base64 24   # POSTGRES_PASSWORD, APIOME_MCP_INTERNAL_SECRET
openssl rand -base64 32   # BETTER_AUTH_SECRET  (must match apiome-ui)
openssl rand -hex 32      # APIOME_BACKUP_KEY → store in the secret manager, NOT on this host
```

> The `.env` file holds live secrets and is git-ignored — never commit it. Only the
> `*.env.example` templates are tracked.

Validate that compose can interpolate everything before going further (a missing required value
errors here, not mid-deploy):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo OK
```

A convenience alias for the rest of this runbook:

```bash
alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'
```

---

## 4. First deploy (staged, with the gated migration)

Migrations are **not** applied automatically — the `migrate` service is behind a profile and the
app services no longer depend on it. Apply schema as a deliberate, reviewed, backed-up step.

```bash
# 4.1 Bring up just the database and wait for it to be healthy.
dc up -d postgres

# 4.2 GATE — preview the pending migrations before touching the schema.
dc --profile migrate run --rm migrate migrate status     # what is applied vs pending
dc --profile migrate run --rm migrate migrate --dry-run   # the exact scripts that would run

# 4.3 Take a baseline backup BEFORE the first migration (your rollback point — see §7/§8).
#     (Skip only on a truly empty first install; harmless to run regardless.)
dc --profile ops run --rm backup full

# 4.4 Apply the migrations (the gate). CMD defaults to `migrate`.
dc --profile migrate run --rm migrate

# 4.5 Bring up the app + TLS proxy. They wait only for Postgres to be healthy.
dc up -d

# 4.6 Confirm everything is healthy.
dc ps
```

### 4.7 Verify

```bash
# Internal health (from the host, via the compose network):
dc exec rest python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/readyz',timeout=4).status)"

# Public TLS endpoints (certificates may take a few seconds on first request):
curl -fsS https://$DEPLOY_API_DOMAIN/livez && echo               # process liveness
curl -fsS https://$DEPLOY_API_DOMAIN/readyz && echo              # DB-checked readiness
curl -fsS https://$DEPLOY_MCP_DOMAIN/health && echo              # MCP health
curl -fsS -o /dev/null -w "%{http_code}\n" https://$DEPLOY_STUDIO_DOMAIN/  # Studio (expect 307/200)
```

`/readyz` returns 200 only once REST can reach a **migrated** database; a 503 means migrations
have not been applied (re-check §4.4). The deploy is "working" when REST, MCP, and Studio respond over HTTPS.

Set `APIOME_CORS_ALLOWED_ORIGINS` to include both the main app and Studio origins (e.g.
`https://app.apiome.dev,https://studio.apiome.dev`). The default regex also allows
`https://*.apiome.dev` when `APIOME_CORS_ALLOWED_ORIGIN_REGEX` is unset. Credentials are
enabled (`allow_credentials=True`) for session cookies from Studio.

---

## 5. Bootstrap the first tenant & admin

Production never loads the dev seed, so create real accounts with the `apiome-db` admin CLI
(run through the `migrate` service image, which carries the full CLI):

```bash
# A platform user (--random-password generates and prints one once).
dc --profile migrate run --rm migrate users create \
  --name "Ada Lovelace" --email ada@example.com --random-password

# A tenant, with the user as owner, optionally provisioning the sample project.
dc --profile migrate run --rm migrate tenants create \
  --name "Acme Corp" --slug acme-corp --sample-creator ada@example.com

# A tenant-scoped API key (the secret is printed ONCE — capture it now).
dc --profile migrate run --rm migrate api-keys create \
  --tenant acme-corp --name "ci" --created-by ada@example.com
```

See [`../../apiome-db/README.md`](../../apiome-db/README.md) for the full admin command
reference (users / tenants / members / api-keys / tokens).

---

## 6. Backups wired in

The overlay ships a profile-gated `backup` service (the RC1-1.3 tooling) that writes
AES-256-GCM-encrypted, off-site-mirrored backups to a volume REST reads, so the ops dashboard
(`/v1/ops/backups`, RC1-3.2) reports their freshness. Schedule it from the host — e.g. in
`/etc/cron.d/apiome`:

```cron
# Hourly tenant logical backup (low RPO) + retention prune.
0 * * * *  root  cd /opt/apiome && APIOME_BACKUP_KEEP_DAYS=7  docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile ops run --rm backup tenant acme-corp >> /var/log/apiome-backup.log 2>&1

# Daily full pg_dump at 02:00 (whole-cluster DR), retained 30 days.
0 2 * * *  root  cd /opt/apiome && APIOME_BACKUP_KEEP_DAYS=30 docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile ops run --rm backup full       >> /var/log/apiome-backup.log 2>&1
```

`APIOME_BACKUP_KEY` (from `.env`) is mandatory — the wrapper refuses to run, and never writes
plaintext, without it. Validate restores monthly with the DR drill and confirm RPO/RTO, exactly as
in [`BACKUP_AND_DR.md`](BACKUP_AND_DR.md) §5:

```bash
dc --profile ops run --rm --entrypoint node backup dist/cli.js backup drill --rto-target-minutes 30 --rpo-target-minutes 60
```

> Replace the `apiome_backups_offsite` named volume with a bind mount to genuine off-host
> storage (NFS / object-store gateway) so losing the host does not lose the off-site copy.

---

## 7. Upgrades (redeploy a new version)

```bash
cd /opt/apiome
git pull                      # or check out the target release tag

dc build                      # rebuild images at the new code
dc --profile ops  run --rm backup full          # rollback point BEFORE migrating
dc --profile migrate run --rm migrate migrate --dry-run   # GATE: review pending schema
dc --profile migrate run --rm migrate           # apply
dc up -d                      # recreate rest/mcp/caddy at the new images
dc ps                         # verify healthy
```

Because the migration is a separate gated step, schema and code roll forward together but are
reviewed independently. Always take the pre-migration backup — it is the §8 rollback point.

---

## 8. Rollback

Pick the smallest rollback that fixes the failure.

| Situation | Rollback |
|-----------|----------|
| **App is bad, schema unchanged** (no migration in this release) | Check out the previous tag and recreate the app: `git checkout <prev-tag> && dc build && dc up -d rest mcp`. No DB action needed. |
| **App is bad, schema migrated** | Flyway migrations are **forward-only** (there are no down-scripts). Roll back by restoring the **pre-migration backup** taken in §4.3/§7, then redeploy the previous code: see below. |
| **TLS / proxy only** | `dc restart caddy`; inspect `dc logs caddy` (ACME rate-limits, DNS). Certificates persist in the `caddy_data` volume across restarts. |

Schema-level rollback (restore the pre-migration state into a sandbox, verify, then promote — never
restore blindly over live data):

```bash
# 1. Stop the app so nothing writes during the restore (leave Postgres up).
dc stop rest mcp caddy

# 2. Restore the pre-migration backup into a sandbox and inspect it (BACKUP_AND_DR.md §4).
dc --profile ops run --rm --entrypoint node backup dist/cli.js backup list
dc --profile ops run --rm --entrypoint node backup dist/cli.js backup restore <backup-id> --sandbox rollback_sandbox
#    For a full-cluster restore, follow BACKUP_AND_DR.md §4.3 (decrypt → createdb → pg_restore).

# 3. Check out the previous code, rebuild, and bring the app back up.
git checkout <prev-tag>
dc build && dc up -d
```

Record every rollback (trigger, backup id used, measured RTO) in the DR log.

---

## 9. Managed Postgres (variant)

To use a managed database (RDS / Cloud SQL / …) instead of the bundled Postgres container, add a
small `docker-compose.managed.yml` that removes the `postgres` service and repoints the app at the
managed host, then deploy with all three files:

```yaml
# docker-compose.managed.yml
services:
  postgres: !reset null          # drop the bundled DB container
  rest:
    environment:
      POSTGRES_HOST: your-db.example.com
    depends_on: !override []      # no local DB to wait on
  mcp:
    environment:
      APIOME_MCP_DATABASE_URL: postgresql://USER:PASS@your-db.example.com:5432/apiome
    depends_on: !override []
```

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.managed.yml up -d
```

Run the gated migration (§4.4) and backups (§6) against the managed host the same way — the
`migrate` / `backup` services read the same `POSTGRES_*` connection settings. Use the provider's
snapshots/PITR in addition to the logical backups.

---

## 10. Quick reference

| Action | Command (with `alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'`) |
|--------|---------------------------------------------------------------------------------------------|
| Validate config / secrets | `dc config >/dev/null` |
| Preview pending migrations (gate) | `dc --profile migrate run --rm migrate migrate status` |
| Apply migrations | `dc --profile migrate run --rm migrate` |
| Bring up the stack | `dc up -d` |
| Status / health | `dc ps` · `curl https://$DEPLOY_API_DOMAIN/readyz` |
| Manual backup | `dc --profile ops run --rm backup full` |
| Bootstrap tenant/user/key | `dc --profile migrate run --rm migrate tenants create …` |
| Tail logs | `dc logs -f rest` |
| Tear down (keep data) | `dc down` |

---

*Last updated: 2026-06-24 · Ticket: RC1-3.3 (#3618) · Target tag: `v1.0.0-rc.1`*
