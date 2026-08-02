/**
 * Structural assertions over the breaking-publish guardrail migration (#4478, CTG-3.4).
 *
 * V237 adds `apiome.style_guides.breaking_publish_policy` — the off|warn|block level the
 * publish flow reads through the GOV-1.4 guide chain. The classification and the gate itself
 * live in apiome-rest (Python); this SQL only has to be additive, defaulted to `warn`, and
 * constrained to the closed vocabulary.
 *
 * DB-free contract tests pin the migration shape.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V237__breaking_publish_policy_ctg_3_4.sql";

let sql = "";
let lower = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("breaking-publish guardrail migration (CTG-3.4)", () => {
  it("is present in scripts/ and ordered after V236", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V236__style_guide_revisions_4432.sql"),
    );
  });

  it("targets the apiome schema", () => {
    expect(lower).toContain("set search_path to apiome, public");
  });

  it("documents the rollback", () => {
    expect(lower).toContain(
      "alter table apiome.style_guides drop column if exists breaking_publish_policy",
    );
  });

  describe("column", () => {
    it("is added to style_guides, not a new table", () => {
      expect(lower).toMatch(
        /alter table apiome\.style_guides\s+add column if not exists breaking_publish_policy text not null default 'warn'/,
      );
      expect(lower).not.toMatch(/create table/);
    });

    it("defaults to warn so existing guides adopt the specified behavior", () => {
      expect(lower).toContain("default 'warn'");
    });

    it("is documented with a column comment naming the ticket", () => {
      expect(lower).toContain("comment on column style_guides.breaking_publish_policy");
      expect(sql).toMatch(/CTG-3\.4, #4478/);
    });
  });

  describe("constraint", () => {
    it("restricts the level to off | warn | block", () => {
      expect(lower).toMatch(
        /check \(breaking_publish_policy in \('off', 'warn', 'block'\)\)/,
      );
    });

    it("is guarded so re-running the migration is a no-op", () => {
      expect(lower).toContain("style_guides_breaking_publish_policy_ck");
      expect(lower).toMatch(/if not exists \(\s*select 1\s*from pg_constraint/);
    });
  });
});
