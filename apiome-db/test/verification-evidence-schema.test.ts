/**
 * Structural assertions over the verification-evidence migration (#4731, ECA-1.3).
 *
 * V212 adds the four tables that turn a contract run from runner output into records a gate can
 * read and an auditor can trust: `apiome.verification_run`, `verification_run_operation`,
 * `verification_run_assertion`, and `verification_run_artifact`.
 *
 * DB-free contract tests pin the migration shape, concentrating on the guarantees the ticket's
 * acceptance criteria turn into schema rules rather than habits:
 *
 *   * a run retains the suite digest, the target identity, timing, the outcome, and counts that
 *     cannot contradict either the parts or the verdict;
 *   * an operation that did not pass must carry a failure code, and so must a failed assertion;
 *   * an artifact is *linked* (never a `data:` URI), never credential-bearing, and structurally
 *     always redacted;
 *   * evidence is immutable — every table carries the shared write-once trigger — and tenant-scoped
 *     all the way down, via composite foreign keys rather than trust.
 *
 * These must stay in lock-step with apiome-rest's `app.verification_evidence` contract
 * (`RUN_OUTCOMES`, `OPERATION_OUTCOMES`, `ASSERTION_KINDS`, `ARTIFACT_KINDS`) and with the RBAC
 * vocabulary in `app.permissions.RESOURCES`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V212__verification_evidence_4731.sql";

/** Every evidence table, in dependency order. */
const TABLES = [
  "verification_run",
  "verification_run_operation",
  "verification_run_assertion",
  "verification_run_artifact",
] as const;

