/**
 * Structural assertions over the analyzer-capability migration (#4795, CPDO-1.2).
 *
 * V209 stores what an analyzer *observed*; V210 adds what it *can observe* — the `capabilities`
 * column carrying `{supported[], unsupported[], limits{}}`. Without it a construct missing from a
 * stored tree is ambiguous: a reader cannot tell whether the source had none or the analyzer has no
 * word for one, which is the question every format-detail surface (CPDO-2.1 – 2.4) has to answer.
 *
 * DB-free contract tests pin the migration shape: that the column is additive and defaulted (so
 * every V209 row stays readable), that it carries the same JSONB object guard the contract's other
 * containers carry, and that it is added without touching the write-once trigger the table's
 * immutability rests on. These must stay in lock-step with apiome-rest's
 * `app.payload_analysis.AnalyzerCapabilities`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V210__payload_analysis_capabilities_4795.sql";

/** The keys the apiome-rest `AnalyzerCapabilities` contract serializes. */
const CAPABILITY_KEYS = ["supported", "unsupported", "limits"] as const;

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("payload analysis capabilities migration", () => {
  it("is present in scripts/ and ordered after V209", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V209__payload_analysis_4794.sql"),
    );
  });

  it("targets the apiome schema", () => {
    expect(lower).toContain("set search_path to apiome, public");
  });

  describe("the column", () => {
    it("is added idempotently to the existing analysis table", () => {
      expect(lower).toMatch(
        /alter table payload_analysis\s+add column if not exists capabilities jsonb/,
      );
    });

    it("is NOT NULL with an empty-object default, so every V209 row stays readable", () => {
      // Existing rows predate any analyzer, so "declared no capabilities" is the truthful reading
      // of them — and it is what the app contract's document_from_row produces for an absent value.
      expect(lower).toMatch(/capabilities jsonb not null default '\{\}'::jsonb/);
    });

    it("guards its JSONB shape the way the contract's other containers are guarded", () => {
      expect(lower).toContain("payload_analysis_capabilities_object_check");
      expect(lower).toMatch(/jsonb_typeof\(capabilities\) = 'object'/);
    });

    it("adds the constraint conditionally so a re-run is not an error", () => {
      expect(lower).toContain("from pg_constraint");
      expect(lower).toContain("conname = 'payload_analysis_capabilities_object_check'");
    });

    it("is documented", () => {
      expect(lower).toMatch(/comment on column payload_analysis\.capabilities is/);
      for (const key of CAPABILITY_KEYS) {
        expect(sql).toContain(key);
      }
    });
  });

  describe("what it must not disturb", () => {
    it("does not recreate or drop the write-once trigger", () => {
      // ADD COLUMN is DDL, not a row UPDATE, so the V209 immutability trigger keeps guarding every
      // existing row while the column lands.
      expect(lower).not.toContain("create trigger");
      expect(lower).not.toContain("drop trigger");
    });

    it("does not rewrite any stored analysis", () => {
      expect(lower).not.toMatch(/\bupdate\s+payload_analysis\b/);
      expect(lower).not.toMatch(/\bdelete\s+from\s+payload_analysis\b/);
    });

    it("does not touch the retention function", () => {
      expect(lower).not.toContain("purge_payload_analysis");
    });
  });

  it("documents its rollback", () => {
    expect(lower).toContain("drop column if exists capabilities");
    expect(lower).toContain(
      "drop constraint if exists payload_analysis_capabilities_object_check",
    );
  });
});
