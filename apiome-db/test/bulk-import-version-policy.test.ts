/**
 * Structural assertions over the batch-reconciliation policy migration (#5524, BLK-1.2).
 *
 * V247 gives the bulk-import plan the two things it needs from the database to answer
 * "does a project for this spec already exist?":
 *
 *   - `apiome.tenants.bulk_import_version_policy` — the tenant default, NOT NULL so every
 *     tenant has one, defaulted to the useful behaviour (`append-when-matched`);
 *   - `apiome.tenant_repositories.bulk_import_version_policy` — the per-repository override,
 *     deliberately **nullable** because NULL is "no opinion, inherit the tenant", the state
 *     every existing repository is in;
 *   - a partial index over the MFI-29.3 git provenance already stored on
 *     `apiome.versions.format_metadata`, which nothing read back until now.
 *
 * The resolution itself lives in apiome-rest (`app/bulk_import_reconciliation.py`); this SQL
 * only has to be additive, defaulted, constrained to the closed vocabulary, and indexed.
 *
 * DB-free contract tests pin the migration shape.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V247__bulk_import_version_policy_blk_1_2.sql";

const POLICIES = ["append-when-matched", "always-create", "always-ask"];

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("bulk-import reconciliation policy migration (BLK-1.2)", () => {
  it("is present in scripts/ and ordered after V246", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V246__style_guide_builtin_reseed_5443.sql"),
    );
  });

  it("targets the apiome schema", () => {
    expect(lower).toContain("set search_path to apiome, public");
  });

  it("documents the rollback", () => {
    expect(lower).toContain(
      "alter table apiome.tenants drop column if exists bulk_import_version_policy",
    );
    expect(lower).toContain(
      "alter table apiome.tenant_repositories drop column if exists bulk_import_version_policy",
    );
    expect(lower).toContain("drop index if exists apiome.idx_versions_git_provenance_path");
  });

  it("adds columns rather than tables — nothing here needs its own row store", () => {
    expect(lower).not.toMatch(/create table/);
  });

  describe("tenant default", () => {
    it("is NOT NULL and defaults to append-when-matched", () => {
      expect(lower).toMatch(
        /alter table apiome\.tenants\s+add column if not exists bulk_import_version_policy varchar\(32\) not null\s+default 'append-when-matched'/,
      );
    });

    it("is constrained to the closed vocabulary", () => {
      const constraint = lower.slice(lower.indexOf("ck_tenants_bulk_import_version_policy"));
      for (const policy of POLICIES) {
        expect(constraint).toContain(`'${policy}'`);
      }
    });

    it("drops the constraint before adding it, so the migration is re-runnable", () => {
      expect(lower).toContain(
        "drop constraint if exists ck_tenants_bulk_import_version_policy",
      );
    });

    it("is documented as a column comment", () => {
      expect(lower).toContain("comment on column apiome.tenants.bulk_import_version_policy");
    });
  });

  describe("repository override", () => {
    it("is nullable, so an existing repository can mean 'no opinion'", () => {
      const addColumn = lower.match(
        /alter table apiome\.tenant_repositories\s+add column if not exists bulk_import_version_policy[^;]*;/,
      );
      expect(addColumn).not.toBeNull();
      // No NOT NULL and no DEFAULT: either would invent an opinion for every repository that
      // already exists, and the plan could then never tell inherited from deliberate.
      expect(addColumn![0]).not.toContain("not null");
      expect(addColumn![0]).not.toContain("default");
      expect(addColumn![0]).toContain("varchar(32)");
    });

    it("permits NULL alongside the closed vocabulary", () => {
      const constraint = lower.slice(
        lower.indexOf("ck_tenant_repositories_bulk_import_version_policy"),
      );
      expect(constraint).toContain("bulk_import_version_policy is null");
      for (const policy of POLICIES) {
        expect(constraint).toContain(`'${policy}'`);
      }
    });

    it("is documented as a column comment", () => {
      expect(lower).toContain(
        "comment on column apiome.tenant_repositories.bulk_import_version_policy",
      );
    });
  });

  describe("provenance index", () => {
    it("keys the MFI-29.3 provenance path first, then the repository", () => {
      expect(lower).toMatch(
        /create index if not exists idx_versions_git_provenance_path\s+on apiome\.versions \(\(format_metadata ->> 'gitpath'\), \(format_metadata ->> 'gitrepourl'\)\)/,
      );
    });

    it("is partial, so it covers only git-sourced revisions", () => {
      expect(lower).toContain("where format_metadata ->> 'gitpath' is not null");
    });

    it("is documented", () => {
      expect(sql).toContain("COMMENT ON INDEX apiome.idx_versions_git_provenance_path");
    });
  });
});
