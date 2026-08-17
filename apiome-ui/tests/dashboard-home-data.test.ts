/**
 * Home's data layer (HIVE-4.6, #5300).
 *
 * `lib/db/dashboard-home.ts` adds no data of its own: it assembles Home's added panels out of
 * columns other screens already read — `versions.quality_score` (V124 / MFI-4.2, the same stored
 * score the Versions list shows since #5259), `versions.metadata.sunsetAt` (the same key the
 * sunset timeline reads), `versions.published_at` and `api_keys.expires_at`.
 *
 * Three properties are worth guarding, and all three are about failure and about scope rather
 * than about SQL:
 *
 * 1. **The reader comes from the session.** The function takes no arguments, so a client cannot
 *    ask for another user's workspaces. Every query is parameterised on that session user.
 * 2. **Every section fails soft, on its own.** Home's job is to be the way into work; a page that
 *    cannot count publishes must still list projects. So one query throwing costs its panel and
 *    nothing else.
 * 3. **Nothing crosses a workspace boundary.** Every statement scopes through `tenant_users`,
 *    including the breadcrumb's workspace lookup — `current_tenant_id` arrives from a session the
 *    reader's own client can ask to update, so it is re-checked rather than trusted.
 *
 * The pool is mocked per statement, keyed on a fragment of the SQL, which is what lets a single
 * test fail exactly one section.
 */

import { getAuthSession } from './__mocks__/server-session';
import { ATTENTION_HREF, PULSE_WEEKS } from '@lib/db/dashboard-home-model';

/** Every `connectionPool.query` call the module makes, in order. */
const queries: { sql: string; params: unknown[] }[] = [];

/** Per-section responses, keyed on a fragment of the statement that section runs. */
type Responder = () => Promise<{ rows: unknown[] }>;
const responders = new Map<string, Responder>();

jest.mock('../lib/db/db', () => ({
  query: (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    for (const [fragment, responder] of responders) {
      if (sql.includes(fragment)) return responder();
    }
    return Promise.resolve({ rows: [] });
  },
}));

import { getDashboardHomeForSession } from '../lib/db/dashboard-home';

/** Statement fragments, one per section, unique to that section's SQL. */
const SECTION = {
  workspace: 'FROM apiome.tenants t',
  continueProjects: 'WITH latest AS',
  sunset: "v.metadata->>'sunsetAt'",
  lint: "quality_report->'severity_counts'",
  keys: 'FROM apiome.api_keys ak',
  pulse: 'SELECT v.published_at',
} as const;

/** A session for a signed-in reader with a current workspace. */
const SESSION = { user: { user_id: 'user-1', current_tenant_id: 'tenant-1' } };

/** Answer one section with rows. */
function answer(fragment: string, rows: unknown[]): void {
  responders.set(fragment, () => Promise.resolve({ rows }));
}

/** Make one section throw, as an unreachable database would. */
function fail(fragment: string, message = 'connection terminated'): void {
  responders.set(fragment, () => Promise.reject(new Error(message)));
}

/** Now, as a fixed instant the fixtures are stated relative to. */
const DAY_MS = 86_400_000;

/** One row of the continue-projects query, as `pg` hands it back. */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    project_id: 'p-1',
    project_name: 'Payments API',
    tenant_name: 'Acme Corp',
    version_id: 'v2.4.0',
    published: false,
    published_at: null,
    updated_at: new Date(Date.now() - 2 * 3_600_000),
    created_at: new Date(Date.now() - 5 * DAY_MS),
    metadata: {},
    quality_score: 88,
    quality_grade: 'B',
    // `COUNT(*)` is `bigint`, which `pg` returns as a string.
    class_count: '18',
    property_count: '42',
    ...overrides,
  };
}

