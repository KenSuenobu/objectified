/**
 * Structural assertions over the verification-target registry migration (#4730, ECA-1.2).
 *
 * V211 adds `apiome.verification_target` — the named, tenant-scoped, **secret-free** definition of
 * where a compiled contract suite is executed — plus `apiome.verification_target_audit`, the
 * append-only ledger of every definition change and every target *selection*.
 *
 * DB-free contract tests pin the migration shape, concentrating on the guarantees the ticket's
 * acceptance criteria turn into schema rules rather than habits:
 *
 *   * a target can only hold a *reference* to a credential (an env-var NAME or a vault UUID), so a
 *     pasted token cannot be stored;
 *   * a base URL is http/https and can never embed `user:pass@`;
 *   * a private-network target must name an approver and a reason;
 *   * every non-success audit outcome must carry a reason code, and audit rows are write-once.
 *
 * These must stay in lock-step with apiome-rest's `app.verification_target` contract
 * (`ENVIRONMENTS`, `NETWORK_CLASSES`, `AUTH_KINDS`, `AUTH_SCHEMES`) and with the RBAC vocabulary in
 * `app.permissions.RESOURCES`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V211__verification_target_registry_4730.sql";

/** The closed environment vocabulary from the ECA-1.2 contract, in migration order. */
const ENVIRONMENTS = ["mock", "development", "test", "staging", "production"] as const;
/** The closed credential-reference kinds. `none` holds nothing; the other two hold pointers. */
const AUTH_KINDS = ["none", "env", "stored"] as const;
/** How a resolved secret is presented. Shapes, never secrets. */
const AUTH_SCHEMES = ["bearer", "header", "basic"] as const;
/** Every audited action, including the selection of a target for a run. */
const AUDIT_ACTIONS = [
  "target.create",
  "target.update",
  "target.delete",
  "target.resolve",
] as const;

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("verification target registry migration", () => {
  it("is present in scripts/ and ordered after V210", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V210__payload_analysis_capabilities_4795.sql"),
    );
  });

  it("targets the apiome schema and creates both tables idempotently", () => {
    expect(lower).toContain("set search_path to apiome, public");
    expect(lower).toMatch(/create table if not exists verification_target \(/);
    expect(lower).toMatch(/create table if not exists verification_target_audit \(/);
  });

  it("uses uuid_generate_v4 conventions (no gen_random_uuid)", () => {
    expect(lower).toContain("uuid_generate_v4()");
    expect(lower).not.toContain("gen_random_uuid");
  });

  describe("scoping and lifecycle", () => {
    it("scopes every target and audit row to a tenant", () => {
      const scoped = lower.match(
        /tenant_id uuid not null references tenants\(id\) on delete cascade/g,
      );
      expect(scoped).toHaveLength(2);
    });

    it("keeps one live target per slug per tenant, so a retired slug can be reused", () => {
      expect(lower).toMatch(
        /create unique index if not exists idx_verification_target_tenant_slug_live\s+on verification_target \(tenant_id, slug\)\s+where deleted_at is null/,
      );
    });

    it("soft-deletes targets so evidence rows keep resolving them", () => {
      expect(sql).toMatch(/^\s+deleted_at TIMESTAMP WITH TIME ZONE,/m);
    });

    it("constrains the slug to a URL- and shell-safe shape", () => {
      expect(lower).toContain("verification_target_slug_shape_check");
      expect(sql).toContain("'^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$'");
    });

    it("keeps an audit row after its target row is gone", () => {
      expect(lower).toMatch(
        /target_id uuid references verification_target\(id\) on delete set null/,
      );
      expect(sql).toMatch(/^\s+target_slug VARCHAR\(128\),/m);
    });
  });

  describe("target definition columns", () => {
    it("defines every column from the ECA-1.2 field set", () => {
      for (const col of [
        "id",
        "tenant_id",
        "slug",
        "name",
        "description",
        "environment",
        "base_url",
        "network_class",
        "approved_by",
        "approved_at",
        "approval_reason",
        "auth_kind",
        "auth_scheme",
        "auth_ref",
        "auth_header_name",
        "policy",
        "enabled",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
        "deleted_at",
      ]) {
        expect(sql).toMatch(new RegExp(`^\\s+${col}\\s`, "m"));
      }
    });

    it("constrains environment to the closed ECA-1.2 vocabulary", () => {
      expect(lower).toContain("verification_target_environment_check");
      const quoted = ENVIRONMENTS.map((e) => `'${e}'`).join(",\\s*");
      expect(lower).toMatch(new RegExp(`check \\(environment in \\(${quoted}\\)\\)`));
    });

    it("types the policy as a JSON object with an empty default", () => {
      expect(lower).toMatch(/policy jsonb not null default '\{\}'::jsonb/);
      expect(lower).toMatch(/jsonb_typeof\(policy\) = 'object'/);
    });
  });

  describe("URL safety", () => {
    it("accepts only http and https base URLs", () => {
      expect(lower).toContain("verification_target_base_url_scheme_check");
      expect(sql).toContain("base_url ~* '^https?://'");
    });

    it("rejects a base URL that embeds credentials in its authority", () => {
      expect(lower).toContain("verification_target_base_url_no_credentials_check");
      expect(sql).toContain("base_url !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*@'");
    });

    it("defaults the network class to public", () => {
      expect(lower).toMatch(/network_class text not null default 'public'/);
      expect(lower).toMatch(/check \(network_class in \('public', 'private'\)\)/);
    });

    it("requires an approver and a reason before a private-network target may exist", () => {
      expect(lower).toContain("verification_target_private_requires_approval_check");
      expect(lower).toMatch(/network_class <> 'private'\s+or \(\s+approved_by is not null/);
      expect(lower).toContain("length(btrim(approval_reason)) > 0");
    });
  });

  describe("secret-free credential reference", () => {
    it("constrains the reference kind to the closed vocabulary", () => {
      expect(lower).toContain("verification_target_auth_kind_check");
      const quoted = AUTH_KINDS.map((k) => `'${k}'`).join(",\\s*");
      expect(lower).toMatch(new RegExp(`check \\(auth_kind in \\(${quoted}\\)\\)`));
    });

    it("constrains the presentation scheme to the closed vocabulary", () => {
      expect(lower).toContain("verification_target_auth_scheme_check");
      const quoted = AUTH_SCHEMES.map((s) => `'${s}'`).join(",\\s*");
      expect(lower).toMatch(new RegExp(`auth_scheme in \\(${quoted}\\)`));
    });

    it("keeps a 'none' reference completely empty", () => {
      expect(lower).toMatch(
        /verification_target_auth_none_is_empty_check\s+check \(\s+auth_kind <> 'none'\s+or \(auth_scheme is null and auth_ref is null and auth_header_name is null\)/,
      );
    });

    it("requires a presentation scheme whenever a credential is referenced", () => {
      expect(lower).toMatch(
        /verification_target_auth_requires_scheme_check\s+check \(auth_kind = 'none' or auth_scheme is not null\)/,
      );
    });

    it("forces an env reference to be a variable NAME, which no token can satisfy", () => {
      expect(lower).toContain("verification_target_auth_env_ref_shape_check");
      expect(sql).toContain("auth_ref ~ '^[A-Z_][A-Z0-9_]*$'");
    });

    it("forces a stored reference to be a credential-vault UUID", () => {
      expect(lower).toContain("verification_target_auth_stored_ref_shape_check");
      expect(sql).toContain(
        "auth_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'",
      );
    });

    it("restricts a header name to the RFC 9110 token grammar, and only for the header scheme", () => {
      expect(lower).toContain("verification_target_auth_header_name_check");
      expect(sql).toContain("auth_header_name ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$'");
      expect(lower).toContain(
        "auth_scheme is distinct from 'header' and auth_header_name is null",
      );
    });

    it("has no column that could hold credential material", () => {
      // A regression guard: the registry stores references. Any column literally named for a
      // secret would break the ticket's central invariant.
      for (const forbidden of [
        "auth_token",
        "auth_secret",
        "password",
        "encrypted_payload",
        "api_key",
      ]) {
        expect(sql).not.toMatch(new RegExp(`^\\s+${forbidden}\\s`, "m"));
      }
    });
  });

  describe("audit ledger", () => {
    it("records every definition change and every target selection", () => {
      expect(lower).toContain("verification_target_audit_action_check");
      for (const action of AUDIT_ACTIONS) {
        expect(lower).toContain(`'${action}'`);
      }
    });

    it("records the outcome, including a denial", () => {
      expect(lower).toMatch(
        /verification_target_audit_outcome_check\s+check \(outcome in \('success', 'denied', 'failure'\)\)/,
      );
    });

    it("requires a refusal to say why", () => {
      expect(lower).toMatch(
        /verification_target_audit_reason_required_check\s+check \(outcome = 'success' or \(reason is not null and length\(btrim\(reason\)\) > 0\)\)/,
      );
    });

    it("distinguishes a user from a CI runner", () => {
      expect(lower).toMatch(
        /verification_target_audit_actor_kind_check\s+check \(actor_kind in \('user', 'api_key', 'system'\)\)/,
      );
    });

    it("types the detail as a JSON object", () => {
      expect(lower).toMatch(/detail jsonb not null default '\{\}'::jsonb/);
      expect(lower).toMatch(/jsonb_typeof\(detail\) = 'object'/);
    });

    it("indexes the tenant ledger and the per-target history", () => {
      expect(lower).toMatch(
        /idx_verification_target_audit_tenant\s+on verification_target_audit \(tenant_id, created_at desc\)/,
      );
      expect(lower).toMatch(
        /idx_verification_target_audit_target\s+on verification_target_audit \(target_id, created_at desc\)/,
      );
    });
  });

  describe("immutability", () => {
    it("installs the shared write-once trigger on the audit table", () => {
      expect(lower).toMatch(
        /create trigger trigger_verification_target_audit_immutable\s+before update on verification_target_audit\s+for each row\s+execute function mcp_forbid_row_mutation\(\)/,
      );
    });

    it("drops the trigger first so the migration is re-runnable", () => {
      expect(lower).toContain(
        "drop trigger if exists trigger_verification_target_audit_immutable on verification_target_audit",
      );
    });

    it("does not redefine the shared V128 guard function", () => {
      expect(lower).not.toContain("create or replace function mcp_forbid_row_mutation");
    });

    it("leaves the target definition itself mutable (a staging URL moves)", () => {
      expect(lower).not.toContain("before update on verification_target\n");
    });
  });

  describe("retention", () => {
    it("defines the audit purge with a 365-day default window", () => {
      expect(lower).toMatch(
        /create or replace function purge_verification_target_audit\(p_retention_days integer default 365\)/,
      );
      expect(lower).toContain("returns integer");
    });

    it("clamps a negative retention window to zero", () => {
      expect(lower).toContain("greatest(p_retention_days, 0)");
    });
  });

  describe("RBAC", () => {
    it("adds verification_targets to the built-in role grids", () => {
      expect(lower).toContain("create or replace function apiome.seed_builtin_roles");
      expect(lower).toMatch(/all_resources text\[\] :=.*'verification_targets'/);
    });

    it("keeps every resource the previous grid granted", () => {
      for (const resource of [
        "projects",
        "versions",
        "classes",
        "properties",
        "paths",
        "types",
        "imports",
        "members",
        "api_keys",
        "billing",
        "lint_findings",
      ]) {
        expect(lower).toMatch(new RegExp(`all_resources text\\[\\] :=.*'${resource}'`));
      }
    });

    it("gives Editor view-only on targets — enough to run, not to redefine", () => {
      expect(lower).toMatch(
        /select v_editor, res, 'view' from unnest\(array\['types','members','billing','verification_targets'\]\)/,
      );
    });

    it("reseeds every existing tenant so the resource lands in all grids", () => {
      expect(lower).toMatch(/for t in select id from apiome\.tenants loop\s+perform apiome\.seed_builtin_roles\(t\.id\)/);
    });
  });
});
