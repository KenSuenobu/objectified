/**
 * Structural assertions over the conversion evidence-snapshot migration (#4803, CPDO-3.3).
 *
 * V214 stored the bounded manifest *summary* on the reasoning that the graph is reproducible from
 * the source bytes and the defaults — which holds only while both stay put. CPDO-3.3 has to show
 * the exact evidence a conversion was approved with forever, so V215 adds the content-addressed
 * `conversion_evidence_snapshot` table holding each distinct full manifest exactly once, plus a
 * per-conversion `source_hash` on the ledger so a reader can tell "historic evidence" from "the
 * source has changed since".
 *
 * DB-free contract tests pin the migration shape: the content-addressed primary key and its
 * bare-64-hex hash guard (deliberately distinct from the `sha256:`-prefixed V209 source-hash
 * shape), the write-once trigger reusing the shared V128 guard (UPDATE only — DELETE stays open for
 * the tenant cascade and the orphan purge), the additive defaulted `source_hash`, the orphan-only
 * purge function behind the documented retention story, and that nothing disturbs the append-only
 * provenance ledger. These must stay in lock-step with apiome-rest's
 * `app.conversion_projection.ConversionManifest`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V215__conversion_evidence_snapshot_4803.sql";

/** Columns the apiome-rest DAO inserts and selects for a snapshot row. */
const SNAPSHOT_COLUMNS = [
  "tenant_id",
  "manifest_hash",
  "schema_version",
  "conversion_mode",
  "source_format",
  "target_format",
  "tool_versions",
  "defaults",
  "manifest",
  "node_count",
  "edge_count",
  "truncated",
  "created_by",
  "created_at",
] as const;

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("conversion evidence snapshot migration", () => {
  it("is present in scripts/ and ordered after V214", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V214__conversion_projection_manifest_4800.sql"),
    );
  });

  it("targets the apiome schema", () => {
    expect(lower).toContain("set search_path to apiome, public");
  });

  describe("the snapshot table", () => {
    it("is created idempotently with every DAO column", () => {
      expect(lower).toMatch(/create table if not exists conversion_evidence_snapshot/);
      for (const column of SNAPSHOT_COLUMNS) {
        expect(lower).toMatch(new RegExp(`\\b${column}\\b`));
      }
    });

    it("is content-addressed: primary key (tenant_id, manifest_hash)", () => {
      expect(lower).toMatch(/primary key \(tenant_id, manifest_hash\)/);
    });

    it("cascades on tenant hard-delete and detaches from deleted users", () => {
      expect(lower).toMatch(/references tenants\(id\) on delete cascade/);
      expect(lower).toMatch(/references users\(id\) on delete set null/);
    });

    it("guards the hash as bare 64-hex, matching the app's manifest hash (no sha256: prefix)", () => {
      expect(lower).toContain("conversion_evidence_snapshot_hash_shape_check");
      expect(lower).toMatch(/manifest_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
    });

    it("guards every JSONB container as an object", () => {
      expect(lower).toContain("conversion_evidence_snapshot_manifest_object_check");
      expect(lower).toMatch(/jsonb_typeof\(manifest\) = 'object'/);
      expect(lower).toContain("conversion_evidence_snapshot_tool_versions_object_check");
      expect(lower).toMatch(/jsonb_typeof\(tool_versions\) = 'object'/);
      expect(lower).toContain("conversion_evidence_snapshot_defaults_object_check");
      expect(lower).toMatch(/jsonb_typeof\(defaults\) = 'object'/);
    });

    it("guards the hoisted counts as non-negative", () => {
      expect(lower).toContain("conversion_evidence_snapshot_counts_check");
      expect(lower).toMatch(/node_count >= 0 and edge_count >= 0/);
    });

    it("deliberately has no FK to conversion_provenance", () => {
      // A pre-V215 provenance row has no snapshot; "snapshot missing" must be a reportable state,
      // not a broken reference, and the join key is the content address itself.
      expect(lower).not.toMatch(/references conversion_provenance/);
    });

    it("is documented, table and columns both", () => {
      expect(lower).toMatch(/comment on table conversion_evidence_snapshot is/);
      for (const column of SNAPSHOT_COLUMNS) {
        expect(lower).toMatch(
          new RegExp(`comment on column conversion_evidence_snapshot\\.${column} is`),
        );
      }
    });
  });

  describe("write-once immutability", () => {
    it("rejects UPDATE via the shared V128 guard", () => {
      expect(lower).toMatch(
        /create trigger trigger_conversion_evidence_snapshot_immutable\s+before update on conversion_evidence_snapshot/,
      );
      expect(lower).toMatch(/execute function mcp_forbid_row_mutation\(\)/);
    });

    it("leaves DELETE open for the tenant cascade and the orphan purge", () => {
      // BEFORE UPDATE only — no `or delete` on the snapshot trigger.
      expect(lower).not.toMatch(/before update or delete on conversion_evidence_snapshot/);
      expect(lower).not.toMatch(/before delete on conversion_evidence_snapshot/);
    });
  });

  describe("the per-conversion source digest", () => {
    it("is added idempotently and defaulted so V139 rows stay readable", () => {
      expect(lower).toMatch(
        /alter table conversion_provenance\s+add column if not exists source_hash text not null default ''/,
      );
    });

    it("carries the V209 sha256-prefixed shape, or the empty degrade state", () => {
      expect(lower).toContain("conversion_provenance_source_hash_shape_check");
      expect(lower).toMatch(/source_hash = '' or source_hash ~ '\^sha256:\[0-9a-f\]\{64\}\$'/);
    });

    it("adds the constraint conditionally so a re-run is not an error", () => {
      expect(lower).toContain("from pg_constraint");
      expect(lower).toContain("conname = 'conversion_provenance_source_hash_shape_check'");
    });

    it("is documented", () => {
      expect(lower).toMatch(/comment on column conversion_provenance\.source_hash is/);
    });
  });

  describe("retention", () => {
    it("ships the defensive purge with a 90-day default", () => {
      expect(lower).toMatch(
        /create or replace function purge_conversion_evidence_snapshots\(p_retention_days integer default 90\)/,
      );
    });

    it("purges only snapshots no provenance row references", () => {
      expect(lower).toMatch(/delete from apiome\.conversion_evidence_snapshot/);
      expect(lower).toMatch(/not exists/);
      expect(lower).toMatch(/cp\.projection_manifest_hash = s\.manifest_hash/);
      expect(lower).toMatch(/cp\.tenant_id = s\.tenant_id/);
    });

    it("scans by age via the created_at index", () => {
      expect(lower).toMatch(
        /create index if not exists idx_conversion_evidence_snapshot_created_at/,
      );
      expect(lower).toMatch(/s\.created_at < v_cutoff/);
    });

    it("documents the retention story on the function itself", () => {
      expect(lower).toMatch(/comment on function purge_conversion_evidence_snapshots\(integer\) is/);
      expect(sql).toMatch(/crash orphans/i);
    });
  });

  describe("what it must not disturb", () => {
    it("does not recreate or drop the ledger's append-only trigger", () => {
      expect(lower).not.toContain("trigger trigger_conversion_provenance_immutable");
    });

    it("does not rewrite any stored provenance row", () => {
      expect(lower).not.toMatch(/\bupdate\s+conversion_provenance\b/);
      expect(lower).not.toMatch(/\bdelete\s+from\s+conversion_provenance\b/);
    });

    it("does not touch the V214 summary columns", () => {
      expect(lower).not.toContain("drop column if exists projection_manifest");
      expect(lower).not.toMatch(/alter column projection_manifest/);
    });
  });

  it("documents its rollback", () => {
    expect(lower).toContain("drop table if exists apiome.conversion_evidence_snapshot");
    expect(lower).toContain(
      "drop function if exists apiome.purge_conversion_evidence_snapshots(integer)",
    );
    expect(lower).toContain("drop column if exists source_hash");
    expect(lower).toContain(
      "drop constraint if exists conversion_provenance_source_hash_shape_check",
    );
  });

  it("explains why the graph is now stored and why the digest is per-row", () => {
    // V214 argued "reproducible, so not stored"; V215 must answer why that stopped being enough,
    // and why source_hash lives on the ledger rather than the deduped snapshot.
    expect(sql).toMatch(/unreproducible/i);
    expect(sql).toContain("ConversionManifest");
    expect(sql).toMatch(/byte-different sources/i);
  });
});
