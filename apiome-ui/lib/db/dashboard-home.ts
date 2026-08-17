'use server';

/**
 * Home's added panels, resolved on the server (HIVE-4.6, #5300).
 *
 * `/ade/dashboard` used to be six stat cards and a Recent Activity list in the left half of a
 * two-column grid — the right half was empty, and there was no path from the overview into
 * work. This module fills that half, and every figure in it is data the app already holds:
 *
 * - **Pick up where you left off** — the newest revision of each project the reader can reach,
 *   with the lifecycle and the *stored* quality score the Versions list shows (`versions.
 *   quality_score`, captured at import by V124 / MFI-4.2). Nothing is linted here: #5259 made
 *   the list stored-first precisely so that rendering a score costs no lint run, and Home is
 *   not the surface to reintroduce one.
 * - **Needs attention** — the sunset schedule (`versions.metadata.sunsetAt`, the same column
 *   the sunset timeline reads), blocking findings in the stored lint report, and API keys near
 *   expiry.
 * - **Publishing pulse** — `versions.published_at` over twelve weeks.
 *
 * Everything derived from those rows lives in `./dashboard-home-model.ts`, which is React- and
 * database-free and unit-tested directly; a `'use server'` module may export only async
 * functions, so it could not have held them anyway.
 *
 * ## Misuse safeguards
 *
 * - **The reader comes from the session, never from the caller.** {@link
 *   getDashboardHomeForSession} takes no arguments, so a client cannot ask for another user's
 *   workspaces the way a `userId` parameter would let it. This is the same seam
 *   `launcher-summary.ts` uses.
 * - **Every query is scoped to the reader's tenants** by the same `tenant_users` subquery
 *   `getDashboardStats` uses, so Home can never surface a project, revision or key from a
 *   workspace the reader is not a member of — not even one whose id leaked from elsewhere.
 * - **Every section fails soft, on its own.** A Home that cannot count publishes still lists
 *   projects; the page's own job is to be the way into work, so a degraded panel is drawn
 *   empty (and, for "Needs attention", not drawn at all) rather than replaced by an error page.
 *   The four queries therefore run independently and a rejection is confined to its section.
 * - **Row counts are capped in SQL.** The candidate limits below are what stops a workspace
 *   with ten thousand deprecated revisions from serialising all of them to the client to fill a
 *   five-row panel.
 */

import type { Pool } from 'pg';

// db.ts is CommonJS (module.exports); keep parity with helper-database.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS pool singleton
const connectionPool = require('./db') as Pool;

import { getAuthSession } from '../auth/server-session';
import {
  ATTENTION_LIMIT,
  CONTINUE_PROJECT_LIMIT,
  KEY_EXPIRY_ATTENTION_DAYS,
  PULSE_WINDOW_DAYS,
  bucketPublishesByWeek,
  emptyDashboardHome,
  keyAttention,
  lintAttention,
  rankAttention,
  revisionStatus,
  sunsetAttention,
  type AttentionItem,
  type ContinueProject,
  type DashboardHome,
  type KeyRow,
  type LintRow,
  type PulseWeek,
  type SunsetRow,
} from './dashboard-home-model';

/**
 * The tenant scope every query below shares.
 *
 * Spelled once so the four cannot drift apart on the one thing that must not drift: which
 * workspaces the reader is allowed to see.
 */
const MEMBER_TENANTS = '(SELECT tenant_id FROM apiome.tenant_users WHERE user_id = $1)';

/**
 * How many candidate rows each attention query may return.
 *
 * More than {@link ATTENTION_LIMIT} because the three sources are ranked *together* — taking
 * five sunsets and five keys and then keeping the five most urgent of the ten is what lets a
 * key expiring tomorrow displace a sunset a month out. Bounded well below the size of a real
 * workspace so the cost is fixed either way.
 */
const ATTENTION_CANDIDATES = ATTENTION_LIMIT * 4;

/* -------------------------------------------------------------------------
   Row coercion
   ------------------------------------------------------------------------- */

/**
 * Read a `pg` value as a number.
 *
 * `COUNT(*)` arrives as a string because `bigint` does not fit a JS number safely, and
 * `quality_score` arrives as a number or `null`. One coercion handles both, and anything
 * unparseable becomes the fallback rather than `NaN` — a `NaN` would reach the DOM as the text
 * "NaN" on a card that is supposed to say how many classes a revision has.
 *
 * @param value Whatever the driver returned for the column.
 * @param fallback What to use when the value is absent or not a finite number.
 * @returns A finite number.
 */
