/**
 * The Repositories list's rule set (HIVE-7.3, #5320).
 *
 * `repositories-hive-redesign.test.tsx` renders the screen and `repositories-css.test.ts` pins
 * the declarations; this holds the decisions, which are all plain functions over plain data.
 *
 * What it is guarding, in the order the ticket states it:
 *
 *   1. **Health, status and refresh states map to the shared status vocabulary.** All three
 *      tone tables are asserted against `statusTone()` itself, so a table here can never drift
 *      from the badge the rest of the app draws for the same word.
 *   2. **Provider labels are the four the mockup names**, and the filter offers each of them.
 *   3. **The sub-nav preserves the current routes** — the four hrefs are the four the header
 *      buttons this ticket removes pointed at.
 *   4. **The empty state is chosen by whether the reader narrowed the list**, which is what
 *      makes "No matches" and "No repositories yet" two different sentences.
 *
 * Plus the arithmetic the screen this replaces did inline and got subtly wrong: the KPI's
 * provider split, the last-scan phrase, the index snapshot's four-way choice, and a sort that
 * re-ordered itself on every poll because it had no tie-break.
 */

import { statusTone } from '../src/app/components/ui/statusVocabulary';
import type { DashboardRepository } from '../src/app/components/ade/dashboard/repositories/repositoryStoreUi';
import {
  ADD_REPOSITORY_HREF,
  DEFAULT_REPOSITORY_SORT,
  EMPTY_REPOSITORY_FILTERS,
  FILES_INDEXED_TOOLTIP,
  IMPORTS_30D_PLACEHOLDER,
  IMPORTS_30D_TOOLTIP,
  REFRESH_STATUS_ORDER,
  REFRESH_STATUS_TONE,
  REPOSITORIES_NAV_TABS,
  REPOSITORY_FILTER_ANY,
  REPOSITORY_HEALTH_TONE,
  REPOSITORY_PROVIDERS,
  REPOSITORY_PROVIDER_LABEL,
  REPOSITORY_PROVIDER_OPTIONS,
  REPOSITORY_SORT_OPTIONS,
  REPOSITORY_STATUSES,
  REPOSITORY_STATUS_LABEL,
  REPOSITORY_STATUS_TONE,
  REPOSITORY_VISIBILITY_OPTIONS,
  RESCAN_ALL_TOAST,
  isRepositoryListNarrowed,
  isRepositorySortKey,
  matchesRepositoryFilters,
  removeRepositoryConfirm,
  repositoriesSummaryLine,
  repositoryDetailHref,
  repositoryFootLabel,
  repositoryIndexSnapshot,
  repositoryKpis,
  searchRepositories,
  sortRepositories,
} from '../src/app/components/ade/repositories/repositoriesModel';

/** A fixed clock, so every relative phrase below is deterministic. */
const NOW = Date.parse('2026-08-18T12:00:00Z');

/**
 * One repository, with everything the list reads set to something plausible.
 *
 * @param overrides What this row differs by.
 * @returns The row.
 */
function repo(overrides: Partial<DashboardRepository> = {}): DashboardRepository {
  return {
    id: 'repo-payments',
    name: 'payments-specs',
    full_name: 'acme/payments-specs',
    description: 'OpenAPI and AsyncAPI sources for the payments platform.',
    provider: 'github',
    default_branch: 'main',
    visibility: 'private',
    status: 'ready',
    last_scanned_at: '2026-08-18T10:00:00Z',
    recent_scans: [],
    total_files: 1204,
    importable_count: 120,
    branch_count: 4,
    auto_refresh_enabled: true,
    health: null,
    ...overrides,
  };
}

