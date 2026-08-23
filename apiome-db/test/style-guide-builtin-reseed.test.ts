/**
 * Structural assertions over the built-in style-guide re-seed migration (#5443, FMT-5.5).
 *
 * V159 seeded "Apiome Recommended" from a static list of the rule ids the linter shipped
 * with *at that time*. Every pack registered since was added to the GOV-1.2 catalogue but
 * never to this seed — and because `CompiledStyleGuide.apply` drops a finding whose rule is
 * in the registry but not in the guide, those rules ran and were then discarded for every
 * tenant scoring against the seeded guide.
 *
 * V246 rewrites the seed function from the full current registry. These DB-free contract
 * tests pin the migration's shape (it must still be idempotent, self-healing, and must not
 * steal default status) and pin the rules the earlier seed was missing, so a revert of the
 * fix is visible here rather than only in a score that quietly moves.
 *
 * The authoritative drift check — "the seed list equals the live registry" — lives in
 * apiome-rest (`tests/test_data_contract_lint.py`), which is the only place that can read
 * the registry.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V246__style_guide_builtin_reseed_5443.sql";

/**
 * Rules the V159 seed omitted, with the severity their pack declares. Every one of them was
 * being dropped from scores before this migration; the FMT-5.5 `data-contract` pack is the
 * newest of them and the reason the omission was found.
 */
const PREVIOUSLY_MISSING_RULES: ReadonlyArray<[ruleId: string, severity: string]> = [
  // Data-contract paradigm pack (FMT-5.5, #5443) — the pack this migration ships with.
  ["data-contract.owner-missing", "warning"],
  ["data-contract.owner-unresolvable", "warning"],
  ["data-contract.sla-missing", "warning"],
  ["data-contract.freshness-missing", "info"],
  ["data-contract.retention-undocumented", "info"],
  ["data-contract.quality-rules-missing", "warning"],
  ["data-contract.column-description-coverage", "warning"],
  ["data-contract.primary-key-missing", "warning"],
  ["data-contract.classification-missing", "info"],
  ["data-contract.version-missing", "warning"],
  ["data-contract.status-missing", "info"],
  ["data-contract.server-missing", "warning"],
  // Example-conformance pack (IXH-5.4).
  ["examples.non-conforming-example", "warning"],
  // Intake-stage pack (MFI-29.4 and the IXH-7.7 overlay rules).
  ["intake.unresolved-external-ref", "warning"],
  ["intake.blocked-external-ref", "warning"],
  ["intake.overlay-action-invalid", "warning"],
  ["intake.overlay-unmatched-target", "warning"],
  // GraphQL federation composition rules.
  ["graphql.composition-error", "error"],
  ["graphql.composition-invalid-key", "error"],
  ["graphql.composition-non-shareable-field", "error"],
  ["graphql.composition-unresolvable-selection", "error"],
  // Kubernetes CRD pack (IXH-7.2).
  ["k8s-crd.structural-schema-pruning", "warning"],
  ["k8s-crd.required-field-hygiene", "warning"],
  // LLM tool-bundle pack (IXH-7.3).
  ["llm-tools.duplicate-tool-name", "error"],
  ["llm-tools.tool-missing-description", "warning"],
  ["llm-tools.tool-weak-description", "info"],
  ["llm-tools.param-missing-description", "warning"],
  ["llm-tools.prefer-enum-over-freetext", "info"],
  ["llm-tools.required-field-hygiene", "warning"],
  // Protobuf editions rules (FMT-3.7).
  ["protobuf.editions.closed-enum", "warning"],
  ["protobuf.editions.delimited-encoding", "warning"],
  ["protobuf.editions.legacy-json-format", "warning"],
  ["protobuf.editions.utf8-validation-off", "info"],
  // Arazzo source-version rule.
  ["arazzo.async-source-before-1-1", "error"],
];

/** Rules V159 already seeded, which the re-seed must keep at the same severity. */
const PRESERVED_RULES: ReadonlyArray<[ruleId: string, severity: string]> = [
  ["naming.schema-pascal-case", "warning"],
  ["compatibility.breaking", "error"],
  ["common.type-missing-description", "warning"],
  ["asyncapi.message-missing-payload", "warning"],
  // The rule id carries a typo the code emits; ids are stable identifiers and are never
  // "fixed" by a seed.
  ["arzzo.unresolvable-operation-ref", "error"],
];

describe(`${MIGRATION} — built-in style-guide re-seed`, () => {
  let sql = "";
  let lower = "";

  beforeAll(async () => {
    sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
    lower = sql.toLowerCase();
  });

  it("is registered in the migration sequence", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    const names = files.map((f) => (typeof f === "string" ? f : f.name ?? f.file ?? ""));
    expect(names.some((name) => String(name).endsWith(MIGRATION))).toBe(true);
  });

  it("replaces the seed function rather than defining a second one", () => {
    expect(lower).toMatch(
      /create or replace function apiome\.seed_builtin_style_guide\(p_tenant uuid\)/,
    );
    expect(sql).toContain("'Apiome Recommended'");
  });

  it("stays self-healing: rule rows are rewritten from scratch", () => {
    expect(lower).toMatch(/delete from apiome\.style_guide_rules where guide_id = v_guide/);
  });

  it("still never steals default status from a guide the tenant chose", () => {
    expect(lower).toMatch(
      /not exists \(select 1 from apiome\.style_guides where tenant_id = p_tenant and is_default\)/,
    );
  });

  it("re-seeds every existing tenant so the dropped rules start counting", () => {
    expect(lower).toMatch(/for t in select id from apiome\.tenants loop/);
    expect(lower).toMatch(/perform apiome\.seed_builtin_style_guide\(t\.id\)/);
  });

  it("touches only the builtin guide, never a tenant's custom guides", () => {
    expect(lower).toMatch(/where tenant_id = p_tenant and source = 'builtin'/);
    // The only DELETE is scoped to the builtin guide resolved above.
    const deletes = lower.match(/delete from/g) ?? [];
    expect(deletes).toHaveLength(1);
  });

  it.each(PREVIOUSLY_MISSING_RULES)(
    "seeds the previously dropped rule %s at %s",
    (ruleId, severity) => {
      const row = new RegExp(
        `\\('${ruleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}',\\s*'${severity}'\\)`,
      );
      expect(lower).toMatch(row);
    },
  );

  it.each(PRESERVED_RULES)("keeps the already-seeded rule %s at %s", (ruleId, severity) => {
    const row = new RegExp(
      `\\('${ruleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}',\\s*'${severity}'\\)`,
    );
    expect(lower).toMatch(row);
  });

  it("seeds every rule exactly once", () => {
    const rows = [...sql.matchAll(/\('([a-z0-9.\-]+)',\s*'(?:error|warning|info)'\)/g)].map(
      (m) => m[1],
    );
    expect(rows.length).toBeGreaterThanOrEqual(
      PREVIOUSLY_MISSING_RULES.length + PRESERVED_RULES.length,
    );
    expect(new Set(rows).size).toBe(rows.length);
  });
});
