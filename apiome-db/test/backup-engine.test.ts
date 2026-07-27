import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KEY_BYTES } from "../src/backup/crypto.js";
import {
  assertSafeSandboxName,
  listBackups,
  loadDataset,
  pgDumpInvocation,
  pruneBackups,
  serializeDataset,
  writeBackup,
  type LogicalDataset,
  type ResolvedScope,
} from "../src/backup/engine.js";
import { CliError } from "../src/errors.js";

let dir: string;
let offsite: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "apiome-bkp-"));
  offsite = await mkdtemp(path.join(tmpdir(), "apiome-off-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(offsite, { recursive: true, force: true });
});

const scope: ResolvedScope = {
  kind: "tenant",
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenantLabel: "acme",
  projectId: null,
  projectLabel: null,
};

function sampleDataset(): LogicalDataset {
  return {
    scope,
    exportedAt: "2026-06-23T09:47:30.000Z",
    classSchemas: [{ id: "cs1" }],
    events: [
      {
        recordId: "r1",
        recordSequence: 1,
        action: "created",
        data: { hello: "world" },
        createdAt: "2026-06-23T09:40:00.000Z",
      },
    ],
    snapshots: [{ record_id: "r1" }],
  };
}

describe("writeBackup + listBackups + loadDataset (encrypted)", () => {
  it("writes an encrypted artifact + manifest, mirrors off-site, and round-trips", async () => {
    const key = crypto.randomBytes(KEY_BYTES);
    const manifest = await writeBackup({
      dir,
      offsiteDir: offsite,
      id: "tenant-acme-20260623T094730Z",
      kind: "tenant",
      tenant: "acme",
      createdAt: "2026-06-23T09:47:30.000Z",
      rpoMarker: "2026-06-23T09:40:00.000Z",
      body: serializeDataset(sampleDataset()),
      key,
      tableCounts: { data_record: 1 },
      extension: ".json",
    });

    expect(manifest.encrypted).toBe(true);
    expect(manifest.artifact).toMatch(/\.json\.enc$/);

    // Both primary and off-site got the artifact + manifest.
    for (const d of [dir, offsite]) {
      const files = await readdir(d);
      expect(files).toContain(manifest.artifact);
      expect(files).toContain("tenant-acme-20260623T094730Z.manifest.json");
    }

    // Artifact is not plaintext on disk.
    const onDisk = await readFile(path.join(dir, manifest.artifact));
    expect(onDisk.includes(Buffer.from("hello"))).toBe(false);

    const [listed] = await listBackups(dir);
    expect(listed?.id).toBe(manifest.id);

    const dataset = await loadDataset(dir, manifest, key);
    expect(dataset.events[0]?.data).toEqual({ hello: "world" });
  });

  it("loadDataset fails on the wrong key", async () => {
    const key = crypto.randomBytes(KEY_BYTES);
    const manifest = await writeBackup({
      dir,
      id: "tenant-acme-x",
      kind: "tenant",
      tenant: "acme",
      createdAt: "2026-06-23T09:47:30.000Z",
      body: serializeDataset(sampleDataset()),
      key,
      extension: ".json",
    });
    await expect(loadDataset(dir, manifest, crypto.randomBytes(KEY_BYTES))).rejects.toThrow(CliError);
  });

  it("loadDataset requires a key for encrypted backups", async () => {
    const manifest = await writeBackup({
      dir,
      id: "tenant-acme-y",
      kind: "tenant",
      tenant: "acme",
      createdAt: "2026-06-23T09:47:30.000Z",
      body: serializeDataset(sampleDataset()),
      key: crypto.randomBytes(KEY_BYTES),
      extension: ".json",
    });
    await expect(loadDataset(dir, manifest, null)).rejects.toThrow(/encrypted/i);
  });

  it("detects integrity tampering via the manifest checksum", async () => {
    const manifest = await writeBackup({
      dir,
      id: "tenant-acme-z",
      kind: "tenant",
      tenant: "acme",
      createdAt: "2026-06-23T09:47:30.000Z",
      body: serializeDataset(sampleDataset()),
      key: null,
      extension: ".json",
    });
    // Corrupt the artifact on disk after the manifest was written.
    await writeBackupRaw(path.join(dir, manifest.artifact), "tampered");
    await expect(loadDataset(dir, manifest, null)).rejects.toThrow(/integrity/i);
  });
});

