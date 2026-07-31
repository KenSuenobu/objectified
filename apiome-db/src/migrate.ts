/**
 * Apply SQL migrations from scripts/ using Flyway-compatible conventions.
 *
 * - Scripts are named `V<version>__<description>.sql` (Flyway versioned migrations). The
 *   version is a zero-padded sequential number (`V001`, `V002`, …); parts may be separated by
 *   `.` or `_`; the description follows the `__` separator. Versions must be unique — two files
 *   claiming one version is an error, because only one of them could ever be applied.
 * - Applied state is tracked in a Flyway-shaped history table (`flyway_schema_history`) living
 *   in the configured history schema (default `public`, which survives the app `apiome` schema
 *   being dropped by the first migration / `clean`).
 * - Each script's content is checksummed (CRC32 over newline-normalized bytes). On a re-run the
 *   stored checksum is validated against the current file so accidental edits to an already
 *   applied migration are surfaced (resolve with `repair`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type pg from "pg";

import { CliError } from "./errors.js";

/** Flyway versioned-migration filename: `V<version>__<description>.sql`. */
const MIGRATION_FILE_PATTERN = /^V(\d+(?:[._]\d+)*)__(.+)\.sql$/;

/** History table name (override with FLYWAY_SCHEMA_HISTORY_TABLE). */
export function historyTable(): string {
  const name = process.env.FLYWAY_SCHEMA_HISTORY_TABLE?.trim();
  return name && name !== "" ? name : "flyway_schema_history";
}

/** Schema the history table lives in (override with FLYWAY_DEFAULT_SCHEMA). */
export function historySchema(): string {
  const name = process.env.FLYWAY_DEFAULT_SCHEMA?.trim();
  return name && name !== "" ? name : "public";
}

/** Quote a Postgres identifier (schema/table) for safe interpolation. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Fully-qualified, quoted history table reference, e.g. `"public"."flyway_schema_history"`. */
function historyRef(): string {
  return `${quoteIdent(historySchema())}.${quoteIdent(historyTable())}`;
}

/** Package root scripts/ directory (parent of dist/ at runtime). */
export function defaultScriptsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "scripts");
}

export function isMigrationFilename(name: string): boolean {
  return MIGRATION_FILE_PATTERN.test(name);
}

export type ParsedMigration = {
  /** Version digits, e.g. `20251026012616`. */
  version: string;
  /** Human description (underscores become spaces), e.g. `multitenant init`. */
  description: string;
};

/** Parse a Flyway versioned filename into its version and description. */
export function parseMigrationName(name: string): ParsedMigration {
  const match = name.match(MIGRATION_FILE_PATTERN);
  if (!match) {
    throw new CliError(`Not a Flyway versioned migration filename: ${name}`, { exitCode: 2 });
  }
  return { version: match[1] ?? "", description: (match[2] ?? "").replace(/_/g, " ") };
}

/**
 * Comparison key for a version, with each numeric part normalized so zero-padding cannot hide a
 * collision: `V7`, `V07` and `V0.7` all key as `7`. History rows keep the raw digits (that is what
 * `parseMigrationName` returns and what applied rows are matched on) — this key exists only to
 * decide whether two *files* claim the same slot.
 */
function versionKey(version: string): string {
  return version
    .split(/[._]/)
    .map((part) => String(Number(part)))
    .join(".");
}

/**
 * The next unused version, formatted like the file that collided (`V200` → `V221`), for the hint.
 * Falls back to the raw number when no file has a plain integer version.
 */
function suggestNextVersion(files: string[], like: string): string {
  let max = 0;
  for (const file of files) {
    const numeric = Number(versionKey(parseMigrationName(file).version).split(".")[0] ?? "0");
    if (Number.isFinite(numeric) && numeric > max) max = numeric;
  }
  const next = String(max + 1);
  return next.padStart(like.length, "0");
}

/**
 * List the versioned migration scripts in `scriptsDir`, sorted by filename.
 *
 * Two files claiming the same version is rejected here rather than left to surface downstream:
 * history is keyed by version, so only one of them can ever be recorded — the rest are treated as
 * already applied and silently never run. When that happened the symptom was a checksum mismatch
 * naming the *older* migration (the one that did apply), which sends you hunting for an edit that
 * never happened. Fail with the collision itself instead.
 */
export async function listMigrationFiles(scriptsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(scriptsDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`Could not read migrations directory ${scriptsDir}: ${message}`, {
      exitCode: 2,
    });
  }
  const files = entries.filter(isMigrationFilename).sort();

  const byVersion = new Map<string, string[]>();
  for (const file of files) {
    const key = versionKey(parseMigrationName(file).version);
    const group = byVersion.get(key) ?? [];
    group.push(file);
    byVersion.set(key, group);
  }
  const duplicates = [...byVersion.entries()].filter(([, group]) => group.length > 1);
  if (duplicates.length > 0) {
    const detail = duplicates
      .map(([version, group]) => `  version ${version}: ${group.join(", ")}`)
      .join("\n");
    const [firstVersion, firstGroup] = duplicates[0] ?? ["", []];
    const suggestion = suggestNextVersion(files, firstVersion);
    throw new CliError(
      `Duplicate migration version${duplicates.length === 1 ? "" : "s"} in ${scriptsDir}:\n${detail}`,
      {
        hint:
          "Migration history is keyed by version, so only one script per version is ever applied — " +
          "the others are skipped without running. Renumber the newest to the next free version " +
          `(V${suggestion}), keeping its description, and update any references to its filename.\n` +
          `  git mv ${scriptsDir}/${firstGroup[1] ?? "<file>"} ` +
          `${scriptsDir}/V${suggestion}__<description>.sql`,
        exitCode: 2,
      },
    );
  }
  return files;
}

