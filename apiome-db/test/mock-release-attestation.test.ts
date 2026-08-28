/**
 * Structural assertions over the release-proof mock attestation migration (#4749, PMR-3.2).
 *
 * V249 adds `apiome.verification_run_mock`: the one row per verification run that says *which*
 * mock backed it. Without it, a run recorded against a `mock` environment can only claim the mock
 * passed — the bundle may since have been rebuilt, the runtime may have been a different version,
 * and the conformance corpus may never have run at all.
 *
 * DB-free contract tests pin the migration shape, concentrating on the guarantees the ticket's
 * acceptance criteria turn into schema rules rather than habits:
 *
 *   * only immutable digests are linked — bundle and corpus digests are CHECKed to the
 *     `sha256:<64 hex>` form the platform's other digests already take;
 *   * a `verified` row names what verified it: a bundle, a runtime version, a corpus, and no
 *     failures;
 *   * anything not `verified` states why — a closed `reason_code` vocabulary, required by CHECK,
 *     which is what makes "missing" a recorded fact rather than an absence;
 *   * the attestation is immutable and tenant-scoped exactly like the V212 evidence tables, via the
 *     shared write-once trigger and a composite foreign key rather than trust.
 *
 * These must stay in lock-step with apiome-rest's `app.mock_attestation` contract
 * (`MOCK_STATUSES`, `REASON_CODES`, `DIGEST_PATTERN`).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V249__mock_release_attestation_4749.sql";
const TABLE = "verification_run_mock";

/** The closed status vocabulary from the PMR-3.2 contract. */
const STATUSES = ["verified", "failed", "missing"] as const;
/** The closed reason vocabulary a non-verified status must state. */
const REASON_CODES = [
  "mock-conformance-failed",
  "mock-conformance-missing",
  "mock-attestation-missing",
] as const;

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("mock release attestation migration", () => {
  it("is present in scripts/ and ordered after the evidence tables it hangs off", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V212__verification_evidence_4731.sql"),
    );
  });

  it("targets the apiome schema and creates the table idempotently", () => {
    expect(lower).toContain("set search_path to apiome, public");
    expect(lower).toMatch(new RegExp(`create table if not exists ${TABLE} \\(`));
  });

  it("uses uuid_generate_v4 conventions (no gen_random_uuid)", () => {
    expect(lower).toContain("uuid_generate_v4()");
    expect(lower).not.toContain("gen_random_uuid");
  });

  describe("only immutable digests are linked", () => {
    it("holds the bundle digest to the sha256:<hex> form", () => {
      expect(lower).toContain(
        "check (bundle_digest is null or bundle_digest ~ '^sha256:[0-9a-f]{64}$')",
      );
    });

    it("holds the corpus digest to the same form", () => {
      expect(lower).toContain(
        "check (corpus_digest is null or corpus_digest ~ '^sha256:[0-9a-f]{64}$')",
      );
    });
  });

  describe("the verdict cannot contradict its parts", () => {
    it("admits only the three statuses the contract defines", () => {
      for (const status of STATUSES) {
        expect(lower).toContain(`'${status}'`);
      }
      expect(lower).toMatch(/check \(status in \('verified', 'failed', 'missing'\)\)/);
    });

    it("requires a verified row to name its bundle, runtime, corpus, and a clean result", () => {
      expect(lower).toContain("bundle_digest is not null");
      expect(lower).toContain("runtime_version is not null");
      expect(lower).toContain("corpus_digest is not null");
      expect(lower).toContain("conformance_failed = 0");
      expect(lower).toContain("conformance_total > 0");
    });

    it("requires a failed row to name the corpus that failed it", () => {
      expect(lower).toMatch(
        /check \(status <> 'failed' or \(corpus_digest is not null and conformance_failed > 0\)\)/,
      );
    });

    it("keeps the counts adding up", () => {
      expect(lower).toContain(
        "check (conformance_passed + conformance_failed = conformance_total)",
      );
    });
  });

  describe("a gap is explicit", () => {
    it("requires a reason code whenever the status is not verified", () => {
      expect(lower).toMatch(
        /check \(status = 'verified' or reason_code is not null\)/,
      );
    });

    it("admits only the closed reason vocabulary", () => {
      for (const code of REASON_CODES) {
        expect(lower).toContain(`'${code}'`);
      }
    });
  });

  describe("immutable and tenant-scoped, like the evidence it belongs to", () => {
    it("carries the shared write-once trigger", () => {
      expect(lower).toContain(`before update on ${TABLE}`);
      expect(lower).toContain("execute function mcp_forbid_row_mutation()");
    });

    it("pins the row to its parent run's tenant with a composite foreign key", () => {
      expect(lower).toMatch(
        /foreign key \(run_id, tenant_id\)\s+references verification_run \(id, tenant_id\) on delete cascade/,
      );
    });

    it("scopes the row to a tenant of its own, not only through the run", () => {
      expect(lower).toContain(
        "tenant_id uuid not null references tenants(id) on delete cascade",
      );
    });

    it("allows at most one attestation per run", () => {
      expect(lower).toContain("unique (run_id)");
    });
  });

  describe("shape of the JSON columns", () => {
    it("keeps the snapshotted bundle coordinates an object", () => {
      expect(lower).toContain("check (jsonb_typeof(bundle_api) = 'object')");
    });

    it("keeps the failing-case and fixture-pack lists arrays", () => {
      expect(lower).toContain("check (jsonb_typeof(failed_cases) = 'array')");
      expect(lower).toContain("check (jsonb_typeof(fixture_packs) = 'array')");
    });
  });

  it("indexes the question a gate asks: passing mock evidence for this bundle", () => {
    expect(lower).toContain("(tenant_id, bundle_digest, status)");
  });

  it("documents the table and every column", () => {
    expect(sql).toContain(`COMMENT ON TABLE ${TABLE} IS`);
    for (const column of [
      "status",
      "reason_code",
      "bundle_digest",
      "runtime_version",
      "corpus_digest",
      "fixture_packs",
    ]) {
      expect(sql).toContain(`COMMENT ON COLUMN ${TABLE}.${column} IS`);
    }
  });
});