beforeEach(() => {
  queries.length = 0;
  responders.clear();
  (getAuthSession as jest.Mock).mockReset();
  (getAuthSession as jest.Mock).mockResolvedValue(SESSION);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* -------------------------------------------------------------------------
   1. The reader is the session
   ------------------------------------------------------------------------- */

describe('getDashboardHomeForSession — who it reads for', () => {
  it('touches no database at all when there is no session', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(null);
    const home = await getDashboardHomeForSession();

    expect(queries).toHaveLength(0);
    expect(home).toEqual({ workspaceName: null, continueProjects: [], attention: [], pulse: [] });
  });

  it('touches no database when the session has no user id', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue({ user: { email: 'ada@example.test' } });
    await getDashboardHomeForSession();
    expect(queries).toHaveLength(0);
  });

  it('survives a session lookup that throws', async () => {
    (getAuthSession as jest.Mock).mockRejectedValue(new Error('cookie jar is on fire'));
    const home = await getDashboardHomeForSession();
    expect(home.continueProjects).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('parameterises every statement on the session user, and never interpolates an id', async () => {
    await getDashboardHomeForSession();

    expect(queries.length).toBeGreaterThan(0);
    for (const { sql, params } of queries) {
      expect(params[0]).toBe('user-1');
      expect(sql).not.toContain('user-1');
    }
  });

  it('scopes every statement through tenant_users', async () => {
    await getDashboardHomeForSession();
    for (const { sql } of queries) {
      expect(sql).toContain('FROM apiome.tenant_users WHERE user_id = $1');
    }
  });

  it('re-checks membership before naming the workspace from the session', async () => {
    // `current_tenant_id` comes from a session the reader's own client can ask to update, so a
    // stale or forged id must yield no name rather than name a workspace they are not in.
    answer(SECTION.workspace, []);
    const home = await getDashboardHomeForSession();

    const workspace = queries.find((entry) => entry.sql.includes(SECTION.workspace));
    expect(workspace?.sql).toContain('FROM apiome.tenant_users WHERE user_id = $1');
    expect(workspace?.params).toEqual(['user-1', 'tenant-1']);
    expect(home.workspaceName).toBeNull();
  });

  it('skips the workspace lookup entirely when the session has no current workspace', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue({ user: { user_id: 'user-1' } });
    const home = await getDashboardHomeForSession();

    expect(queries.some((entry) => entry.sql.includes(SECTION.workspace))).toBe(false);
    expect(home.workspaceName).toBeNull();
  });

  it('names the workspace when membership checks out', async () => {
    answer(SECTION.workspace, [{ name: 'Acme Corp' }]);
    const home = await getDashboardHomeForSession();
    expect(home.workspaceName).toBe('Acme Corp');
  });
});

/* -------------------------------------------------------------------------
   2. Pick up where you left off
   ------------------------------------------------------------------------- */

describe('the continue-projects section', () => {
  it('maps a row to a card, coercing the bigint counts pg returns as strings', async () => {
    answer(SECTION.continueProjects, [projectRow()]);
    const home = await getDashboardHomeForSession();

    expect(home.continueProjects).toHaveLength(1);
    expect(home.continueProjects[0]).toMatchObject({
      projectId: 'p-1',
      projectName: 'Payments API',
      tenantName: 'Acme Corp',
      versionLabel: 'v2.4.0',
      status: 'draft',
      qualityScore: 88,
      qualityGrade: 'B',
      classCount: 18,
      propertyCount: 42,
      touchedKind: 'edited',
    });
    expect(Number.isNaN(home.continueProjects[0].classCount)).toBe(false);
  });

  it('serialises timestamps as ISO strings, whichever form the column arrived in', async () => {
    answer(SECTION.continueProjects, [projectRow()]);
    const home = await getDashboardHomeForSession();
    expect(home.continueProjects[0].touchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('says "published" only when the publish is the newest thing that happened', async () => {
    const publishedAt = new Date(Date.now() - 3 * DAY_MS);
    answer(SECTION.continueProjects, [
      projectRow({
        published: true,
        published_at: publishedAt,
        updated_at: publishedAt,
        metadata: {},
      }),
    ]);
    let home = await getDashboardHomeForSession();
    expect(home.continueProjects[0].touchedKind).toBe('published');
    expect(home.continueProjects[0].status).toBe('published');

    // Edited after publishing: the card must not hide that behind "Published 3 days ago".
    queries.length = 0;
    answer(SECTION.continueProjects, [
      projectRow({
        published: true,
        published_at: publishedAt,
        updated_at: new Date(Date.now() - 3_600_000),
      }),
    ]);
    home = await getDashboardHomeForSession();
    expect(home.continueProjects[0].touchedKind).toBe('edited');
  });

  it('reads the lifecycle out of metadata rather than out of the published flag alone', async () => {
    answer(SECTION.continueProjects, [
      projectRow({ published: true, metadata: { lifecycle: 'deprecated' } }),
    ]);
    const home = await getDashboardHomeForSession();
    expect(home.continueProjects[0].status).toBe('deprecated');
  });

  it('keeps an unscored revision unscored rather than calling it zero', async () => {
    answer(SECTION.continueProjects, [projectRow({ quality_score: null, quality_grade: null })]);
    const home = await getDashboardHomeForSession();
    expect(home.continueProjects[0].qualityScore).toBeNull();
    expect(home.continueProjects[0].qualityGrade).toBeNull();
  });

  it('names an untitled project rather than rendering an empty heading', async () => {
    answer(SECTION.continueProjects, [projectRow({ project_name: '   ' })]);
    const home = await getDashboardHomeForSession();
    expect(home.continueProjects[0].projectName).toBe('Untitled project');
  });

  it('caps the query in SQL rather than in the page', async () => {
    await getDashboardHomeForSession();
    const entry = queries.find((candidate) => candidate.sql.includes(SECTION.continueProjects));
    expect(entry?.sql).toContain('LIMIT $2');
    expect(entry?.params[1]).toBe(3);
  });

  it('excludes deleted projects and revisions', async () => {
    await getDashboardHomeForSession();
    const entry = queries.find((candidate) => candidate.sql.includes(SECTION.continueProjects));
    expect(entry?.sql).toContain('p.deleted_at IS NULL');
    expect(entry?.sql).toContain('v.deleted_at IS NULL');
  });
});

/* -------------------------------------------------------------------------
   3. Needs attention
   ------------------------------------------------------------------------- */

describe('the needs-attention sections', () => {
  it('ranks the three sources together, most urgent first', async () => {
    answer(SECTION.sunset, [
      {
        version_row_id: 'v-1',
        version_id: 'v1.4.0',
        published: true,
        project_name: 'Orders Service',
        sunset_at: new Date(Date.now() + 20 * DAY_MS).toISOString(),
      },
    ]);
    answer(SECTION.lint, [
      { version_row_id: 'v-9', version_id: 'v2.4.0', project_name: 'Payments API', error_count: 4 },
    ]);
    answer(SECTION.keys, [
      {
        key_id: 'k-1',
        key_name: 'ci-deploy',
        tenant_name: 'Acme Corp',
        expires_at: new Date(Date.now() - 2 * DAY_MS),
      },
    ]);

    const home = await getDashboardHomeForSession();
    expect(home.attention.map((item) => item.kind)).toEqual(['key', 'lint', 'sunset']);
    expect(home.attention.map((item) => item.href)).toEqual([
      ATTENTION_HREF.key,
      ATTENTION_HREF.lint,
      ATTENTION_HREF.sunset,
    ]);
  });

  it('reads all three sunset key spellings the app has written', async () => {
    await getDashboardHomeForSession();
    const entry = queries.find((candidate) => candidate.sql.includes(SECTION.sunset));
    for (const key of ['sunsetAt', 'sunsetDate', 'sunset_date']) {
      expect(entry?.sql).toContain(`'${key}'`);
    }
  });

  it('asks the lint gate only about revisions the gate can still stop', async () => {
    await getDashboardHomeForSession();
    const entry = queries.find((candidate) => candidate.sql.includes(SECTION.lint));
    expect(entry?.sql).toContain('v.published = false');
  });

  it('guards the severity cast, so a malformed report cannot abort the statement', async () => {
    await getDashboardHomeForSession();
    const entry = queries.find((candidate) => candidate.sql.includes(SECTION.lint));
    expect(entry?.sql).toContain("jsonb_typeof(v.quality_report->'severity_counts'->'error') = 'number'");
  });

  it('asks about enabled keys only, since a disabled key cannot break a pipeline', async () => {
    await getDashboardHomeForSession();
    const entry = queries.find((candidate) => candidate.sql.includes(SECTION.keys));
    expect(entry?.sql).toContain('ak.enabled = true');
    expect(entry?.sql).toContain('ak.expires_at IS NOT NULL');
  });

  it('drops a row whose own identifying columns are missing', async () => {
    answer(SECTION.sunset, [
      { version_row_id: 'v-1', version_id: null, project_name: 'X', sunset_at: '2026-08-20' },
      { version_row_id: 'v-2', version_id: 'v1.0.0', project_name: 'X', sunset_at: null },
    ]);
    answer(SECTION.keys, [{ key_id: 'k-1', key_name: null, tenant_name: 'X', expires_at: new Date() }]);
    answer(SECTION.lint, [
      { version_row_id: 'v-3', version_id: 'v1.0.0', project_name: 'X', error_count: 0 },
    ]);

    const home = await getDashboardHomeForSession();
    expect(home.attention).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   4. The pulse
   ------------------------------------------------------------------------- */

describe('the publishing pulse section', () => {
  it('returns a full window of buckets even with nothing published', async () => {
    answer(SECTION.pulse, []);
    const home = await getDashboardHomeForSession();
    expect(home.pulse).toHaveLength(PULSE_WEEKS);
    expect(home.pulse.every((week) => week.count === 0)).toBe(true);
  });

  it('counts a publish into this week', async () => {
    answer(SECTION.pulse, [{ published_at: new Date() }]);
    const home = await getDashboardHomeForSession();
    expect(home.pulse[home.pulse.length - 1].count).toBe(1);
  });

  it('bounds the window in SQL as well as in the model', async () => {
    await getDashboardHomeForSession();
    const entry = queries.find((candidate) => candidate.sql.includes(SECTION.pulse));
    expect(entry?.sql).toContain("($2 || ' days')::interval");
    expect(entry?.params[1]).toBe('84');
  });
});

/* -------------------------------------------------------------------------
   5. Failing soft, one section at a time
   ------------------------------------------------------------------------- */

describe('failing soft', () => {
  it('costs a failed section its own panel and nothing else', async () => {
    answer(SECTION.workspace, [{ name: 'Acme Corp' }]);
    answer(SECTION.continueProjects, [projectRow()]);
    answer(SECTION.pulse, [{ published_at: new Date() }]);
    fail(SECTION.sunset);
    fail(SECTION.lint);
    fail(SECTION.keys);

    const home = await getDashboardHomeForSession();
    expect(home.workspaceName).toBe('Acme Corp');
    expect(home.continueProjects).toHaveLength(1);
    expect(home.pulse[home.pulse.length - 1].count).toBe(1);
    expect(home.attention).toEqual([]);
  });

  it('still lists projects when the pulse query fails', async () => {
    answer(SECTION.continueProjects, [projectRow()]);
    fail(SECTION.pulse);

    const home = await getDashboardHomeForSession();
    expect(home.continueProjects).toHaveLength(1);
    expect(home.pulse).toEqual([]);
  });

  it('still draws the pulse when the projects query fails', async () => {
    fail(SECTION.continueProjects);
    answer(SECTION.pulse, []);

    const home = await getDashboardHomeForSession();
    expect(home.continueProjects).toEqual([]);
    expect(home.pulse).toHaveLength(PULSE_WEEKS);
  });

  it('returns the empty payload, not a rejection, when every section fails', async () => {
    for (const fragment of Object.values(SECTION)) fail(fragment);

    await expect(getDashboardHomeForSession()).resolves.toEqual({
      workspaceName: null,
      continueProjects: [],
      attention: [],
      pulse: [],
    });
  });

  it('logs which section degraded, so an outage is diagnosable', async () => {
    const errors = console.error as jest.Mock;
    fail(SECTION.keys, 'relation "api_keys" does not exist');
    await getDashboardHomeForSession();

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('key expiry'),
      expect.any(Error),
    );
  });
});