describe('the status vocabulary', () => {
  it('resolves every repository lifecycle state through the shared table', () => {
    for (const status of REPOSITORY_STATUSES) {
      expect(REPOSITORY_STATUS_TONE[status]).toBe(statusTone(status));
    }
  });

  it('resolves every health level through the shared table', () => {
    for (const level of ['healthy', 'warnings', 'error'] as const) {
      expect(REPOSITORY_HEALTH_TONE[level]).toBe(statusTone(level));
    }
  });

  it('resolves every refresh state through the shared table', () => {
    for (const code of REFRESH_STATUS_ORDER) {
      expect(REFRESH_STATUS_TONE[code]).toBe(statusTone(code));
    }
  });

  it('names each lifecycle state once, in sentence case', () => {
    const labels = REPOSITORY_STATUSES.map((status) => REPOSITORY_STATUS_LABEL[status]);
    expect(labels).toEqual(['Pending', 'Scanning', 'Ready', 'Error', 'Archived']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('draws the refresh chips attention-first and healthy last', () => {
    expect(REFRESH_STATUS_ORDER).toEqual([
      'stale',
      'diverged',
      'failed',
      'refreshing',
      'up-to-date',
    ]);
  });
});

describe('providers', () => {
  it('names the four the mockup draws', () => {
    expect(REPOSITORY_PROVIDERS.map((provider) => REPOSITORY_PROVIDER_LABEL[provider])).toEqual([
      'GitHub',
      'GitLab',
      'Bitbucket',
      'Public URL',
    ]);
  });

  it('offers each of them in the filter, behind the neutral option', () => {
    expect(REPOSITORY_PROVIDER_OPTIONS[0]).toEqual({
      value: REPOSITORY_FILTER_ANY,
      label: 'All providers',
    });
    expect(REPOSITORY_PROVIDER_OPTIONS.slice(1).map((option) => option.value)).toEqual([
      ...REPOSITORY_PROVIDERS,
    ]);
  });
});

describe('the sub-nav', () => {
  it('preserves the routes the header buttons it replaces pointed at', () => {
    expect(REPOSITORIES_NAV_TABS.map((tab) => tab.href)).toEqual([
      '/ade/dashboard/repositories',
      '/ade/dashboard/repositories/catalog',
      '/ade/dashboard/repositories/telemetry',
      '/ade/dashboard/repositories/webhook-ip-allowlist',
    ]);
  });

  it('gives every tab a label and a sentence saying what it is for', () => {
    for (const tab of REPOSITORIES_NAV_TABS) {
      expect(tab.label.trim()).not.toBe('');
      expect(tab.description.trim()).not.toBe('');
    }
  });

  it('sends a row to the repository preview and the primary action to Add repository', () => {
    expect(repositoryDetailHref('repo one')).toBe(
      '/ade/dashboard/repositories/repo%20one/preview'
    );
    expect(ADD_REPOSITORY_HREF).toBe('/ade/dashboard/repositories/new');
  });
});

describe('searchRepositories', () => {
  const rows = [
    repo(),
    repo({ id: 'b', name: 'legacy-soap', full_name: 'git.example.org/acme/legacy-soap' }),
    repo({ id: 'c', name: 'orders', full_name: 'acme/orders', default_branch: 'trunk' }),
  ];

  it('matches the name, the full name and the branch', () => {
    expect(searchRepositories(rows, 'payments').map((row) => row.id)).toEqual(['repo-payments']);
    expect(searchRepositories(rows, 'example.org').map((row) => row.id)).toEqual(['b']);
    expect(searchRepositories(rows, 'trunk').map((row) => row.id)).toEqual(['c']);
  });

  it('ignores case and surrounding space, and a blank query matches everything', () => {
    expect(searchRepositories(rows, '  LEGACY  ').map((row) => row.id)).toEqual(['b']);
    expect(searchRepositories(rows, '   ')).toHaveLength(rows.length);
  });

  it('does not mutate the input', () => {
    const input = rows.slice();
    searchRepositories(input, 'payments');
    expect(input).toEqual(rows);
  });
});

describe('matchesRepositoryFilters', () => {
  it('narrows by provider', () => {
    expect(
      matchesRepositoryFilters(repo({ provider: 'gitlab' }), {
        ...EMPTY_REPOSITORY_FILTERS,
        provider: 'gitlab',
      })
    ).toBe(true);
    expect(
      matchesRepositoryFilters(repo({ provider: 'github' }), {
        ...EMPTY_REPOSITORY_FILTERS,
        provider: 'gitlab',
      })
    ).toBe(false);
  });

  it('treats a public-URL registration as public whatever the payload says', () => {
    // There is no account behind a public clone URL to be private with, and the public-URL
    // registration path never sets `visibility` — so trusting the field would hide a row the
    // reader can plainly see is public.
    const publicUrl = repo({ provider: 'public_url', visibility: undefined });
    expect(
      matchesRepositoryFilters(publicUrl, { ...EMPTY_REPOSITORY_FILTERS, visibility: 'public' })
    ).toBe(true);
    expect(
      matchesRepositoryFilters(publicUrl, { ...EMPTY_REPOSITORY_FILTERS, visibility: 'private' })
    ).toBe(false);
  });

  it('counts a provider repository marked public as public, not as linked-account private', () => {
    const open = repo({ provider: 'github', visibility: 'public' });
    expect(
      matchesRepositoryFilters(open, { ...EMPTY_REPOSITORY_FILTERS, visibility: 'public' })
    ).toBe(true);
    expect(
      matchesRepositoryFilters(open, { ...EMPTY_REPOSITORY_FILTERS, visibility: 'private' })
    ).toBe(false);
  });

  it('lets everything through when nothing is chosen', () => {
    for (const provider of REPOSITORY_PROVIDERS) {
      expect(matchesRepositoryFilters(repo({ provider }), EMPTY_REPOSITORY_FILTERS)).toBe(true);
    }
  });

  it('offers both visibilities behind the neutral option', () => {
    expect(REPOSITORY_VISIBILITY_OPTIONS.map((option) => option.value)).toEqual([
      REPOSITORY_FILTER_ANY,
      'public',
      'private',
    ]);
    expect(REPOSITORY_VISIBILITY_OPTIONS[2].label).toBe('Private (linked account)');
  });
});

describe('isRepositoryListNarrowed', () => {
  it('is false only when nothing has been typed or chosen', () => {
    expect(isRepositoryListNarrowed('', EMPTY_REPOSITORY_FILTERS)).toBe(false);
    expect(isRepositoryListNarrowed('   ', EMPTY_REPOSITORY_FILTERS)).toBe(false);
    expect(isRepositoryListNarrowed('a', EMPTY_REPOSITORY_FILTERS)).toBe(true);
    expect(
      isRepositoryListNarrowed('', { ...EMPTY_REPOSITORY_FILTERS, provider: 'github' })
    ).toBe(true);
    expect(
      isRepositoryListNarrowed('', { ...EMPTY_REPOSITORY_FILTERS, visibility: 'public' })
    ).toBe(true);
  });
});

describe('sortRepositories', () => {
  const a = repo({ id: 'a', name: 'alpha', last_scanned_at: '2026-08-18T09:00:00Z' });
  const b = repo({ id: 'b', name: 'bravo', last_scanned_at: '2026-08-18T11:00:00Z' });
  const c = repo({ id: 'c', name: 'charlie', last_scanned_at: null });

  it('puts the most recently scanned first', () => {
    expect(sortRepositories([a, b, c], 'scanned').map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by name when asked', () => {
    expect(sortRepositories([c, b, a], 'name').map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by name, so a never-scanned workspace does not re-order on every poll', () => {
    const never = [
      repo({ id: '3', name: 'gamma', last_scanned_at: null }),
      repo({ id: '1', name: 'alpha', last_scanned_at: null }),
      repo({ id: '2', name: 'beta', last_scanned_at: null }),
    ];
    expect(sortRepositories(never, 'scanned').map((row) => row.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('treats an unparseable timestamp as never scanned rather than as NaN', () => {
    const broken = repo({ id: 'x', name: 'zulu', last_scanned_at: 'not-a-date' });
    expect(sortRepositories([broken, b], 'scanned').map((row) => row.id)).toEqual(['b', 'x']);
  });

  it('does not mutate the input', () => {
    const input = [b, a, c];
    sortRepositories(input, 'name');
    expect(input.map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('offers exactly the two orders the mockup draws, defaulting to recently scanned', () => {
    expect(REPOSITORY_SORT_OPTIONS.map((option) => option.value)).toEqual(['scanned', 'name']);
    expect(DEFAULT_REPOSITORY_SORT).toBe('scanned');
    expect(isRepositorySortKey('scanned')).toBe(true);
    expect(isRepositorySortKey('nonsense')).toBe(false);
  });
});

describe('repositoryKpis', () => {
  it('splits the count by provider, listing only the providers present', () => {
    const kpis = repositoryKpis(
      [
        repo({ id: '1', provider: 'github' }),
        repo({ id: '2', provider: 'github' }),
        repo({ id: '3', provider: 'gitlab' }),
        repo({ id: '4', provider: 'public_url' }),
      ],
      NOW
    );
    expect(kpis.count).toBe(4);
    expect(kpis.providerSplit).toBe('2 GitHub · 1 GitLab · 1 Public URL');
    // The hover names every provider, including the ones at zero, so the split is readable
    // as an answer rather than as an omission.
    expect(kpis.providerTooltip).toBe('2 GitHub · 1 GitLab · 0 Bitbucket · 1 Public URL');
  });

  it('sums indexed files across the workspace', () => {
    expect(
      repositoryKpis([repo({ id: '1', total_files: 1204 }), repo({ id: '2', total_files: null })], NOW)
        .files
    ).toBe(1204);
  });

  it('reports the most recent scan, and says whether anything needs attention', () => {
    const healthy = repositoryKpis(
      [repo({ id: '1', last_scanned_at: '2026-08-18T10:00:00Z' })],
      NOW
    );
    expect(healthy.lastScanLabel).toBe('2h ago');
    expect(healthy.lastScanNote).toBe('All repos healthy');
    expect(healthy.lastScanTone).toBe('ok');

    const broken = repositoryKpis(
      [
        repo({ id: '1', last_scanned_at: '2026-08-18T10:00:00Z' }),
        repo({ id: '2', status: 'error' }),
      ],
      NOW
    );
    expect(broken.lastScanNote).toBe('Some repos need attention');
    expect(broken.lastScanTone).toBe('warn');
  });

  it('says so when nothing has ever finished a scan', () => {
    const kpis = repositoryKpis([repo({ id: '1', last_scanned_at: null })], NOW);
    expect(kpis.lastScanLabel).toBe('—');
    expect(kpis.lastScanNote).toBe('No scans yet');
    expect(kpis.lastScanTone).toBe('neutral');
  });

  it('answers for an empty workspace without dividing by anything', () => {
    const kpis = repositoryKpis([], NOW);
    expect(kpis).toMatchObject({
      count: 0,
      providerSplit: '—',
      files: 0,
      lastScanLabel: '—',
      lastScanNote: 'No scans yet',
    });
  });

  it('keeps the Imports (30d) figure honest about being unwired', () => {
    expect(IMPORTS_30D_PLACEHOLDER).toBe('—');
    expect(IMPORTS_30D_TOOLTIP).toContain('not wired yet');
    expect(FILES_INDEXED_TOOLTIP).toContain('total_files');
  });
});

describe('repositoryIndexSnapshot', () => {
  it('draws the scan strip when scan history exists, newest last and capped at ten', () => {
    const scans = Array.from({ length: 14 }, (_, index) => ({
      branch: 'main',
      finished_at: `2026-08-0${(index % 9) + 1}T00:00:0${index % 10}Z`,
      failed: index === 0,
    }));
    const snapshot = repositoryIndexSnapshot(repo({ recent_scans: scans }));
    expect(snapshot.kind).toBe('scans');
    if (snapshot.kind !== 'scans') throw new Error('expected the scan strip');
    expect(snapshot.bars).toHaveLength(10);
    expect(snapshot.label).toContain('10 recent scans');
  });

  it('prefers scan history over file counts', () => {
    const snapshot = repositoryIndexSnapshot(
      repo({
        total_files: 1000,
        importable_count: 10,
        recent_scans: [{ branch: 'main', finished_at: '2026-08-18T00:00:00Z', failed: false }],
      })
    );
    expect(snapshot.kind).toBe('scans');
  });

  it('counts the failures and says so in the sentence', () => {
    const snapshot = repositoryIndexSnapshot(
      repo({
        recent_scans: [
          { branch: 'main', finished_at: '2026-08-17T00:00:00Z', failed: true },
          { branch: 'main', finished_at: '2026-08-18T00:00:00Z', failed: false },
        ],
      })
    );
    if (snapshot.kind !== 'scans') throw new Error('expected the scan strip');
    expect(snapshot.failed).toBe(1);
    expect(snapshot.label).toContain('1 failed');
  });

  it('draws the importable meter when files are indexed, clamped into the total', () => {
    const snapshot = repositoryIndexSnapshot(repo({ total_files: 400, importable_count: 900 }));
    if (snapshot.kind !== 'meter') throw new Error('expected the meter');
    expect(snapshot.importable).toBe(400);
    expect(snapshot.percent).toBe(100);
  });

  it('leaves the share unmeasured when no importable tally has arrived', () => {
    const snapshot = repositoryIndexSnapshot(repo({ total_files: 400, importable_count: null }));
    if (snapshot.kind !== 'meter') throw new Error('expected the meter');
    expect(snapshot.percent).toBeNull();
    expect(snapshot.label).toContain('not available yet');
  });

  it('draws the spinner only while a scan is running with nothing indexed yet', () => {
    expect(
      repositoryIndexSnapshot(repo({ status: 'scanning', total_files: 0, recent_scans: [] })).kind
    ).toBe('scanning');
  });

  it('says which kind of nothing it is', () => {
    expect(
      repositoryIndexSnapshot(repo({ status: 'pending', total_files: 0, recent_scans: [] })).label
    ).toBe('Scan not started yet.');
    expect(
      repositoryIndexSnapshot(repo({ status: 'ready', total_files: 0, recent_scans: [] })).label
    ).toBe('No indexed files yet.');
  });
});

describe('copy', () => {
  it('summarises the workspace under the title, and invites when it is empty', () => {
    expect(repositoriesSummaryLine([])).toContain('Browse repositories registered');
    expect(
      repositoriesSummaryLine([repo({ id: '1', total_files: 10 }), repo({ id: '2', total_files: 5 })])
    ).toBe('2 repositories · 15 files indexed');
    expect(
      repositoriesSummaryLine([
        repo({ id: '1', total_files: 1 }),
        repo({ id: '2', total_files: 0, status: 'error' }),
      ])
    ).toBe('2 repositories · 1 file indexed · 1 needs attention');
  });

  it('counts a repository whose health is error as needing attention', () => {
    const unhealthy = repo({
      id: '1',
      status: 'ready',
      total_files: 0,
      health: {
        level: 'error',
        score: 10,
        window_days: 30,
        scans_attempted: 0,
        scans_succeeded: 0,
        scan_success_rate: null,
        parse_error_count: 0,
        primary_factor: null,
        factors: [],
      },
    });
    expect(repositoriesSummaryLine([unhealthy])).toContain('1 needs attention');
  });

  it('states the table foot in the mockup words, singular and plural', () => {
    expect(repositoryFootLabel(3, 4)).toBe('Showing 3 of 4 repositories');
    expect(repositoryFootLabel(1, 1)).toBe('Showing 1 of 1 repository');
    expect(repositoryFootLabel(1000, 2000)).toBe('Showing 1,000 of 2,000 repositories');
  });

  it('keeps the Rescan-all stub honest about why nothing happened', () => {
    expect(RESCAN_ALL_TOAST).toBe(
      'Rescan all repositories will run when scan jobs are wired to the API.'
    );
  });
});

describe('removeRepositoryConfirm', () => {
  const options = removeRepositoryConfirm({ name: 'payments-specs' });

  it('names the object in the title, per DESIGN.md §8', () => {
    expect(options.title).toBe('Remove "payments-specs"?');
  });

  it('states the consequence and how to undo it, as its own sentence', () => {
    expect(options.message).toBe(
      'The repository is removed from this workspace. You can add it again later from Add repository.'
    );
  });

  it('is a red primary whose button is the verb, not "OK"', () => {
    expect(options.variant).toBe('danger');
    expect(options.confirmLabel).toBe('Remove from list');
  });

  it('is not gated: removing a registration is reversible', () => {
    // §8 reserves type-to-confirm for what cannot be undone. A gate on every confirm is a
    // gate nobody reads.
    expect(options.typeToConfirm).toBeFalsy();
    expect(options.consequence).toBeUndefined();
  });
});
