import { readFile } from "node:fs/promises";

import bcrypt from "bcrypt";
import { describe, expect, it } from "vitest";

import { listSeedFiles } from "../src/seed.js";

const SEED_DIR = new URL("../seed/dev", import.meta.url).pathname;

describe("listSeedFiles", () => {
  it("returns the dev seed files in load order", async () => {
    const files = await listSeedFiles(SEED_DIR);
    expect(files).toEqual([
      "001_user.sql",
      "002_tenant.sql",
      "003_membership.sql",
      "004_license.sql",
      "005_api_key.sql",
      "006_sample_project.sql",
      "007_multitenant.sql",
      "008_credential_accounts.sql",
    ]);
  });
});

describe("dev seed contents", () => {
  it("inserts the documented sample identifiers idempotently", async () => {
    const user = await readFile(`${SEED_DIR}/001_user.sql`, "utf8");
    expect(user).toContain("ada@example.com");
    expect(user).toContain("INSERT INTO apiome.users");
    expect(user).toContain("ON CONFLICT");

    const tenant = await readFile(`${SEED_DIR}/002_tenant.sql`, "utf8");
    expect(tenant).toContain("acme-corp");

    const apiKey = await readFile(`${SEED_DIR}/005_api_key.sql`, "utf8");
    expect(apiKey).toContain("sk_devseed00...");

    const license = await readFile(`${SEED_DIR}/004_license.sql`, "utf8");
    expect(license).toContain("INSERT INTO apiome.licenses");
  });

  it("seeds the multi-tenant fixture: one user in three tenants with diverging roles/licenses", async () => {
    const fixture = await readFile(`${SEED_DIR}/007_multitenant.sql`, "utf8");

    // One user across three distinct tenants (OLO-6.4, #4221).
    expect(fixture).toContain("grace@example.com");
    expect(fixture).toContain("aurora-labs");
    expect(fixture).toContain("borealis-studio");
    expect(fixture).toContain("cascade-foundation");

    // Built-in roles must be seeded before the granular role assignments resolve.
    expect(fixture).toContain("apiome.seed_builtin_roles");
    expect(fixture).toContain("INSERT INTO apiome.tenant_user_roles");

    // Owner is expressed via the authoritative tenant_administrators signal.
    expect(fixture).toContain("INSERT INTO apiome.tenant_administrators");

    // Distinct license tiers attached per tenant (Free / Paid / Sponsor).
    expect(fixture).toContain("INSERT INTO apiome.tenant_licenses");
    expect(fixture).toMatch(/l\.name = 'Free'/);
    expect(fixture).toMatch(/l\.name = 'Paid'/);
    expect(fixture).toMatch(/l\.name = 'Sponsor'/);

    // Idempotent, like every other dev seed file.
    expect(fixture).toContain("ON CONFLICT");
  });

  it("seeds bcrypt hashes that actually verify against the documented dev password", async () => {
    // Better Auth verifies the seed hash at sign-in (private-suite#2560, DH-1.2); a hash that
    // does not match "apiome-dev" makes every documented dev login fail with
    // INVALID_EMAIL_OR_PASSWORD, so prove it here instead of at first manual login.
    const hashes = new Set<string>();
    for (const file of ["001_user.sql", "007_multitenant.sql"]) {
      const sql = await readFile(`${SEED_DIR}/${file}`, "utf8");
      const found = sql.match(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/g) ?? [];
      expect(found.length, `${file} should contain a bcrypt hash`).toBeGreaterThan(0);
      for (const hash of found) hashes.add(hash);
    }
    for (const hash of hashes) {
      expect(
        await bcrypt.compare("apiome-dev", hash),
        `hash ${hash} must verify against "apiome-dev"`,
      ).toBe(true);
    }
  });

  it("creates Better Auth credential accounts for the seed users (private-suite#2560)", async () => {
    const credential = await readFile(`${SEED_DIR}/008_credential_accounts.sql`, "utf8");

    // One credential row per seed user, in the V200 account shape.
    expect(credential).toContain("INSERT INTO apiome.account");
    expect(credential).toContain("'credential'");
    expect(credential).toContain("00000000-0000-4000-8000-000000000001"); // Ada
    expect(credential).toContain("00000000-0000-4000-8000-000000000010"); // Grace

    // Heals the pre-#2560 hash that never verified against "apiome-dev" — and only that hash.
    const brokenHash = "$2b$10$ubOFS2D0e.u2pYFxsDowfOgqXTOHv6fSF1ZuKi.VVaz301rnaLqVG";
    expect(await bcrypt.compare("apiome-dev", brokenHash)).toBe(false);
    expect(credential).toContain("UPDATE apiome.users");
    expect(credential).toContain(brokenHash);

    // The empty-string "no usable credential" sentinel must never become a login (V200's rule),
    // and re-running must converge instead of erroring.
    expect(credential).toContain("u.password <> ''");
    expect(credential).toContain('ON CONFLICT ("providerId", "accountId")');
  });
});