/** The closed run-verdict vocabulary from the ECA-1.3 contract. */
const RUN_OUTCOMES = ["passed", "failed", "errored", "cancelled"] as const;
/** The closed per-case outcome vocabulary. */
const OPERATION_OUTCOMES = ["passed", "failed", "errored", "skipped"] as const;
/** The closed assertion-kind vocabulary. */
const ASSERTION_KINDS = [
  "status_code",
  "response_schema",
  "header",
  "content_type",
  "latency",
  "custom",
] as const;
/** The closed artifact-kind vocabulary. */
const ARTIFACT_KINDS = [
  "request",
  "response",
  "log",
  "har",
  "report",
  "diff",
  "other",
] as const;

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("verification evidence migration", () => {
  it("is present in scripts/ and ordered after V211", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V211__verification_target_registry_4730.sql"),
    );
  });

  it("targets the apiome schema and creates every table idempotently", () => {
    expect(lower).toContain("set search_path to apiome, public");
    for (const table of TABLES) {
      expect(lower).toMatch(new RegExp(`create table if not exists ${table} \\(`));
    }
  });

  it("uses uuid_generate_v4 conventions (no gen_random_uuid)", () => {
    expect(lower).toContain("uuid_generate_v4()");
    expect(lower).not.toContain("gen_random_uuid");
  });

  describe("tenant scoping", () => {
    it("scopes every evidence row to a tenant, not only the run", () => {
      const scoped = lower.match(
        /tenant_id uuid not null references tenants\(id\) on delete cascade/g,
      );
      expect(scoped).toHaveLength(TABLES.length);
    });

    it("pins each child row to its parent's tenant with a composite foreign key", () => {
      // A CHECK cannot express "child tenant = parent tenant" without a subquery; these do.
      expect(lower).toMatch(
        /foreign key \(run_id, tenant_id\)\s+references verification_run \(id, tenant_id\) on delete cascade/,
      );
      expect(lower).toMatch(
        /foreign key \(operation_id, tenant_id\)\s+references verification_run_operation \(id, tenant_id\) on delete cascade/,
      );
    });

    it("declares the composite keys those foreign keys reference", () => {
      expect(lower).toContain("verification_run_id_tenant_key unique (id, tenant_id)");
      expect(lower).toContain(
        "verification_run_operation_id_tenant_key unique (id, tenant_id)",
      );
    });
  });

  describe("what a run retains", () => {
    it("defines every column from the ECA-1.3 run field set", () => {
      for (const col of [
        "id",
        "tenant_id",
        "suite_digest",
        "suite_schema_version",
        "suite_compiler_version",
        "suite_case_count",
        "target_id",
        "target_slug",
        "target_environment",
        "target_network_class",
        "target_base_url",
        "runner_name",
        "runner_version",
        "recorded_by",
        "actor_label",
        "actor_kind",
        "started_at",
        "finished_at",
        "duration_ms",
        "outcome",
        "total_cases",
        "passed_cases",
        "failed_cases",
        "errored_cases",
        "skipped_cases",
        "source",
        "context",
        "idempotency_key",
        "created_at",
      ]) {
        expect(sql).toMatch(new RegExp(`^\\s+${col}\\s`, "m"));
      }
    });

    it("requires the suite digest to be the ECA-1.1 compiler form", () => {
      expect(lower).toContain("verification_run_suite_digest_shape_check");
      expect(sql).toContain("suite_digest ~ '^sha256:[0-9a-f]{64}$'");
    });

    it("snapshots the target identity so a retired target keeps resolving", () => {
      expect(lower).toMatch(
        /target_id uuid references verification_target\(id\) on delete set null/,
      );
      expect(sql).toMatch(/^\s+target_slug VARCHAR\(128\) NOT NULL,/m);
      expect(sql).toMatch(/^\s+target_base_url TEXT NOT NULL,/m);
    });

    it("records both ends of the run window and refuses a backwards one", () => {
      expect(sql).toMatch(/^\s+started_at TIMESTAMP WITH TIME ZONE NOT NULL,/m);
      expect(sql).toMatch(/^\s+finished_at TIMESTAMP WITH TIME ZONE NOT NULL,/m);
      expect(lower).toMatch(
        /verification_run_window_check check \(finished_at >= started_at\)/,
      );
    });

    it("constrains the verdict to the closed ECA-1.3 vocabulary", () => {
      expect(lower).toContain("verification_run_outcome_check");
      const quoted = RUN_OUTCOMES.map((o) => `'${o}'`).join(",\\s*");
      expect(lower).toMatch(new RegExp(`check \\(outcome in \\(${quoted}\\)\\)`));
    });

    it("makes the counts add up to the total", () => {
      expect(lower).toMatch(
        /verification_run_counts_sum_check\s+check \(passed_cases \+ failed_cases \+ errored_cases \+ skipped_cases = total_cases\)/,
      );
    });

    it("refuses a verdict its own counts contradict", () => {
      // "A run with a failed case is not passed" — enforced, not merely computed correctly.
      expect(lower).toContain("verification_run_outcome_agrees_check");
      expect(lower).toContain("(outcome = 'passed' and errored_cases = 0 and failed_cases = 0)");
      expect(lower).toContain("(outcome = 'errored' and errored_cases > 0)");
      // A cancelled run stopped early, so its counts describe only what it reached.
      expect(lower).toContain("outcome = 'cancelled'");
    });

    it("distinguishes a user from a CI runner", () => {
      expect(lower).toMatch(
        /verification_run_actor_kind_check\s+check \(actor_kind in \('user', 'api_key', 'system'\)\)/,
      );
    });

    it("types the provenance and CI context as JSON objects", () => {
      expect(lower).toMatch(/source jsonb not null default '\{\}'::jsonb/);
      expect(lower).toMatch(/context jsonb not null default '\{\}'::jsonb/);
      expect(lower).toMatch(/jsonb_typeof\(source\) = 'object'/);
      expect(lower).toMatch(/jsonb_typeof\(context\) = 'object'/);
    });

    it("keeps a retried upload from minting a second run", () => {
      expect(lower).toMatch(
        /create unique index if not exists idx_verification_run_tenant_idempotency\s+on verification_run \(tenant_id, idempotency_key\)\s+where idempotency_key is not null/,
      );
    });

    it("indexes the reads a gate performs", () => {
      expect(lower).toMatch(
        /idx_verification_run_tenant_digest\s+on verification_run \(tenant_id, suite_digest, created_at desc\)/,
      );
      expect(lower).toMatch(
        /idx_verification_run_target\s+on verification_run \(target_id, created_at desc\)/,
      );
    });
  });

  describe("operation-level failures", () => {
    it("names the compiled case and its operation, so evidence traces back to the suite", () => {
      for (const col of ["case_id", "operation_key", "http_method", "http_path", "case_source"]) {
        expect(sql).toMatch(new RegExp(`^\\s+${col}\\s`, "m"));
      }
    });

    it("constrains the case outcome to the closed vocabulary", () => {
      expect(lower).toContain("verification_run_operation_outcome_check");
      const quoted = OPERATION_OUTCOMES.map((o) => `'${o}'`).join(",\\s*");
      expect(lower).toMatch(new RegExp(`check \\(outcome in \\(${quoted}\\)\\)`));
    });

    it("requires anything that did not pass to say why", () => {
      expect(lower).toMatch(
        /verification_run_operation_failure_reason_check\s+check \(\s+outcome in \('passed', 'skipped'\)\s+or \(failure_code is not null and length\(btrim\(failure_code\)\) > 0\)/,
      );
    });

    it("refuses a passing case that carries a failure code", () => {
      expect(lower).toMatch(
        /verification_run_operation_passed_is_clean_check\s+check \(outcome <> 'passed' or failure_code is null\)/,
      );
    });

    it("keeps the recorded order stable, because an export must reproduce it", () => {
      expect(lower).toContain(
        "verification_run_operation_sequence_key unique (run_id, sequence)",
      );
      expect(lower).toMatch(
        /idx_verification_run_operation_run\s+on verification_run_operation \(run_id, sequence\)/,
      );
    });

    it("bounds a recorded status to the HTTP range", () => {
      expect(lower).toContain("actual_status >= 100 and actual_status <= 599");
    });

    it("records transport attempts, which never mask a contract failure", () => {
      expect(lower).toMatch(/attempts integer not null default 1/);
      expect(lower).toContain("verification_run_operation_attempts_check check (attempts >= 1)");
    });

    it("indexes the cross-run failure comparison", () => {
      expect(lower).toMatch(
        /idx_verification_run_operation_failures\s+on verification_run_operation \(tenant_id, operation_key, created_at desc\)\s+where outcome <> 'passed'/,
      );
    });
  });

  describe("assertions", () => {
    it("constrains the assertion kind to the closed vocabulary", () => {
      expect(lower).toContain("verification_run_assertion_kind_check");
      for (const kind of ASSERTION_KINDS) {
        expect(lower).toContain(`'${kind}'`);
      }
    });

    it("constrains the assertion outcome to the closed vocabulary", () => {
      expect(lower).toMatch(
        /verification_run_assertion_outcome_check\s+check \(outcome in \('passed', 'failed', 'skipped'\)\)/,
      );
    });

    it("requires a failed assertion to carry a code", () => {
      expect(lower).toMatch(
        /verification_run_assertion_failure_reason_check\s+check \(outcome <> 'failed' or \(code is not null and length\(btrim\(code\)\) > 0\)\)/,
      );
    });

    it("keeps expected and actual as separate readable columns", () => {
      expect(sql).toMatch(/^\s+expected TEXT,/m);
      expect(sql).toMatch(/^\s+actual TEXT,/m);
    });
  });

  describe("artifacts are linked, redacted, and verifiable", () => {
    it("constrains the artifact kind to the closed vocabulary", () => {
      expect(lower).toContain("verification_run_artifact_kind_check");
      const quoted = ARTIFACT_KINDS.map((k) => `'${k}'`).join(",\\s*");
      expect(lower).toMatch(new RegExp(`check \\(kind in \\(${quoted}\\)\\)`));
    });

    it("refuses a data: URI, because that embeds rather than links", () => {
      expect(lower).toContain("verification_run_artifact_uri_not_inline_check");
      expect(sql).toContain("uri !~* '^data:'");
    });

    it("refuses an artifact link that embeds credentials", () => {
      expect(lower).toContain("verification_run_artifact_uri_no_credentials_check");
      expect(sql).toContain("uri !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*@'");
    });

    it("admits only redacted artifacts — there is no representation for an unredacted one", () => {
      expect(lower).toMatch(
        /verification_run_artifact_redacted_check check \(redacted\)/,
      );
    });

    it("lets a reader verify the bytes they fetched", () => {
      expect(lower).toContain("verification_run_artifact_sha_shape_check");
      expect(sql).toContain("content_sha256 ~ '^[0-9a-f]{64}$'");
    });

    it("records what redaction removed as counts, not as values", () => {
      expect(lower).toMatch(/redaction jsonb not null default '\{\}'::jsonb/);
      expect(lower).toMatch(/jsonb_typeof\(redaction\) = 'object'/);
    });

    it("has no column that could hold the artifact itself", () => {
      // A regression guard: evidence points at artifacts, it does not carry them.
      for (const forbidden of ["content", "body", "payload", "bytes", "blob"]) {
        expect(sql).not.toMatch(new RegExp(`^\\s+${forbidden}\\s`, "m"));
      }
    });
  });

  describe("immutability", () => {
    it("installs the shared write-once trigger on every evidence table", () => {
      for (const table of TABLES) {
        expect(lower).toMatch(
          new RegExp(
            `create trigger trigger_${table}_immutable\\s+before update on ${table}\\s+for each row\\s+execute function mcp_forbid_row_mutation\\(\\)`,
          ),
        );
      }
    });

    it("drops each trigger first so the migration is re-runnable", () => {
      for (const table of TABLES) {
        expect(lower).toContain(
          `drop trigger if exists trigger_${table}_immutable on ${table}`,
        );
      }
    });

    it("does not redefine the shared V128 guard function", () => {
      expect(lower).not.toContain("create or replace function mcp_forbid_row_mutation");
    });
  });

  describe("retention", () => {
    it("defines the evidence purge with a 365-day default window", () => {
      expect(lower).toMatch(
        /create or replace function purge_verification_evidence\(p_retention_days integer default 365\)/,
      );
      expect(lower).toContain("returns integer");
    });

    it("purges runs and lets the cascades take their children", () => {
      expect(lower).toContain("delete from apiome.verification_run where created_at < v_cutoff");
    });

    it("clamps a negative retention window to zero", () => {
      expect(lower).toContain("greatest(p_retention_days, 0)");
    });
  });

  describe("RBAC", () => {
    it("adds verification_evidence to the built-in role grids", () => {
      expect(lower).toContain("create or replace function apiome.seed_builtin_roles");
      expect(lower).toMatch(/all_resources text\[\] :=.*'verification_evidence'/);
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
        "verification_targets",
      ]) {
        expect(lower).toMatch(new RegExp(`all_resources text\\[\\] :=.*'${resource}'`));
      }
    });

    it("lets Editor record evidence — a CI runner resolves to that grid", () => {
      expect(lower).toMatch(
        /select v_editor, 'verification_evidence', a from unnest\(array\['view','create'\]\)/,
      );
    });

    it("keeps editing and deleting evidence out of the Editor grid", () => {
      expect(lower).not.toMatch(
        /select v_editor, 'verification_evidence', a from unnest\(array\[[^\]]*'edit'/,
      );
      expect(lower).not.toMatch(
        /select v_editor, 'verification_evidence', a from unnest\(array\[[^\]]*'delete'/,
      );
    });

    it("reseeds every existing tenant so the resource lands in all grids", () => {
      expect(lower).toMatch(
        /for t in select id from apiome\.tenants loop\s+perform apiome\.seed_builtin_roles\(t\.id\)/,
      );
    });
  });
});
