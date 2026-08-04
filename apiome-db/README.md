# apiome-db

Database migrations **and** the `apiome-db` admin CLI for the Apiome platform.

- **Migrations** — [Flyway](https://documentation.red-gate.com/flyway)-style versioned SQL
  scripts in [`scripts/`](./scripts) (`V<version>__<description>.sql`) applied by
  `apiome-db migrate`, tracked in a Flyway-shaped `flyway_schema_history` table. See
  [Migrations](#migrations) below and the [`Dockerfile`](./Dockerfile).
- **Seed data** — idempotent dev fixtures in [`seed/dev/`](./seed/dev) loaded with
  `apiome-db seed` (development only).
- **Admin CLI** — a direct-to-database tool for privileged operations (users, tenants,
  membership, API keys), documented below.

## Migrations

Migrations follow Flyway conventions (a self-contained TypeScript engine — no Java required):

- **Naming** — `V<version>__<description>.sql`. The version is a zero-padded sequential number
  (`V001`, `V002`, … e.g. `V001__multitenant_init.sql`); scripts apply in version order. When
  adding a migration, use the next number after the highest existing one.
- **Tracking** — applied scripts are recorded in `flyway_schema_history` (in the `public`
  schema by default, so it survives the app `apiome` schema being dropped) with a CRC32 `checksum`
  of each script's contents.
- **Validation** — on every run the recorded checksum of each applied script is compared with
  the file on disk; editing an already-applied migration is rejected (resolve with `repair`).
- **Transactions** — each migration runs in its own transaction (the history insert included),
  so a failure rolls back cleanly with no orphan row.

```bash
apiome-db migrate                 # apply pending migrations
apiome-db migrate status          # list applied / pending
apiome-db migrate --dry-run       # show what would apply
apiome-db repair                  # realign checksums + drop failed rows
apiome-db clean                   # drop the apiome schema + history (guarded; see below)
apiome-db seed                    # load dev fixtures (development only)
```

`clean` is **destructive** and **disabled by default** (matching Flyway 10): it refuses unless
`FLYWAY_CLEAN_DISABLED=false` (or `--force`), refuses under `NODE_ENV=production`, and requires
`--yes`/a TTY confirmation. Flyway behaviour is tunable via env (see
[`.env.example`](./.env.example)): `FLYWAY_SCHEMA_HISTORY_TABLE`, `FLYWAY_DEFAULT_SCHEMA`,
`FLYWAY_CLEAN_DISABLED`, and `APIOME_DB_SEED_DIR`.

### Seed data (development only)

`apiome-db seed` applies the idempotent `*.sql` files in [`seed/dev/`](./seed/dev) (override
with `--dir` or `APIOME_DB_SEED_DIR`), creating a runnable local fixture:

| Fixture | Value |
|---------|-------|
| User | `ada@example.com` / password `apiome-dev` |
| Tenant | `acme-corp` (Ada is a member + administrator) |
| License | `Dev` (free tier) — a sample *catalog* row; the seeded tenant and users hold `Paid` |
| API key | prefix `sk_devseed00...` (raw key in [`seed/dev/005_api_key.sql`](./seed/dev/005_api_key.sql)) |
| Credential accounts | Better Auth `providerId='credential'` rows for the seed users, so the documented passwords sign in ([`seed/dev/008_credential_accounts.sql`](./seed/dev/008_credential_accounts.sql)) |
| Entitlements | `Paid` for both seed users and for `acme-corp` — the lowest catalog tier bundling the Authoring products, so a fresh stack reaches the commercial surfaces without manual SQL ([`seed/dev/009_entitlements.sql`](./seed/dev/009_entitlements.sql)) |

Seeds are **never** run automatically (not wired into the Docker entrypoint or compose) and the
command refuses under `NODE_ENV=production` without `--force`.

## Admin CLI

### Security model

The CLI talks **directly to PostgreSQL** and deliberately **bypasses the REST API**. This is
intentional: provisioning users, tenants, and API keys is privileged, break-glass work that
should not be exposed over an HTTP service. Consequences:

- It requires **database credentials** and network access to Postgres. There is no app-level
  authentication — whoever can run it with valid DB creds has full control over these tables.
- Secrets (passwords, API keys) are **generated/printed once** and stored only as bcrypt
  hashes, exactly matching what `apiome-ui` writes and `apiome-rest` validates:
  - API key = `sk_` + 32 random bytes hex; stored `key_prefix = key[:12] + "..."`,
    `key_hash = bcrypt(key, 10)`. The REST service looks up by prefix and verifies with
    `bcrypt.checkpw(rawKey, key_hash)`.
  - Passwords = `bcrypt(password, 10)`.
- Treat it like `psql`: run it from a trusted operator host, prefer `--password-stdin` /
  `--random-password` over passing secrets as visible CLI args, and keep an audit trail.

### Build / run

```bash
yarn workspace apiome-db build      # compile to dist/
yarn workspace apiome-db dev -- <args>   # run from TS without building (tsx)
node apiome-db/dist/cli.js <args>   # run the built CLI
# or, once linked on PATH: apiome-db <args>
```

### Connecting to the database

Resolution order (first match wins):

1. `--database-url <url>` flag
2. `APIOME_DB_URL` env
3. `DATABASE_URL` env
4. Individual flags `--host/--port/--user/--password/--database`
5. `POSTGRES_HOST/PORT/USER/PASSWORD/DB` env (the same vars used by `docker-compose.yml`),
   defaulting to `localhost:5432/apiome` as user `postgres`.

```bash
export APIOME_DB_URL="postgresql://postgres:pw@localhost:5432/apiome"
apiome-db ping
```

Global flags: `--json` (machine-readable output), `-y, --yes` (skip confirmation prompts;
required for destructive operations when there is no TTY).

### Commands

```
apiome-db ping                         Verify the database connection

migrate [--dry-run] [--scripts-dir <path>]  Apply pending Flyway migrations (V*__*.sql)
migrate status [--scripts-dir <path>]       List applied / pending migrations
repair [--scripts-dir <path>]               Realign flyway_schema_history checksums; drop failed rows
clean [--force]                             Drop the apiome schema + history (destructive; guarded)
seed [--dir <path>] [--dry-run] [--force]   Load dev seed data (development only)

users create   --name --email (--password | --password-stdin | --random-password)
                                            [--unverified] [--disabled]
users list     [--all]
users set-password <email|id> (--password | --password-stdin | --random-password)
users delete   <email|id> [--hard]

tenants create      --name [--slug] [--description] [--disabled]
tenants list        [--all]
tenants delete      <slug|id> [--hard]
tenants add-user    <slug|id> <email|id> [--admin]
tenants remove-user <slug|id> <email|id> [--admin-only]
tenants members     <slug|id>

api-keys create  --tenant <slug|id> --name <name> [--description]
                 [--expires-days N] [--created-by <email|id>]
api-keys list    --tenant <slug|id> [--all]
api-keys revoke  <id|prefix> [--hard]
```

Soft-delete is the default for `delete`/`revoke` (`deleted_at` set, row disabled); `--hard`
removes the row. References accept either a UUID id or the natural key (user email, tenant
slug, API-key prefix).

## Backups & disaster recovery

Scheduled, encrypted backups and point-in-time recovery (PITR) for the database, exposed through
the `backup` command group. The full operational procedure — RPO/RTO targets, scheduling, restore
steps, and the monthly DR drill — is in
[`docs/runbooks/BACKUP_AND_DR.md`](../docs/runbooks/BACKUP_AND_DR.md).

Two backup kinds, both AES-256-GCM encrypted at rest and mirrored off-site:

- **Logical, scoped** (`--tenant`/`--project`) — exports the event/snapshot model
  (`class_schema`, `data_record`, `data_snapshot`) as a JSON dataset. This is what PITR replays.
- **Full cluster** (`--full`) — a whole-database `pg_dump` (custom format) for total-loss DR.

Each backup writes the (encrypted) artifact plus a plaintext `*.manifest.json` sidecar recording
scope, size, SHA-256 integrity, encryption status, recovery-point marker, and row counts.

```
backup dump   [--out <dir>] [--full]        Dump the DB to a dated .sql file; when a prior-day
                                            backup exists, write only the diff vs. that day
backup create [--tenant <slug|id>] [--project <slug|id>] [--full]
              [--out <dir>] [--offsite <dir>] [--encrypt-key-file <path>]
              [--require-encryption]        Create a backup (logical or pg_dump)
backup list   [--out <dir>]                 List backups from manifest sidecars
backup restore <id> --sandbox <schema>
              [--as-of <iso8601>] [--out <dir>] [--encrypt-key-file <path>]
                                            Restore into an isolated sandbox schema (PITR
                                            with --as-of); never touches the live apiome schema
backup prune  [--keep-days N] [--keep-last N] [--out <dir>]
                                            Delete backups that have aged out of retention
backup drill  [--backup-id <id>] [--sandbox <schema>] [--as-of <iso8601>]
              [--rto-target-minutes N] [--rpo-target-minutes N]
                                            Restore to a throwaway sandbox, verify, measure
                                            RPO/RTO, then tear it down (pass/warn/fail)
```

Configuration is via env (or flags): `APIOME_BACKUP_DIR`, `APIOME_BACKUP_OFFSITE_DIR`,
`APIOME_BACKUP_KEY` (32-byte AES-256 key as hex/base64), `APIOME_BACKUP_KEEP_DAYS`,
`APIOME_BACKUP_KEEP_LAST` (see [`.env.example`](./.env.example)). The encryption key is the
key recovery dependency — store it in a secrets manager, **separate from the artifacts**.

### Examples

```bash
# One-time: generate and export the data key (store it in a secrets manager).
openssl rand -hex 32 > /secure/apiome-backup.key
export APIOME_BACKUP_KEY="$(cat /secure/apiome-backup.key)"
export APIOME_BACKUP_DIR=/var/backups/apiome
export APIOME_BACKUP_OFFSITE_DIR=/mnt/offsite/apiome

# Create an encrypted, off-site-mirrored tenant backup.
apiome-db backup create --tenant acme-corp --require-encryption

# Recover state as of a point in time into a sandbox, then inspect.
apiome-db backup list
apiome-db backup restore tenant-acme-corp-20260623T094730Z \
  --sandbox recovery --as-of 2026-06-23T09:29:59Z
#   SELECT * FROM recovery.pitr_records;

# Prove restorability and measure RPO/RTO.
apiome-db backup drill --rto-target-minutes 30 --rpo-target-minutes 60
```

Scheduling uses [`scripts/backup/scheduled-backup.sh`](./scripts/backup/scheduled-backup.sh)
(`full` | `tenant <slug>` | `project <tenant> <proj>`), which always encrypts and then prunes per
the retention policy — see the runbook for cron examples.

### Daily plain-SQL dumps with diffs (`backup dump`)

`backup dump` is a simpler, self-contained path for routine daily dumps: it runs
`pg_dump --format=plain` and writes a dated file under `APIOME_BACKUP_DIR` (or `--out`).

- The first run (or any `--full` run) writes a **full** dump: `backup-YYYY-MM-DD.sql`.
- When a backup for an earlier day already exists, the run instead writes only the **unified
  diff** from that prior day's state to the fresh dump: `backup-YYYY-MM-DD.sql.patch`. This is the
  standard incremental scheme — a full dump of a real database is large; a day's changes are tiny.

```bash
export APIOME_BACKUP_DIR=/var/backups/apiome

# Day 1 → full dump (backup-2026-06-22.sql)
apiome-db backup dump
# Day 2 → only the diff vs. day 1 (backup-2026-06-23.sql.patch)
apiome-db backup dump
# Force a fresh full dump regardless of prior days:
apiome-db backup dump --full
```

**Restore** a given day by starting from the most recent full dump and applying each later
`.patch` in date order with the standard `patch` tool:

```bash
cp backup-2026-06-22.sql restored.sql           # latest full ≤ target day
patch restored.sql backup-2026-06-23.sql.patch  # apply each later day's diff, in order
psql -d apiome_restore -f restored.sql      # load into a fresh database
```

> Requires `pg_dump` and GNU `diff`/`patch` on `PATH`. Note that PostgreSQL 17+ emits a random
> `\restrict`/`\unrestrict` token in every plain dump, so an "unchanged" day still produces a small
> (≈1 KB) diff; this is expected and harmless.

### Docker

The image runs the compiled CLI. By default it applies migrations:

```bash
docker run --rm \
  -e POSTGRES_HOST=db -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=apiome \
  apiome-db:latest

# Other subcommands
docker run --rm -e POSTGRES_HOST=db ... apiome-db:latest migrate status
docker run --rm -e POSTGRES_HOST=db ... apiome-db:latest ping
```

### Examples

```bash
# Apply pending migrations
apiome-db migrate
apiome-db migrate status
apiome-db migrate --dry-run

# Create a user with a generated password (printed once)
apiome-db users create --name "Ada Lovelace" --email ada@example.com --random-password

# Create a tenant (slug derived from the name if omitted) and make Ada an admin
apiome-db tenants create --name "Acme Corp"
apiome-db tenants add-user acme-corp ada@example.com --admin

# Mint an API key for the tenant (the key is shown exactly once)
apiome-db api-keys create --tenant acme-corp --name ci-key --expires-days 90

# Pipe a password instead of putting it in shell history
printf '%s' "$NEW_PW" | apiome-db users set-password ada@example.com --password-stdin

# Revoke a key non-interactively
apiome-db --yes api-keys revoke sk_265e18808...
```

### Notes

- All core tables are addressed in the `apiome` schema (`apiome.users`, `apiome.tenants`, `apiome.api_keys`,
  …), matching `apiome-rest`.
- `api-keys create` writes `created_by_user_id` when the column exists and transparently falls
  back for older databases (same behavior as the REST service).

### Type registry (extends `apiome.primitives`)

The JSON Schema type registry is **not** a separate database. It lives in this same
`apiome-db` database, in the `apiome` schema, by **extending the existing `apiome.primitives`
table in place**. Primitives are tenant-scoped (each row's `tenant_id`) **and** system-wide
(`is_system` / `is_public`), so a tenant's own types and the shared `std/*` types compose across
the tenant's projects with ordinary same-database foreign keys.

Migration `V111__consolidate_the_type_registry_into_objec.sql` adds these registry
columns to `apiome.primitives` (no new tables, no separate schema):

| Column | Role |
|--------|------|
| `namespace` | Namespace path, e.g. `std/v0/types` (system-wide) or `tenant/<slug>/types` (tenant-owned) |
| `base_uri` | Import-source base URL the relative `$ref` values resolve against (Epic 3) |
| `schema_id` | The JSON Schema `$id` (namespace base + name) |
| `draft` | JSON Schema dialect/draft, default `2020-12` |
| `source` | Provenance: `human` or `imported` (`primitives_source_ck` check) |
| `refs` | JSONB array of `$ref` edges: `[{relative_ref, resolved_target, status ∈ {resolved, unresolved, circular}}]` |

The same migration drops the obsolete `otr` schema if an earlier build created it (the separate
`apiome-types-db` design was reversed — see #3446). Tenant vs system scope reuses the
existing `tenant_id` / `is_system` columns; the `std/v0` core system primitives are seeded in
#3449; `$ref` resolution (`relative_ref` → `resolved_target`) is implemented in Epic 3.
