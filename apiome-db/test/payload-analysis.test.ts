/**
 * Structural assertions over the revision-scoped payload-analysis migration (#4794, CPDO-1.1).
 *
 * V209 adds `apiome.payload_analysis` — the immutable, append-only record of what an analyzer
 * observed in one source revision — plus the retention sweep that drops what is no longer
 * evidence for anything live.
 *
 * DB-free contract tests pin the migration shape: the tenant/project/revision scoping, the closed
 * status vocabulary, the write-once trigger, the three *truthfulness* CHECK constraints that make
 * "never fabricated data" a schema guarantee rather than a habit, and the retention function's
 * refusal to purge the current analysis of a live revision. These must stay in lock-step with
 * apiome-rest's `app.payload_analysis` contract (`ANALYSIS_STATUSES`,
 * `PayloadAnalysisDocument.contract_violations`).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V209__payload_analysis_4794.sql";

/** The closed status vocabulary from the CPDO-1.1 contract, in migration order. */
const STATUSES = ["available", "partial", "unavailable", "failed"] as const;

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("payload analysis migration", () => {
  it("is present in scripts/ and ordered after V208", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V208__intake_secret_scrub_policy_4393.sql"),
    );
  });

  it("targets the apiome schema and creates the table idempotently", () => {
    expect(lower).toContain("set search_path to apiome, public");
    expect(lower).toMatch(/create table if not exists payload_analysis/);
  });

  it("uses uuid_generate_v4 conventions (no gen_random_uuid)", () => {
    expect(lower).toContain("uuid_generate_v4()");
    expect(lower).not.toContain("gen_random_uuid");
  });

  describe("scoping", () => {
    it("is keyed by tenant, catalog project, and source revision", () => {
      expect(lower).toMatch(
        /tenant_id uuid not null references tenants\(id\) on delete cascade/,
      );
      expect(lower).toMatch(
        /project_id uuid not null references projects\(id\) on delete cascade/,
      );
      expect(lower).toMatch(
        /version_id uuid not null references versions\(id\) on delete cascade/,
      );
    });

    it("keeps at most one analysis per sequence per revision", () => {
      expect(lower).toMatch(
        /payload_analysis_version_sequence_uq\s+unique \(version_id, analysis_sequence\)/,
      );
      expect(lower).toMatch(/payload_analysis_sequence_positive_check\s+check \(analysis_sequence >= 1\)/);
    });

    it("indexes the current-analysis lookup by revision", () => {
      expect(lower).toMatch(
        /idx_payload_analysis_version\s+on payload_analysis \(version_id, analysis_sequence desc\)/,
      );
    });
  });

  describe("contract columns", () => {
    it("defines every column from the CPDO-1.1 field set", () => {
      for (const col of [
        "id",
        "tenant_id",
        "project_id",
        "version_id",
        "analysis_sequence",
        "schema_version",
        "content_fingerprint",
        "source_format",
        "source_hash",
        "analyzer_key",
        "analyzer_version",
        "tool_versions",
        "status",
        "status_reason",
        "tree",
        "metrics",
        "warnings",
        "redaction",
        "created_by",
        "created_at",
      ]) {
        expect(sql).toMatch(new RegExp(`^\\s+${col}\\s`, "m"));
      }
    });

    it("constrains status to the closed CPDO-1.1 vocabulary", () => {
      expect(lower).toContain("payload_analysis_status_check");
      const quoted = STATUSES.map((s) => `'${s}'`).join(",\\s*");
      expect(lower).toMatch(new RegExp(`check \\(status in \\(${quoted}\\)\\)`));
    });

    it("types the tree and warnings as JSON arrays and the rest as JSON objects", () => {
      expect(lower).toMatch(/tree jsonb not null default '\[\]'::jsonb/);
      expect(lower).toMatch(/warnings jsonb not null default '\[\]'::jsonb/);
      expect(lower).toMatch(/jsonb_typeof\(tree\) = 'array'/);
      expect(lower).toMatch(/jsonb_typeof\(warnings\) = 'array'/);
      expect(lower).toMatch(/jsonb_typeof\(metrics\) = 'object'/);
      expect(lower).toMatch(/jsonb_typeof\(redaction\) = 'object'/);
      expect(lower).toMatch(/jsonb_typeof\(tool_versions\) = 'object'/);
    });

    it("requires an algorithm-prefixed sha256 source digest", () => {
      expect(lower).toMatch(/payload_analysis_source_hash_shape_check/);
      expect(sql).toContain("'^sha256:[0-9a-f]{64}$'");
    });
  });

  describe("truthfulness constraints", () => {
    it("requires a record that describes source bytes to name them", () => {
      expect(lower).toMatch(
        /payload_analysis_source_hash_required_check\s+check \(status not in \('available', 'partial'\) or source_hash is not null\)/,
      );
    });

    it("forbids a fabricated tree on a record that describes nothing", () => {
      expect(lower).toMatch(
        /payload_analysis_empty_tree_when_absent_check\s+check \(status not in \('unavailable', 'failed'\) or jsonb_array_length\(tree\) = 0\)/,
      );
    });

    it("requires anything other than available to name a reason", () => {
      expect(lower).toMatch(
        /payload_analysis_reason_required_check\s+check \(status = 'available' or \(status_reason is not null and status_reason <> ''\)\)/,
      );
    });
  });

  describe("immutability", () => {
    it("installs the shared write-once trigger on the table", () => {
      expect(lower).toMatch(
        /create trigger trigger_payload_analysis_immutable\s+before update on payload_analysis\s+for each row\s+execute function mcp_forbid_row_mutation\(\)/,
      );
    });

    it("drops the trigger first so the migration is re-runnable", () => {
      expect(lower).toContain(
        "drop trigger if exists trigger_payload_analysis_immutable on payload_analysis",
      );
    });

    it("does not redefine the shared V128 guard function", () => {
      expect(lower).not.toContain("create or replace function mcp_forbid_row_mutation");
    });
  });

  describe("retention", () => {
    it("defines the purge function with a 90-day default window", () => {
      expect(lower).toMatch(
        /create or replace function purge_payload_analysis\(p_retention_days integer default 90\)/,
      );
      expect(lower).toContain("returns integer");
    });

    it("purges superseded analyses and those of soft-deleted revisions", () => {
      expect(lower).toContain("newer.analysis_sequence > pa.analysis_sequence");
      expect(lower).toContain("v.deleted_at is not null");
    });

    it("never purges by age alone, so a live revision keeps its current analysis", () => {
      // The age predicate is ANDed with the superseded / deleted-revision disjunction; a bare
      // "created_at < cutoff" DELETE would take the catalog record with it.
      expect(lower).toMatch(/delete from apiome\.payload_analysis pa\s+where pa\.created_at < v_cutoff\s+and \(/);
    });

    it("clamps a negative retention window to zero", () => {
      expect(lower).toContain("greatest(p_retention_days, 0)");
    });

    it("indexes created_at so the sweep does not scan the table", () => {
      expect(lower).toMatch(
        /idx_payload_analysis_created_at\s+on payload_analysis \(created_at\)/,
      );
    });
  });

  it("documents the table and every column", () => {
    expect(lower).toContain("comment on table payload_analysis is");
    for (const col of [
      "version_id",
      "analysis_sequence",
      "schema_version",
      "content_fingerprint",
      "source_hash",
      "status",
      "status_reason",
      "tree",
      "redaction",
    ]) {
      expect(lower).toContain(`comment on column payload_analysis.${col} is`);
    }
    expect(lower).toContain("comment on function purge_payload_analysis(integer) is");
  });

  it("documents its rollback", () => {
    expect(lower).toContain("drop table if exists apiome.payload_analysis");
    expect(lower).toContain("drop function if exists apiome.purge_payload_analysis(integer)");
  });
});
