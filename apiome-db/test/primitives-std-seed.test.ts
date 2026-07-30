/**
 * Structural assertions over the std/v0 core-system-types seed migration (#3449).
 *
 * Issue 1.4 seeds the `std/v0/primitives` and `std/v0/types` namespaces as system-wide
 * (is_system) rows in the existing `apiome.primitives` table, with the #3447 registry columns
 * populated and composite types carrying relative $ref chains in `refs`. These tests verify the
 * seed's contract — namespaces, the canonical money/date schemas, $ref edges, and idempotency —
 * without a live database (the package's test suite is DB-free).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, beforeAll } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V113__seed_core_system_primitives_types_std_v0.sql";

let sql = "";
let lower = "";

/** Pull every single-quoted JSON document/array literal out of the migration and JSON.parse it. */
function jsonLiterals(): unknown[] {
  // Match '{...}' or '[...]' single-quoted literals (no escaped quotes appear in this seed).
  const matches = sql.match(/'(\{[^']*\}|\[[^']*\])'/g) ?? [];
  return matches.map((m) => JSON.parse(m.slice(1, -1)));
}

/** Find the parsed JSON Schema document whose $id ends with the given registry path. */
function schemaFor(pathSuffix: string): Record<string, unknown> {
  const doc = jsonLiterals().find(
    (d): d is Record<string, unknown> =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as Record<string, unknown>).$id === "string" &&
      ((d as Record<string, unknown>).$id as string).endsWith(pathSuffix),
  );
  expect(doc, `schema for ${pathSuffix} present`).toBeDefined();
  return doc as Record<string, unknown>;
}

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
});

describe("std/v0 core system types seed migration", () => {
  it("is present in scripts/ and ordered after the #3447/#3448 migrations", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V112__import_provenance_property_primitive_bin.sql"),
    );
  });

  it("seeds into the existing apiome.primitives table — no new table or schema", () => {
    expect(lower).toMatch(/insert into primitives/);
    expect(lower).not.toMatch(/create table/);
    expect(lower).not.toMatch(/create schema/);
  });

  it("seeds both std/v0 namespaces", () => {
    expect(sql).toContain("std/v0/primitives");
    expect(sql).toContain("std/v0/types");
  });

  it("seeds the seven JSON Schema base primitives", () => {
    for (const base of ["string", "number", "integer", "boolean", "null", "array", "object"]) {
      const schema = schemaFor(`/std/v0/primitives/${base}`);
      expect(schema.type).toBe(base);
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("marks every seeded row system-wide and authored, on draft 2020-12", () => {
    // The single INSERT projects literal flags for all seeded rows.
    expect(lower).toMatch(/'2020-12'/);
    expect(lower).toMatch(/'human'/);
    // is_system, is_public projected as `true` (last two SELECT columns).
    expect(lower).toMatch(/true,\s+true\s+from tenants/);
  });

  it("derives base_uri and schema_id from the resolution base", () => {
    // Asserts the literal text of V113, an already-applied migration, so this stays on the host
    // V113 was written with. The registry moved to apiome.dev, and V219 rewrites the rows this seed
    // produced — but editing V113 itself would change its checksum and make every existing database
    // refuse to migrate.
    expect(sql).toContain("'https://api.apiome.app/types/' || s.namespace || '/'");
    expect(sql).toContain("'https://api.apiome.app/types/' || s.namespace || '/' || s.name");
  });

  it("date is the string primitive with format date and a resolved $ref edge", () => {
    const date = schemaFor("/std/v0/types/date");
    expect(date.$ref).toBe("../primitives/string");
    expect(date.format).toBe("date");
    // Its refs edge resolves to the primitive.
    expect(sql).toContain(
      '{"relative_ref":"../primitives/string","resolved_target":"std/v0/primitives/string","status":"resolved"}',
    );
  });

  it("money matches the canonical composite schema (amount/currency $refs)", () => {
    const money = schemaFor("/std/v0/types/money");
    expect(money.type).toBe("object");
    expect(money.additionalProperties).toBe(false);
    expect(money.required).toEqual(["amount", "currency"]);
    const props = money.properties as Record<string, { $ref: string }>;
    expect(props.amount.$ref).toBe("./decimal");
    expect(props.currency.$ref).toBe("./currency-code");
  });

  it("records money's $ref edges resolving to sibling std/v0/types", () => {
    expect(sql).toContain('"relative_ref":"./decimal","resolved_target":"std/v0/types/decimal"');
    expect(sql).toContain(
      '"relative_ref":"./currency-code","resolved_target":"std/v0/types/currency-code"',
    );
  });

  it("every recorded $ref edge is resolved (0 unresolved in the seed graph)", () => {
    expect(lower).not.toContain('"status":"unresolved"');
    expect(lower).not.toContain('"status":"circular"');
    expect(lower).toContain('"status":"resolved"');
  });

  it("every seeded JSON literal is valid JSON", () => {
    expect(() => jsonLiterals()).not.toThrow();
    // 7 primitives + 9 types = 16 schema docs, plus 9 non-empty refs arrays + 7 empty arrays.
    const docs = jsonLiterals().filter(
      (d) => typeof d === "object" && d !== null && "$schema" in (d as object),
    );
    expect(docs).toHaveLength(16);
  });

  it("is idempotent on the legacy uniqueness key", () => {
    expect(lower).toMatch(/on conflict \(tenant_id, category, name\) do nothing/);
  });
});