async function writeBackupRaw(file: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, contents);
}

describe("writeBackup (unencrypted)", () => {
  it("stores plaintext and round-trips without a key", async () => {
    const manifest = await writeBackup({
      dir,
      id: "plain",
      kind: "tenant",
      tenant: "acme",
      createdAt: "2026-06-23T09:47:30.000Z",
      body: serializeDataset(sampleDataset()),
      key: null,
      extension: ".json",
    });
    expect(manifest.encrypted).toBe(false);
    expect(manifest.artifact).toBe("plain.json");
    const dataset = await loadDataset(dir, manifest, null);
    expect(dataset.events).toHaveLength(1);
  });
});

describe("listBackups", () => {
  it("returns [] for a missing directory", async () => {
    expect(await listBackups(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("pruneBackups", () => {
  it("removes artifacts + manifests for expired backups only", async () => {
    const mk = (id: string, daysAgo: number) =>
      writeBackup({
        dir,
        id,
        kind: "tenant",
        tenant: "acme",
        createdAt: new Date(Date.parse("2026-06-23T00:00:00Z") - daysAgo * 86400_000).toISOString(),
        body: serializeDataset(sampleDataset()),
        key: null,
        extension: ".json",
      });
    await mk("recent", 1);
    await mk("old", 90);

    const now = new Date("2026-06-23T00:00:00Z");
    const result = await pruneBackups(dir, { keepDays: 30, keepLast: 0 }, now);
    expect(result.pruned).toEqual(["old"]);
    expect(result.kept).toBe(1);

    const remaining = await readdir(dir);
    expect(remaining).toContain("recent.json");
    expect(remaining).not.toContain("old.json");
    expect(remaining).not.toContain("old.manifest.json");
  });
});

describe("assertSafeSandboxName", () => {
  it("accepts safe lowercase identifiers", () => {
    expect(() => assertSafeSandboxName("dr_drill_1")).not.toThrow();
  });
  it("rejects injection-prone or live-schema names", () => {
    expect(() => assertSafeSandboxName("apiome")).toThrow(CliError);
    expect(() => assertSafeSandboxName("public")).toThrow(CliError);
    expect(() => assertSafeSandboxName("DROP TABLE")).toThrow(CliError);
    expect(() => assertSafeSandboxName('a"b')).toThrow(CliError);
    expect(() => assertSafeSandboxName("1leading")).toThrow(CliError);
  });
});

describe("pgDumpInvocation", () => {
  it("uses a connection string when provided", () => {
    const { args } = pgDumpInvocation({ databaseUrl: "postgresql://u:p@h:5/db" });
    expect(args).toContain("--format=custom");
    expect(args).toContain("--dbname=postgresql://u:p@h:5/db");
  });

  it("builds discrete flags and passes the password via PGPASSWORD env", () => {
    // Discrete flags only apply when no connection URL is set (see apiome-db README).
    // Self-hosted CI runners often export DATABASE_URL; isolate so this path is exercised.
    const savedUrl = process.env.DATABASE_URL;
    const savedApiomeUrl = process.env.APIOME_DB_URL;
    delete process.env.DATABASE_URL;
    delete process.env.APIOME_DB_URL;
    try {
      const { args, env } = pgDumpInvocation({
        host: "db.example",
        port: "5433",
        user: "ops",
        password: "secret",
        database: "apiome",
      });
      expect(args).toContain("--host=db.example");
      expect(args).toContain("--port=5433");
      expect(args).toContain("--username=ops");
      expect(args).toContain("--dbname=apiome");
      expect(env.PGPASSWORD).toBe("secret");
      // Password is never placed in the visible argv.
      expect(args.join(" ")).not.toContain("secret");
    } finally {
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
      if (savedApiomeUrl === undefined) delete process.env.APIOME_DB_URL;
      else process.env.APIOME_DB_URL = savedApiomeUrl;
    }
  });
});
