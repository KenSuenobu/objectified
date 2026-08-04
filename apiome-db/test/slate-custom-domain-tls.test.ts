/**
 * Structural assertions over the custom-domain TLS lifecycle migration
 * (Slate 10.1, private-suite#119).
 *
 * V241 extends `apiome.slate_domains` from the *inventory* V186 created into a lifecycle: when
 * the ownership challenge was last checked and what it observed, when the certificate was issued
 * and last measured, what protocol the host actually negotiated, and whether the edge is still
 * permitted to renew it.
 *
 * The suite is DB-free — this package asserts migration SQL structurally, and application against
 * a live database is proven in apiome-rest — so these tests pin the migration's contract. They
 * are weighted toward the three claims the *schema* is what makes true:
 *
 *   1. a verified domain cannot exist without the timestamp that says when (and vice versa), so
 *      no code path can construct an unfalsifiable "verified";
 *   2. an `active` certificate cannot exist without an expiry, because an active certificate with
 *      no expiry is how one lapses with nobody warned;
 *   3. `pending` exists as a state distinct from `provisioning`, so an unverified host is not
 *      rendered as a spinner that can never resolve.
 *
 * Widening a CHECK and adding columns are both backward compatible, so V186 readers keep working;
 * the backfills that make the new constraints validatable against existing rows are asserted too,
 * because a constraint that cannot be added is a migration that fails on somebody's production.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrate.js";

const SCRIPTS_DIR = new URL("../scripts", import.meta.url).pathname;
const MIGRATION = "V241__slate_custom_domain_tls_10_1.sql";

/** Every column the lifecycle adds. */
const ADDED_COLUMNS = [
  "verification_method",
  "verification_checked_at",
  "verification_error",
  "verified_at",
  "certificate_issued_at",
  "certificate_serial",
  "certificate_checked_at",
  "tls_protocol",
  "tls_error",
  "auto_renew",
  "updated_at",
] as const;

let sql = "";
let lower = "";
/** The migration with every `--` comment line removed, so "does it drop anything" asks the SQL. */
let executable = "";

beforeAll(async () => {
  sql = await fs.readFile(path.join(SCRIPTS_DIR, MIGRATION), "utf8");
  lower = sql.toLowerCase();
  executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
});

describe("Slate custom-domain TLS lifecycle migration", () => {
  it("is present in scripts/ and ordered after the managed-hosting migration it extends", async () => {
    const files = await listMigrationFiles(SCRIPTS_DIR);
    expect(files).toContain(MIGRATION);
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf("V186__slate_managed_hosting_2456.sql"),
    );
  });

  it("targets the apiome schema", () => {
    expect(lower).toContain("set search_path to apiome, public");
  });

  it("names the ticket so the schema is traceable to its rationale", () => {
    expect(sql).toContain("Slate 10.1");
    expect(sql).toContain("private-suite#119");
  });

  it("creates no new table — a domain has one challenge and one live certificate", () => {
    expect(sql).not.toContain("CREATE TABLE");
  });

  /* ---------------------------------------------------------------------- */
  /* Additive shape                                                         */
  /* ---------------------------------------------------------------------- */

  it("adds every lifecycle column idempotently", () => {
    for (const column of ADDED_COLUMNS) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });

  it("renames and drops no column, so V186 readers keep working", () => {
    // The rollback notes in the header name DROP COLUMN, which is why this asks the executable
    // half of the file rather than the whole text.
    expect(executable).not.toMatch(/DROP COLUMN/i);
    expect(executable).not.toMatch(/RENAME/i);
  });

  it("defaults auto-renewal on, because a domain nobody has parked should keep working", () => {
    expect(sql).toMatch(/auto_renew\s+BOOLEAN NOT NULL\s*\n?\s*DEFAULT TRUE/);
  });

  /* ---------------------------------------------------------------------- */
  /* Claim 1: verified and verified_at move together                        */
  /* ---------------------------------------------------------------------- */

  it("constrains verified_at to be present exactly when the status says verified", () => {
    expect(sql).toContain("slate_domains_verified_at_check");
    expect(sql).toMatch(/verification_status = 'verified' AND verified_at IS NOT NULL/);
    expect(sql).toMatch(/verification_status <> 'verified' AND verified_at IS NULL/);
  });

  it("backfills verified_at before asserting that constraint over existing rows", () => {
    const update = sql.indexOf("SET verified_at = created_at");
    const constraint = sql.indexOf("slate_domains_verified_at_check");
    expect(update).toBeGreaterThan(-1);
    expect(update).toBeLessThan(constraint);
  });

  it("limits the verification method to the two records a tenant can actually publish", () => {
    expect(sql).toMatch(/verification_method IN \('cname', 'txt'\)/);
  });

  /* ---------------------------------------------------------------------- */
  /* Claim 2: an active certificate has an expiry                           */
  /* ---------------------------------------------------------------------- */

  it("refuses an active certificate with no expiry to renew against", () => {
    expect(sql).toContain("slate_domains_active_tls_expiry_check");
    expect(sql).toMatch(/tls_status <> 'active' OR certificate_expires_at IS NOT NULL/);
  });

  it("demotes any pre-existing active-without-expiry row before asserting it", () => {
    const update = sql.indexOf("SET tls_status = 'provisioning'");
    const constraint = sql.indexOf("slate_domains_active_tls_expiry_check");
    expect(update).toBeGreaterThan(-1);
    expect(update).toBeLessThan(constraint);
  });

  /* ---------------------------------------------------------------------- */
  /* Claim 3: pending is a state of its own                                 */
  /* ---------------------------------------------------------------------- */

  it("widens tls_status with pending and keeps every value V186 allowed", () => {
    expect(sql).toMatch(/tls_status IN \('pending', 'provisioning', 'active', 'error'\)/);
  });

  it("makes pending the default, so an unverified host is not shown as provisioning", () => {
    expect(sql).toMatch(/ALTER COLUMN tls_status SET DEFAULT 'pending'/);
  });

  /* ---------------------------------------------------------------------- */
  /* Indexes                                                                */
  /* ---------------------------------------------------------------------- */

  it("indexes the verified-host lookup the edge performs on every unrecognized SNI", () => {
    expect(sql).toContain("idx_slate_domains_verified_host");
    expect(sql).toMatch(/WHERE verification_status = 'verified'/);
  });

  it("indexes the renewal sweep by expiry over auto-renewing hosts only", () => {
    expect(sql).toContain("idx_slate_domains_renewal");
    expect(sql).toMatch(/WHERE auto_renew AND certificate_expires_at IS NOT NULL/);
  });

  it("creates every index idempotently", () => {
    const creates = sql.match(/CREATE (UNIQUE )?INDEX/g) ?? [];
    const idempotent = sql.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? [];
    expect(creates.length).toBe(idempotent.length);
  });

  /* ---------------------------------------------------------------------- */
  /* Documentation                                                          */
  /* ---------------------------------------------------------------------- */

  it("comments every added column, since these are the fields an operator reads in a incident", () => {
    for (const column of ADDED_COLUMNS) {
      expect(sql).toContain(`COMMENT ON COLUMN apiome.slate_domains.${column} IS`);
    }
  });

  it("records rollback notes for the columns, indexes and the widened CHECK", () => {
    expect(lower).toContain("rollback notes");
    expect(sql).toContain("DROP INDEX IF EXISTS apiome.idx_slate_domains_renewal");
  });
});