function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Read a `pg` timestamp as an ISO string.
 *
 * `timestamptz` columns arrive as `Date` objects, but the same column read out of `jsonb` (the
 * sunset instants) arrives as a string, and a serialised server action has to hand the client
 * one form. ISO is the form the rest of the app's relative-time formatting already takes.
 *
 * @param value A `Date`, an ISO string, or neither.
 * @returns The instant as an ISO string, or `null` when there is no usable instant.
 */
function asInstant(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/**
 * Read a `pg` value as a non-empty trimmed string.
 *
 * @param value Whatever the driver returned.
 * @returns The trimmed string, or `null` when it is absent or blank.
 */
function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Run one section's query, and swallow its failure.
 *
 * @param section Which panel is being loaded, for the log line.
 * @param load The query and its mapping.
 * @param fallback What the panel shows when the query fails.
 * @returns The loaded value, or `fallback`.
 */
async function section<T>(section: string, load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(`[dashboard-home] ${section} failed; drawing it empty`, error);
    return fallback;
  }
}

/* -------------------------------------------------------------------------
   The four queries
   ------------------------------------------------------------------------- */

/**
 * The projects the reader most recently touched, with their newest revision.
 *
 * `DISTINCT ON (v.project_id)` picks that newest revision inside the database, so the query
 * returns one row per card rather than every revision of every project for the server to
 * reduce. The two counts are correlated subqueries against that one revision, which is why
 * they stay cheap: they are bounded by the three rows the outer `LIMIT` keeps.
 *
 * @param userId The reader, from the session.
 * @param limit How many cards to fill.
 * @returns One {@link ContinueProject} per project, most recently touched first.
 */