// ─────────────────────────────── checksum ───────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * Flyway-style CRC32 checksum of a migration's contents. Line endings are normalized (CRLF/CR
 * → LF) so the same script checksums identically across platforms and git autocrlf settings.
 * Returned as a signed 32-bit integer to match Flyway's `checksum INTEGER` column.
 */
export function computeChecksum(sql: string): number {
  const normalized = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bytes = Buffer.from(normalized, "utf8");
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ -1) | 0; // signed 32-bit
}

// ─────────────────────────── history table ──────────────────────────────

function ensureHistoryTableSql(): string {
  const schema = quoteIdent(historySchema());
  const ref = historyRef();
  return `
CREATE SCHEMA IF NOT EXISTS ${schema};

CREATE TABLE IF NOT EXISTS ${ref} (
  installed_rank INTEGER NOT NULL,
  version VARCHAR(50),
  description VARCHAR(200) NOT NULL,
  type VARCHAR(20) NOT NULL,
  script VARCHAR(1000) NOT NULL,
  checksum INTEGER,
  installed_by VARCHAR(100) NOT NULL,
  installed_on TIMESTAMP NOT NULL DEFAULT now(),
  execution_time INTEGER NOT NULL,
  success BOOLEAN NOT NULL,
  CONSTRAINT ${quoteIdent(`${historyTable()}_pk`)} PRIMARY KEY (installed_rank)
);

CREATE INDEX IF NOT EXISTS ${quoteIdent(`${historyTable()}_s_idx`)}
  ON ${ref} (success);
`;
}

export async function ensureHistoryTable(client: pg.Client): Promise<void> {
  await client.query(ensureHistoryTableSql());
}

export type AppliedMigration = {
  version: string | null;
  description: string;
  script: string;
  checksum: number | null;
  success: boolean;
  installedRank: number;
};

export async function fetchAppliedMigrations(
  client: pg.Client,
  opts: { createTable?: boolean } = {},
): Promise<AppliedMigration[]> {
  if (opts.createTable ?? true) {
    await ensureHistoryTable(client);
  }
  try {
    const res = await client.query<{
      version: string | null;
      description: string;
      script: string;
      checksum: number | null;
      success: boolean;
      installed_rank: number;
    }>(
      `SELECT version, description, script, checksum, success, installed_rank
         FROM ${historyRef()} ORDER BY installed_rank`,
    );
    return res.rows.map((r) => ({
      version: r.version,
      description: r.description,
      script: r.script,
      checksum: r.checksum,
      success: r.success,
      installedRank: r.installed_rank,
    }));
  } catch (err) {
    if (isUndefinedRelation(err)) return [];
    throw err;
  }
}

function isUndefinedRelation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01";
}

// ──────────────────────────────── status ────────────────────────────────

export type MigrationStatus = {
  scriptsDir: string;
  applied: string[];
  pending: string[];
};

/**
 * Compute applied/pending migrations and validate that already-applied scripts have not changed
 * on disk (checksum mismatch → error pointing at `repair`).
 */
export async function getMigrationStatus(
  client: pg.Client,
  scriptsDir: string,
  opts: { createTable?: boolean } = {},
): Promise<MigrationStatus> {
  const files = await listMigrationFiles(scriptsDir);
  const appliedRows = await fetchAppliedMigrations(client, opts);
  const appliedByVersion = new Map<string, AppliedMigration>();
  for (const row of appliedRows) {
    if (row.version !== null && row.success) appliedByVersion.set(row.version, row);
  }

  const applied: string[] = [];
  const pending: string[] = [];
  for (const file of files) {
    const { version } = parseMigrationName(file);
    const row = appliedByVersion.get(version);
    if (!row) {
      pending.push(file);
      continue;
    }
    applied.push(file);
    const checksum = computeChecksum(await fs.readFile(path.join(scriptsDir, file), "utf8"));
    if (row.checksum !== null && row.checksum !== checksum) {
      throw new CliError(
        `Checksum mismatch for applied migration ${file} ` +
          `(recorded ${row.checksum}, current ${checksum}).`,
        {
          hint:
            "An already-applied migration was edited. Revert the file, or run " +
            "`apiome-db repair` to realign recorded checksums to the current files.",
          exitCode: 1,
        },
      );
    }
  }
  return { scriptsDir, applied, pending };
}

// ──────────────────────────────── apply ─────────────────────────────────

