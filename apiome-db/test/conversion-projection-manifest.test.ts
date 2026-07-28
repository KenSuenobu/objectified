/**
 * Structural assertions over the conversion projection-manifest migration (#4800, CPDO-1.3).
 *
 * V139 records how *good* a conversion was — the fidelity report and its score/grade/tier — and
 * nothing about *what became what*. Two conversions of one catalog item can score identically and
 * still differ in which operations were dropped and which pointers were synthesized. V214 adds the
 * snapshot that tells them apart: `projection_manifest_hash` (the content-addressed id, hoisted
 * into its own column so "did anything change?" is one indexed equality test) and
 * `projection_manifest` (the bounded `ConversionManifestSummary`).
 *
 * DB-free contract tests pin the migration shape: that both columns are additive and defaulted (so
 * every V139 row stays readable as "committed before manifests existed"), that the JSONB column
 * carries the same object guard the table's other contract containers carry, that the lookup index
 * excludes the empty pre-CPDO-1.3 hash, and that nothing disturbs the append-only trigger the
 * ledger's immutability rests on. These must stay in lock-step with apiome-rest's
 * `app.conversion_projection.ConversionManifestSummary`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V214__conversion_projection_manifest_4800.sql";

/** Columns the apiome-rest DAO selects and inserts for this snapshot. */
const COLUMNS = ["projection_manifest_hash", "projection_manifest"] as const;

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("conversion projection manifest migration", () => {
  it("is present in scripts/ and ordered after V213", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V213__verification_policy_4734.sql"),
    );
  });

  it("targets the apiome schema", () => {
    expect(lower).toContain("set search_path to apiome, public");
  });

  describe("the columns", () => {
    it("are added idempotently to the existing conversion ledger", () => {
      for (const column of COLUMNS) {
        expect(lower).toMatch(
          new RegExp(`alter table conversion_provenance\\s+add column if not exists ${column}`),
        );
      }
    });

    it("default so every V139 row stays readable as 'no manifest was recorded'", () => {
      // The empty hash is distinguishable from any real one (always 64 hex chars) without needing
      // a nullable column, and the empty object is what the app reads as an absent summary.
      expect(lower).toMatch(/projection_manifest_hash text not null default ''/);
      expect(lower).toMatch(/projection_manifest jsonb not null default '\{\}'::jsonb/);
    });

    it("guards the JSONB shape the way the ledger's other containers are guarded", () => {
      expect(lower).toContain("conversion_provenance_projection_manifest_object_check");
      expect(lower).toMatch(/jsonb_typeof\(projection_manifest\) = 'object'/);
    });

    it("adds the constraint conditionally so a re-run is not an error", () => {
      expect(lower).toContain("from pg_constraint");
      expect(lower).toContain(
        "conname = 'conversion_provenance_projection_manifest_object_check'",
      );
    });

    it("are documented", () => {
      for (const column of COLUMNS) {
        expect(lower).toMatch(
          new RegExp(`comment on column conversion_provenance\\.${column} is`),
        );
      }
    });
  });

  describe("the snapshot lookup index", () => {
    it("is tenant-scoped and created idempotently", () => {
      expect(lower).toMatch(
        /create index if not exists idx_conversion_provenance_manifest_hash/,
      );
      expect(lower).toMatch(
        /on apiome\.conversion_provenance\(tenant_id, projection_manifest_hash\)/,
      );
    });

    it("excludes the empty pre-CPDO-1.3 hash so it is not one large useless bucket", () => {
      expect(lower).toMatch(/where projection_manifest_hash <> ''/);
    });
  });

  describe("what it must not disturb", () => {
    it("does not recreate or drop the append-only trigger", () => {
      // ADD COLUMN is DDL, not a row UPDATE, so V139's immutability trigger keeps guarding every
      // existing row while the columns land.
      expect(lower).not.toContain("create trigger");
      expect(lower).not.toContain("drop trigger");
    });

    it("does not rewrite any stored provenance row", () => {
      expect(lower).not.toMatch(/\bupdate\s+conversion_provenance\b/);
      expect(lower).not.toMatch(/\bdelete\s+from\s+conversion_provenance\b/);
    });

    it("leaves the fidelity report columns alone", () => {
      expect(lower).not.toContain("drop column if exists fidelity_report");
      expect(lower).not.toMatch(/alter column fidelity/);
    });
  });

  it("documents its rollback", () => {
    for (const column of COLUMNS) {
      expect(lower).toContain(`drop column if exists ${column}`);
    }
    expect(lower).toContain(
      "drop constraint if exists conversion_provenance_projection_manifest_object_check",
    );
    expect(lower).toContain("drop index if exists apiome.idx_conversion_provenance_manifest_hash");
  });

  it("explains why the graph is not stored", () => {
    // The reviewer's question is "why only the summary?" — the answer must be in the migration.
    expect(sql).toMatch(/reproducible/i);
    expect(sql).toContain("ConversionManifestSummary");
  });
});