async function loadContinueProjects(userId: string, limit: number): Promise<ContinueProject[]> {
  const result = await connectionPool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (v.project_id)
         v.project_id, v.id AS version_row_id, v.version_id, v.published, v.published_at,
         v.updated_at, v.created_at, v.metadata, v.quality_score, v.quality_grade
       FROM apiome.versions v
       JOIN apiome.projects p ON p.id = v.project_id
       WHERE p.tenant_id IN ${MEMBER_TENANTS}
         AND p.deleted_at IS NULL
         AND v.deleted_at IS NULL
       ORDER BY v.project_id, v.created_at DESC, v.id DESC
     )
     SELECT
       p.id AS project_id,
       p.name AS project_name,
       t.name AS tenant_name,
       l.version_id,
       l.published,
       l.published_at,
       l.updated_at,
       l.created_at,
       l.metadata,
       l.quality_score,
       l.quality_grade,
       (SELECT COUNT(*) FROM apiome.classes c
         WHERE c.version_id = l.version_row_id AND c.deleted_at IS NULL) AS class_count,
       (SELECT COUNT(*) FROM apiome.class_properties cp
         JOIN apiome.classes c2 ON c2.id = cp.class_id
         WHERE c2.version_id = l.version_row_id AND c2.deleted_at IS NULL) AS property_count
     FROM latest l
     JOIN apiome.projects p ON p.id = l.project_id
     JOIN apiome.tenants t ON t.id = p.tenant_id
     ORDER BY GREATEST(
       COALESCE(l.published_at, l.created_at),
       COALESCE(l.updated_at, l.created_at)
     ) DESC
     LIMIT $2`,
    [userId, limit],
  );

  const now = new Date();
  return result.rows.map((row) => {
    const published = row.published === true;
    const publishedAt = asInstant(row.published_at);
    const updatedAt = asInstant(row.updated_at);
    const createdAt = asInstant(row.created_at);

    // A publish is only the headline when it is the *most recent* thing that happened: a
    // revision edited after it was published has been worked on since, and saying "Published
    // 3d ago" would hide that.
    const editedAt = updatedAt ?? createdAt;
    const publishIsNewest =
      published && publishedAt != null && (editedAt == null || Date.parse(publishedAt) >= Date.parse(editedAt));

    return {
      projectId: String(row.project_id),
      projectName: asText(row.project_name) ?? 'Untitled project',
      tenantName: asText(row.tenant_name) ?? '',
      versionLabel: asText(row.version_id),
      status: revisionStatus({ published, metadata: row.metadata }, now),
      qualityScore: row.quality_score == null ? null : asNumber(row.quality_score),
      qualityGrade: asText(row.quality_grade),
      classCount: asNumber(row.class_count),
      propertyCount: asNumber(row.property_count),
      touchedAt: (publishIsNewest ? publishedAt : editedAt) ?? new Date(0).toISOString(),
      touchedKind: publishIsNewest ? 'published' : 'edited',
    } satisfies ContinueProject;
  });
}

/**
 * Revisions with a sunset already reached or coming up.
 *
 * The `metadata->>` chain is the one `list_sunset_timeline_entries` uses in REST, so Home and
 * the sunset timeline read the same three key spellings. The window is applied in SQL as well
 * as in {@link sunsetAttention} — SQL to bound the rows fetched, the model to make the
 * threshold a tested number rather than an interval buried in a string.
 *
 * @param userId The reader, from the session.
 * @returns Candidate rows, nearest sunset first.
 */
async function loadSunsetRows(userId: string): Promise<SunsetRow[]> {
  const result = await connectionPool.query(
    `SELECT
       v.id AS version_row_id,
       v.version_id,
       v.published,
       p.name AS project_name,
       NULLIF(TRIM(COALESCE(
         v.metadata->>'sunsetAt',
         v.metadata->>'sunsetDate',
         v.metadata->>'sunset_date',
         ''
       )), '') AS sunset_at
     FROM apiome.versions v
     JOIN apiome.projects p ON p.id = v.project_id
     WHERE p.tenant_id IN ${MEMBER_TENANTS}
       AND p.deleted_at IS NULL
       AND v.deleted_at IS NULL
       AND NULLIF(TRIM(COALESCE(
         v.metadata->>'sunsetAt',
         v.metadata->>'sunsetDate',
         v.metadata->>'sunset_date',
         ''
       )), '') IS NOT NULL
     ORDER BY sunset_at ASC
     LIMIT $2`,
    [userId, ATTENTION_CANDIDATES],
  );

  return result.rows.flatMap((row) => {
    const sunsetAt = asText(row.sunset_at);
    const versionLabel = asText(row.version_id);
    if (!sunsetAt || !versionLabel) return [];
    return [
      {
        versionRowId: String(row.version_row_id),
        versionLabel,
        projectName: asText(row.project_name) ?? 'Untitled project',
        sunsetAt,
        published: row.published === true,
      } satisfies SunsetRow,
    ];
  });
}

/**
 * Unpublished revisions whose stored lint report counts at least one blocking finding.
 *
 * Unpublished only: a blocking finding matters here because it is what the *publish gate* will
 * reject, and a revision already published is past that gate — surfacing it would be advice
 * the reader can no longer act on from this panel.
 *
 * `jsonb_typeof(...) = 'number'` guards the cast. Without it a report whose `severity_counts`
 * held a string would abort the whole statement, and the panel would vanish for a reason that
 * has nothing to do with the reader's workspace.
 *
 * @param userId The reader, from the session.
 * @returns Candidate rows, most findings first.
 */
async function loadLintRows(userId: string): Promise<LintRow[]> {
  const result = await connectionPool.query(
    `SELECT
       v.id AS version_row_id,
       v.version_id,
       p.name AS project_name,
       (v.quality_report->'severity_counts'->>'error')::int AS error_count
     FROM apiome.versions v
     JOIN apiome.projects p ON p.id = v.project_id
     WHERE p.tenant_id IN ${MEMBER_TENANTS}
       AND p.deleted_at IS NULL
       AND v.deleted_at IS NULL
       AND v.published = false
       AND jsonb_typeof(v.quality_report->'severity_counts'->'error') = 'number'
       AND (v.quality_report->'severity_counts'->>'error')::int > 0
     ORDER BY error_count DESC, v.created_at DESC
     LIMIT $2`,
    [userId, ATTENTION_CANDIDATES],
  );

  return result.rows.flatMap((row) => {
    const versionLabel = asText(row.version_id);
    const errorCount = asNumber(row.error_count);
    if (!versionLabel || errorCount <= 0) return [];
    return [
      {
        versionRowId: String(row.version_row_id),
        versionLabel,
        projectName: asText(row.project_name) ?? 'Untitled project',
        errorCount,
      } satisfies LintRow,
    ];
  });
}

/**
 * Enabled API keys at or near their expiry.
 *
 * Disabled keys are excluded: a key nobody can use cannot break a pipeline, so asking the
 * reader to rotate it is noise. Revoked keys are deleted outright by `deleteApiKey`, so there
 * is no third state to filter.
 *
 * @param userId The reader, from the session.
 * @returns Candidate rows, nearest expiry first.
 */
async function loadKeyRows(userId: string): Promise<KeyRow[]> {
  const result = await connectionPool.query(
    `SELECT
       ak.id AS key_id,
       ak.name AS key_name,
       ak.expires_at,
       t.name AS tenant_name
     FROM apiome.api_keys ak
     JOIN apiome.tenants t ON t.id = ak.tenant_id
     WHERE ak.tenant_id IN ${MEMBER_TENANTS}
       AND ak.enabled = true
       AND ak.expires_at IS NOT NULL
       AND ak.expires_at <= NOW() + ($2 || ' days')::interval
     ORDER BY ak.expires_at ASC
     LIMIT $3`,
    [userId, String(KEY_EXPIRY_ATTENTION_DAYS), ATTENTION_CANDIDATES],
  );

  return result.rows.flatMap((row) => {
    const expiresAt = asInstant(row.expires_at);
    const keyName = asText(row.key_name);
    if (!expiresAt || !keyName) return [];
    return [
      {
        keyId: String(row.key_id),
        keyName,
        tenantName: asText(row.tenant_name) ?? '',
        expiresAt,
      } satisfies KeyRow,
    ];
  });
}

/**
 * The name of the workspace the session is in.
 *
 * Membership is re-checked rather than trusted: `current_tenant_id` comes from the session,
 * which the reader's own client can ask to update, so the lookup is joined against
 * `tenant_users`. A stale or forged id therefore yields no name — and a breadcrumb with no
 * workspace step — instead of naming a workspace the reader is not in.
 *
 * @param userId The reader, from the session.
 * @param tenantId The session's current workspace id.
 * @returns The workspace's name, or `null`.
 */
async function loadWorkspaceName(userId: string, tenantId: string): Promise<string | null> {
  const result = await connectionPool.query(
    `SELECT t.name
     FROM apiome.tenants t
     WHERE t.id = $2
       AND t.id IN ${MEMBER_TENANTS}
     LIMIT 1`,
    [userId, tenantId],
  );
  return result.rows.length > 0 ? asText(result.rows[0].name) : null;
}

/**
 * Publish instants inside the pulse window, bucketed into weeks.
 *
 * The query returns bare timestamps and {@link bucketPublishesByWeek} does the bucketing, so
 * the boundary arithmetic is covered by a unit test against a fixed clock rather than by a
 * `date_trunc` nobody can exercise without a database.
 *
 * @param userId The reader, from the session.
 * @returns One bucket per week of the pulse window, oldest first.
 */
async function loadPulse(userId: string): Promise<PulseWeek[]> {
  const result = await connectionPool.query(
    `SELECT v.published_at
     FROM apiome.versions v
     JOIN apiome.projects p ON p.id = v.project_id
     WHERE p.tenant_id IN ${MEMBER_TENANTS}
       AND p.deleted_at IS NULL
       AND v.deleted_at IS NULL
       AND v.published = true
       AND v.published_at IS NOT NULL
       AND v.published_at >= NOW() - ($2 || ' days')::interval`,
    [userId, String(PULSE_WINDOW_DAYS)],
  );

  const instants = result.rows.flatMap((row) => {
    const instant = asInstant(row.published_at);
    return instant ? [instant] : [];
  });
  return bucketPublishesByWeek(instants, new Date());
}

/* -------------------------------------------------------------------------
   The entry point
   ------------------------------------------------------------------------- */

/**
 * Everything Home shows beyond the stats, the activity list and the checklist.
 *
 * The reader is the signed-in session; a signed-out call resolves to the empty payload without
 * touching the database. The four sections load concurrently and independently — one failing
 * costs its own panel and nothing else.
 *
 * @returns The assembled payload, or {@link emptyDashboardHome} when there is no session.
 */
export async function getDashboardHomeForSession(): Promise<DashboardHome> {
  const session = await getAuthSession().catch(() => null);
  const user = session?.user as { user_id?: string; current_tenant_id?: string } | undefined;
  const userId = user?.user_id;
  if (!userId) return emptyDashboardHome();
  const tenantId = user?.current_tenant_id;

  const [workspaceName, continueProjects, sunsetRows, lintRows, keyRows, pulse] = await Promise.all([
    tenantId
      ? section<string | null>('workspace name', () => loadWorkspaceName(userId, tenantId), null)
      : Promise.resolve(null),
    section<ContinueProject[]>(
      'continue projects',
      () => loadContinueProjects(userId, CONTINUE_PROJECT_LIMIT),
      [],
    ),
    section<SunsetRow[]>('sunset schedule', () => loadSunsetRows(userId), []),
    section<LintRow[]>('lint gate', () => loadLintRows(userId), []),
    section<KeyRow[]>('key expiry', () => loadKeyRows(userId), []),
    section<PulseWeek[]>('publishing pulse', () => loadPulse(userId), []),
  ]);

  const now = new Date();
  const attention: AttentionItem[] = rankAttention([
    sunsetAttention(sunsetRows, now),
    lintAttention(lintRows),
    keyAttention(keyRows, now),
  ]);

  return { workspaceName, continueProjects, attention, pulse };
}