export type ApplyOptions = {
  scriptsDir: string;
  dryRun?: boolean;
};

export type ApplyResult = {
  applied: string[];
  skipped: string[];
  dryRun: boolean;
};

async function nextInstalledRank(client: pg.Client): Promise<number> {
  const res = await client.query<{ max: number | null }>(
    `SELECT max(installed_rank) AS max FROM ${historyRef()}`,
  );
  return (res.rows[0]?.max ?? 0) + 1;
}

async function applyOneFile(
  client: pg.Client,
  scriptsDir: string,
  filename: string,
): Promise<void> {
  const sql = await fs.readFile(path.join(scriptsDir, filename), "utf8");
  const { version, description } = parseMigrationName(filename);
  const checksum = computeChecksum(sql);

  await client.query("BEGIN");
  try {
    const startedAt = process.hrtime.bigint();
    await client.query(sql);
    const executionMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const rank = await nextInstalledRank(client);
    await client.query(
      `INSERT INTO ${historyRef()}
         (installed_rank, version, description, type, script, checksum,
          installed_by, execution_time, success)
       VALUES ($1, $2, $3, 'SQL', $4, $5, current_user, $6, true)`,
      [rank, version, description, filename, checksum, executionMs],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function applyPendingMigrations(
  client: pg.Client,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const { scriptsDir, dryRun = false } = opts;
  const status = await getMigrationStatus(client, scriptsDir, { createTable: !dryRun });

  if (status.pending.length === 0) {
    return { applied: [], skipped: status.applied, dryRun };
  }
  if (dryRun) {
    return { applied: status.pending, skipped: status.applied, dryRun: true };
  }

  await ensureHistoryTable(client);

  const applied: string[] = [];
  for (const filename of status.pending) {
    try {
      await applyOneFile(client, scriptsDir, filename);
      applied.push(filename);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const { version } = parseMigrationName(filename);
      throw new CliError(`Failed applying migration ${filename}: ${message}`, {
        hint:
          "Fix the script or, if it was applied manually, record it:\n" +
          `  INSERT INTO ${historyRef()} (installed_rank, version, description, type, ` +
          `script, checksum, installed_by, execution_time, success)\n` +
          `  VALUES ((SELECT coalesce(max(installed_rank),0)+1 FROM ${historyRef()}), ` +
          `'${version}', '<desc>', 'SQL', '${filename}', 0, current_user, 0, true);`,
        exitCode: 1,
      });
    }
  }
  return { applied, skipped: status.applied, dryRun };
}

// ──────────────────────────────── repair ────────────────────────────────

export type RepairResult = {
  /** Filenames whose recorded checksum was realigned to the current file. */
  realigned: string[];
  /** installed_rank values of failed (success=false) rows that were removed. */
  removedFailed: number[];
};

/**
 * Flyway-style repair: realign recorded checksums to the current migration files and remove any
 * failed (`success = false`) history rows so they can be retried.
 */
export async function repairHistory(
  client: pg.Client,
  scriptsDir: string,
): Promise<RepairResult> {
  const applied = await fetchAppliedMigrations(client);
  const files = await listMigrationFiles(scriptsDir);
  const fileByVersion = new Map<string, string>();
  for (const file of files) fileByVersion.set(parseMigrationName(file).version, file);

  const realigned: string[] = [];
  const removedFailed: number[] = [];

  await client.query("BEGIN");
  try {
    for (const row of applied) {
      if (!row.success) {
        await client.query(`DELETE FROM ${historyRef()} WHERE installed_rank = $1`, [
          row.installedRank,
        ]);
        removedFailed.push(row.installedRank);
        continue;
      }
      if (row.version === null) continue;
      const file = fileByVersion.get(row.version);
      if (!file) continue;
      const checksum = computeChecksum(await fs.readFile(path.join(scriptsDir, file), "utf8"));
      if (row.checksum !== checksum) {
        await client.query(
          `UPDATE ${historyRef()} SET checksum = $1 WHERE installed_rank = $2`,
          [checksum, row.installedRank],
        );
        realigned.push(file);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return { realigned, removedFailed };
}

// ──────────────────────────────── clean ─────────────────────────────────

const APP_SCHEMA = "apiome";

export type CleanResult = {
  droppedSchema: string;
  droppedHistory: string;
};

/**
 * Flyway-style clean: drop the application schema (`apiome`) and the migration history table so the
 * database can be rebuilt from scratch by `migrate`. Destructive; callers must gate this.
 */
export async function cleanDatabase(client: pg.Client): Promise<CleanResult> {
  await client.query("BEGIN");
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APP_SCHEMA)} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS ${historyRef()}`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return { droppedSchema: APP_SCHEMA, droppedHistory: `${historySchema()}.${historyTable()}` };
}

/** Whether Flyway-style clean is disabled (default true, matching Flyway 10). */
export function cleanDisabled(): boolean {
  const v = process.env.FLYWAY_CLEAN_DISABLED?.trim().toLowerCase();
  if (v === undefined || v === "") return true;
  return !(v === "false" || v === "0" || v === "no");
}
