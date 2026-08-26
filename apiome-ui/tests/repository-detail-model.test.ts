/**
 * The rules behind the repository detail screen (HIVE-7.5, #5322).
 *
 * `repository-detail-hive-redesign.test.tsx` renders the screen and pins its markup;
 * `repository-detail-css.test.ts` pins the declarations. This one pins the *decisions*, with
 * no DOM at all — which is the point of `repositoryDetailModel` existing.
 *
 * What is actually at risk here, and therefore what is tested:
 *
 *   1. **A URL decides what you see.** `?tab=`, `?path=&branch=`, and the precedence between
 *      them. A deep link that lands on the wrong tab is the failure a reader notices first.
 *   2. **A glob and a regex compose into exactly one request.** The endpoint applies one or
 *      the other, so {@link repositoryFilesQuery} has to make the same choice the toolbar
 *      draws — the ticket's "file filters compose as today" criterion.
 *   3. **A figure that is not measured says so.** Every KPI carries `unwired` and a footnote,
 *      and neither may quietly become a zero.
 *   4. **Every stubbed control still says why.** The eight stub sentences are constants, so a
 *      control that stops being a stub cannot keep its apology and a control that still is one
 *      cannot lose it.
 */

import {
  BRANCHES_GITHUB_ONLY_NOTE,
  COMPARE_BRANCHES_STUB_TOAST,
  DEEP_LINK_MISS_TOAST,
  DEFAULT_REPOSITORY_DETAIL_TAB,
  DIFF_VS_DEFAULT_STUB_TOAST,
  EMPTY_REPOSITORY_FILE_FILTERS,
  FILES_EMPTY_COPY,
  FILE_PAGE_SIZE,
  IMPORTABLE_ESTIMATE_UNWIRED,
  MAP_IMPORT_DIFF_STUB_COPY,
  REFRESH_FROM_REMOTE_STUB_TOAST,
  REPOSITORY_DETAIL_TABS,
  REPOSITORY_FILE_PRESETS,
  REPOSITORY_NO_DESCRIPTION,
  RESCAN_BRANCH_STUB_TOAST,
  RESCAN_STUB_TOAST,
  SCAN_HISTORY_STUB_TOAST,
  SUBPATH_GLOB_STUB_NOTE,
  WEBHOOK_STUB_NOTE,
  branchFileCountLine,
  escapeRegexPath,
  formatFileBytes,
  formatImportedByActor,
  formatRelativeWhen,
  isRepositoryFileListNarrowed,
  parseRepositoryDetailTab,
  previewImportsFootLabel,
  readRepositoryFileDeepLink,
  removeRepositoryPrompt,
  repositoryDescriptionLine,
  repositoryDetailKpis,
  repositoryDetailTabFromParams,
  repositoryDetailTabHref,
  repositoryFileConfidence,
  repositoryFilesQuery,
  repositoryFilesShowingLine,
  repositoryFilesSummaryLine,
  repositoryImportedFileHref,
  repositoryProviderSlug,
  repositorySourceLine,
  repositoryWebUrl,
  shortBlobRef,
  shortSha,
  type RepositoryDetailKpiInputs,
} from '@/app/components/ade/repositories/repositoryDetailModel';
import type { DashboardRepository } from '@/app/components/ade/repositories/repositoriesModel';

/**
 * A repository record with everything filled in, so a test can blank exactly the field it is
 * about.
 *
 * @param overrides What this test needs to differ.
 * @returns The record.
 */
function repo(overrides: Partial<DashboardRepository> = {}): DashboardRepository {
  return {
    id: 'repo-1',
    name: 'payments-specs',
    full_name: 'acme/payments-specs',
    description: 'OpenAPI and AsyncAPI sources for the payments platform.',
    provider: 'github',
    default_branch: 'main',
    status: 'ready',
    last_scanned_at: '2026-08-19T10:00:00Z',
    total_files: 1204,
    importable_count: 41,
    branch_count: 3,
    auto_refresh_enabled: true,
    clone_url: 'https://github.com/acme/payments-specs.git',
    source: 'linked_account',
    ...overrides,
  };
}

/** The non-record half of the KPI inputs, with everything present. */
function kpiInputs(overrides: Partial<RepositoryDetailKpiInputs> = {}): RepositoryDetailKpiInputs {
  return {
    stats30d: { totalImports: 9, distinctProjects: 4 },
    importsLoading: false,
    importableMix: { openapi: 22, arazzo: 3, jsonSchema: 16 },
    lastScanLabel: '2h ago',
    ...overrides,
  };
}

describe('which tab a URL names', () => {
  test('every tab round-trips through its own query value', () => {
    for (const tab of REPOSITORY_DETAIL_TABS) {
      expect(parseRepositoryDetailTab(tab)).toBe(tab);
    }
  });

  test('a value that is not a tab opens the overview rather than nothing', () => {
    expect(parseRepositoryDetailTab('speks')).toBe(DEFAULT_REPOSITORY_DETAIL_TAB);
    expect(parseRepositoryDetailTab('')).toBe(DEFAULT_REPOSITORY_DETAIL_TAB);
    expect(parseRepositoryDetailTab(null)).toBe(DEFAULT_REPOSITORY_DETAIL_TAB);
    expect(parseRepositoryDetailTab(undefined)).toBe(DEFAULT_REPOSITORY_DETAIL_TAB);
  });

  test('case and stray space are the same tab — a hand-typed URL still lands', () => {
    expect(parseRepositoryDetailTab(' Settings ')).toBe('settings');
  });

  test('the default tab has no query at all, so the plain route is canonical', () => {
    expect(repositoryDetailTabHref('repo-1', 'preview')).toBe(
      '/ade/dashboard/repositories/repo-1/preview'
    );
    expect(repositoryDetailTabHref('repo-1', 'settings')).toBe(
      '/ade/dashboard/repositories/repo-1/preview?tab=settings'
    );
  });

  test('an id with a slash in it is encoded, not injected into the path', () => {
    expect(repositoryDetailTabHref('a/b', 'files')).toBe(
      '/ade/dashboard/repositories/a%2Fb/preview?tab=files'
    );
  });
});

describe('a file deep link', () => {
  test('needs both halves — a path with no branch names no index entry', () => {
    expect(readRepositoryFileDeepLink(new URLSearchParams('path=a.yaml'))).toBeNull();
    expect(readRepositoryFileDeepLink(new URLSearchParams('branch=main'))).toBeNull();
    expect(readRepositoryFileDeepLink(new URLSearchParams('path=a.yaml&branch=main'))).toEqual({
      path: 'a.yaml',
      branch: 'main',
    });
  });

  test('is ignored when the URL explicitly asks for another tab', () => {
    const params = new URLSearchParams('tab=settings&path=a.yaml&branch=main');
    expect(readRepositoryFileDeepLink(params)).toBeNull();
    expect(repositoryDetailTabFromParams(params)).toBe('settings');
  });

  test('implies the Files tab, whether or not the URL says so', () => {
    expect(repositoryDetailTabFromParams(new URLSearchParams('path=a.yaml&branch=main'))).toBe(
      'files'
    );
    expect(
      repositoryDetailTabFromParams(new URLSearchParams('tab=files&path=a.yaml&branch=main'))
    ).toBe('files');
  });

  test('the href every table prints carries the path and the branch it was imported from', () => {
    const href = repositoryImportedFileHref('repo-1', 'specs/payments/openapi.yaml', 'release/2.4');
    const url = new URL(href, 'https://example.test');
    expect(url.pathname).toBe('/ade/dashboard/repositories/repo-1/preview');
    expect(url.searchParams.get('tab')).toBe('files');
    expect(url.searchParams.get('path')).toBe('specs/payments/openapi.yaml');
    expect(url.searchParams.get('branch')).toBe('release/2.4');
  });
});

describe('the header', () => {
  test('a GitHub registration prints its own slug', () => {
    expect(repositoryProviderSlug(repo())).toBe('github.com/acme/payments-specs');
  });

  test('anything else is derived from the clone URL, without the .git', () => {
    expect(
      repositoryProviderSlug(
        repo({
          provider: 'gitlab',
          full_name: '',
          clone_url: 'https://gitlab.example.com/team/specs.git',
        })
      )
    ).toBe('gitlab.example.com/team/specs');
  });

  test('an unparseable clone URL falls back to the stored name, never to a blank chip', () => {
    expect(
      repositoryProviderSlug(repo({ provider: 'public_url', clone_url: 'not a url' }))
    ).toBe('acme/payments-specs');
    expect(
      repositoryProviderSlug(repo({ provider: 'public_url', clone_url: null, full_name: '' }))
    ).toBe('—');
  });

  test('only a GitHub clone URL resolves to a web page — a wrong link is worse than none', () => {
    expect(repositoryWebUrl(repo())).toBe('https://github.com/acme/payments-specs');
    expect(repositoryWebUrl(repo({ provider: 'gitlab' }))).toBeNull();
    expect(repositoryWebUrl(repo({ clone_url: null }))).toBeNull();
    expect(repositoryWebUrl(null)).toBeNull();
  });

  test('a repository with no description gets the standing sentence, not a hole', () => {
    expect(repositoryDescriptionLine(repo({ description: '   ' }))).toBe(
      REPOSITORY_NO_DESCRIPTION
    );
    expect(repositoryDescriptionLine(repo({ description: null }))).toBe(
      REPOSITORY_NO_DESCRIPTION
    );
    expect(repositoryDescriptionLine(repo())).toContain('payments platform');
  });

  test('the remove prompt names the repository and how to get it back', () => {
    expect(removeRepositoryPrompt('payments-specs')).toContain('payments-specs');
    expect(removeRepositoryPrompt('payments-specs')).toContain('add it again later');
    expect(removeRepositoryPrompt('')).toContain('this repository');
  });

  test('the Source card says both the provider and how it was registered', () => {
    expect(repositorySourceLine('github', 'linked_account')).toBe('Github (linked account)');
    expect(repositorySourceLine('public_url', 'public_url')).toBe('Public URL (public URL)');
    expect(repositorySourceLine('gitlab', null)).toBe('Gitlab');
  });
});

describe('the KPI row', () => {
  test('draws the five figures in the mockup order', () => {
    expect(repositoryDetailKpis(repo(), kpiInputs()).map((k) => k.key)).toEqual([
      'files',
      'importable',
      'branches',
      'imports',
      'scan',
    ]);
  });

  test('prints the stored figures, localised', () => {
    const kpis = repositoryDetailKpis(repo(), kpiInputs());
    expect(kpis[0].value).toBe((1204).toLocaleString());
    expect(kpis[1].value).toBe('41');
    expect(kpis[2].value).toBe('3');
    expect(kpis[3].value).toBe('9');
    expect(kpis[4].value).toBe('2h ago');
  });

  test('an unmeasured figure is an em dash marked `unwired`, never a zero', () => {
    const kpis = repositoryDetailKpis(
      repo({ importable_count: null, branch_count: null, last_scanned_at: null }),
      kpiInputs({ importableMix: null })
    );
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
    expect(byKey.importable.value).toBe('—');
    expect(byKey.importable.unwired).toBe(true);
    expect(byKey.importable.tooltip).toBe(IMPORTABLE_ESTIMATE_UNWIRED);
    expect(byKey.branches.value).toBe('—');
    expect(byKey.branches.unwired).toBe(true);
    expect(byKey.scan.unwired).toBe(true);
  });

  test('a non-GitHub registration is told why its branch count is blank', () => {
    const kpis = repositoryDetailKpis(
      repo({ provider: 'gitlab', branch_count: null }),
      kpiInputs()
    );
    expect(kpis.find((k) => k.key === 'branches')?.tooltip).toBe(BRANCHES_GITHUB_ONLY_NOTE);
  });

  test('the importable share is a percentage of the indexed tree, not of nothing', () => {
    expect(
      repositoryDetailKpis(repo(), kpiInputs()).find((k) => k.key === 'importable')?.footnote
    ).toBe('3.4% of files');
    expect(
      repositoryDetailKpis(repo({ total_files: 0 }), kpiInputs()).find(
        (k) => k.key === 'importable'
      )?.footnote
    ).toBe('share needs an indexed tree');
  });

  test('imports in flight read as loading rather than as zero', () => {
    const loading = repositoryDetailKpis(
      repo(),
      kpiInputs({ stats30d: null, importsLoading: true })
    ).find((k) => k.key === 'imports');
    expect(loading?.value).toBe('—');
    expect(loading?.unwired).toBe(true);

    const none = repositoryDetailKpis(
      repo(),
      kpiInputs({ stats30d: { totalImports: 0, distinctProjects: 0 } })
    ).find((k) => k.key === 'imports');
    expect(none?.value).toBe('0');
    expect(none?.unwired).toBe(false);
    expect(none?.footnote).toBe('none in the last 30 days');
  });

  test('a distinct-project count is singular when it is one', () => {
    expect(
      repositoryDetailKpis(
        repo(),
        kpiInputs({ stats30d: { totalImports: 2, distinctProjects: 1 } })
      ).find((k) => k.key === 'imports')?.footnote
    ).toBe('1 distinct project in the last 30 days');
  });

  test('every figure is pending while a scan runs, and none of them is blanked', () => {
    const kpis = repositoryDetailKpis(repo({ status: 'scanning' }), kpiInputs());
    expect(kpis.every((k) => k.pending)).toBe(true);
    expect(kpis[0].value).toBe((1204).toLocaleString());
  });

  test('a failed scan says so in the footnote, not only in the figure', () => {
    expect(
      repositoryDetailKpis(repo({ status: 'error' }), kpiInputs()).find((k) => k.key === 'scan')
        ?.footnote
    ).toBe('failed');
  });

  test('every figure carries a tooltip — none of them is a bare number', () => {
    for (const kpi of repositoryDetailKpis(repo(), kpiInputs())) {
      expect(kpi.tooltip.length).toBeGreaterThan(20);
      expect(kpi.footnote.length).toBeGreaterThan(0);
    }
  });
});

describe('the file filter query', () => {
  test('the eleven presets are the mockup list, in its order', () => {
    expect(REPOSITORY_FILE_PRESETS.map((p) => p.value)).toEqual([
      'all',
      'openapi',
      'arazzo',
      'asyncapi',
      'json_schema',
      'graphql',
      'protobuf',
      'avro',
      'postman',
      'sql_ddl',
      'custom',
    ]);
  });

  test('a preset and a glob compose — both reach the request', () => {
    const qs = repositoryFilesQuery(
      { ...EMPTY_REPOSITORY_FILE_FILTERS, preset: 'openapi', glob: '**/openapi*.yaml' },
      { branch: 'main', offset: 0 }
    );
    expect(qs.get('preset')).toBe('openapi');
    expect(qs.get('glob')).toBe('**/openapi*.yaml');
    expect(qs.get('regex')).toBeNull();
  });

  test('a regex replaces both, because the endpoint applies one or the other', () => {
    const qs = repositoryFilesQuery(
      { ...EMPTY_REPOSITORY_FILE_FILTERS, preset: 'openapi', glob: '**/*.yaml', regex: 'v\\d+' },
      { branch: 'main', offset: 0 }
    );
    expect(qs.get('regex')).toBe('v\\d+');
    expect(qs.get('preset')).toBeNull();
    expect(qs.get('glob')).toBeNull();
  });

  test('whitespace is not a filter', () => {
    const qs = repositoryFilesQuery(
      { ...EMPTY_REPOSITORY_FILE_FILTERS, glob: '   ', regex: '  ' },
      { branch: 'main', offset: 0 }
    );
    expect(qs.get('regex')).toBeNull();
    expect(qs.get('glob')).toBeNull();
    expect(qs.get('preset')).toBe('all');
  });

  test('the three switches always travel, whichever text filter is in force', () => {
    for (const regex of ['', 'v2']) {
      const qs = repositoryFilesQuery(
        { ...EMPTY_REPOSITORY_FILE_FILTERS, regex, includeHidden: true, skipVendor: false },
        { branch: 'main', offset: 0 }
      );
      expect(qs.get('include_hidden')).toBe('true');
      expect(qs.get('skip_vendor')).toBe('false');
    }
  });

  test('a deep link opens its one path with the importable filter off', () => {
    const qs = repositoryFilesQuery(
      { ...EMPTY_REPOSITORY_FILE_FILTERS, preset: 'graphql', regex: 'nope' },
      { branch: 'main', offset: 100 },
      { path: 'specs/pay.ments+v2.yaml', branch: 'release/2.4' }
    );
    expect(qs.get('branch')).toBe('release/2.4');
    expect(qs.get('offset')).toBe('0');
    expect(qs.get('regex')).toBe('^specs/pay\\.ments\\+v2\\.yaml$');
    expect(qs.get('hide_non_importable')).toBe('false');
    expect(qs.get('preset')).toBeNull();
  });

  test('a path with regex metacharacters matches itself and nothing else', () => {
    expect(escapeRegexPath('a+b(c).yaml')).toBe('a\\+b\\(c\\)\\.yaml');
    expect(new RegExp(`^${escapeRegexPath('a+b(c).yaml')}$`).test('a+b(c).yaml')).toBe(true);
    expect(new RegExp(`^${escapeRegexPath('a+b(c).yaml')}$`).test('aab_c_xyaml')).toBe(false);
  });

  test('the page size is the mockup pager, and the offset travels', () => {
    const qs = repositoryFilesQuery(EMPTY_REPOSITORY_FILE_FILTERS, {
      branch: 'main',
      offset: FILE_PAGE_SIZE,
    });
    expect(qs.get('limit')).toBe(String(FILE_PAGE_SIZE));
    expect(qs.get('offset')).toBe(String(FILE_PAGE_SIZE));
  });

  test('the default toolbar is not narrowing anything', () => {
    expect(isRepositoryFileListNarrowed(EMPTY_REPOSITORY_FILE_FILTERS)).toBe(false);
    expect(
      isRepositoryFileListNarrowed({ ...EMPTY_REPOSITORY_FILE_FILTERS, regex: 'x' })
    ).toBe(true);
    expect(
      isRepositoryFileListNarrowed({ ...EMPTY_REPOSITORY_FILE_FILTERS, skipVendor: false })
    ).toBe(true);
  });
});

describe('the file table', () => {
  test('a size is at the precision its column can hold', () => {
    expect(formatFileBytes(null)).toBe('—');
    expect(formatFileBytes(-1)).toBe('—');
    expect(formatFileBytes(512)).toBe('512 B');
    expect(formatFileBytes(2048)).toBe('2.0 KB');
    expect(formatFileBytes(64 * 1024)).toBe('64 KB');
    expect(formatFileBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatFileBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  test('a blob is git’s own abbreviation length', () => {
    expect(shortSha('9f31ac2ff00ba4')).toBe('9f31ac2');
    expect(shortSha('9f31ac')).toBe('9f31ac');
    expect(shortSha(null)).toBe('—');
    expect(shortBlobRef('9f31ac2ff00ba4')).toBe('9f31ac2…');
    expect(shortBlobRef('   ')).toBe('');
  });

  test('a kind guessed from a filename is the weaker of the two answers', () => {
    expect(repositoryFileConfidence('filename')).toEqual({ label: 'filename', tone: 'outline' });
    expect(repositoryFileConfidence('filename_only')).toEqual({
      label: 'filename',
      tone: 'outline',
    });
    expect(repositoryFileConfidence('content')).toEqual({ label: 'content', tone: 'ok' });
    expect(repositoryFileConfidence('')).toEqual({ label: '—', tone: 'ok' });
  });

  test('the count line names matches, importables and the selection', () => {
    expect(
      repositoryFilesSummaryLine({ matchCount: 41, importableCount: 41, selectedCount: 0 })
    ).toBe('41 files match · 41 importable');
    expect(
      repositoryFilesSummaryLine({ matchCount: 41, importableCount: 41, selectedCount: 2 })
    ).toBe('41 files match · 41 importable · 2 selected');
  });

  test('before the first read the counts are em dashes, not zeros', () => {
    expect(
      repositoryFilesSummaryLine({ matchCount: null, importableCount: null, selectedCount: 0 })
    ).toBe('— files match · — importable');
  });

  test('the pager states the window it is showing', () => {
    expect(repositoryFilesShowingLine({ offset: 0, rows: 50, matchCount: 1204 })).toBe(
      `Showing 1–50 of ${(1204).toLocaleString()}`
    );
    expect(repositoryFilesShowingLine({ offset: 50, rows: 6, matchCount: 56 })).toBe(
      'Showing 51–56 of 56'
    );
    expect(repositoryFilesShowingLine({ offset: 0, rows: 0, matchCount: 0 })).toBe('—');
  });

  test('the empty state names both reasons a page can be blank', () => {
    expect(FILES_EMPTY_COPY).toContain('Run a successful repository scan');
    expect(FILES_EMPTY_COPY).toContain('widen filters');
  });

  test('the branch line counts what the index holds, not what the filter matched', () => {
    expect(branchFileCountLine(1204, 'main')).toBe(`${(1204).toLocaleString()} files on main`);
    expect(branchFileCountLine(null, 'main')).toBe('— files on main');
  });
});

describe('import history rows', () => {
  test('an actor is named, then emailed, then dashed', () => {
    expect(
      formatImportedByActor({ imported_by_name: 'Ada Lovelace', imported_by_email: 'a@b.c' })
    ).toBe('Ada Lovelace');
    expect(formatImportedByActor({ imported_by_name: '  ', imported_by_email: 'a@b.c' })).toBe(
      'a@b.c'
    );
    expect(formatImportedByActor({ imported_by_name: null, imported_by_email: null })).toBe('—');
  });

  test('relative time buckets to the unit a table column can hold', () => {
    const now = Date.parse('2026-08-19T12:00:00Z');
    expect(formatRelativeWhen('2026-08-19T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeWhen('2026-08-19T11:30:00Z', now)).toBe('30m ago');
    expect(formatRelativeWhen('2026-08-19T10:00:00Z', now)).toBe('2h ago');
    expect(formatRelativeWhen('2026-08-16T12:00:00Z', now)).toBe('3d ago');
  });

  test('a timestamp that will not parse is printed rather than swallowed', () => {
    expect(formatRelativeWhen('not-a-date')).toBe('not-a-date');
  });

  test('the preview footer says how much of the history it is showing', () => {
    expect(previewImportsFootLabel(0, 0)).toBe('No imports');
    expect(previewImportsFootLabel(1, 1)).toBe('1 import');
    expect(previewImportsFootLabel(8, 9)).toBe('8 of 9 imports');
  });
});

describe('the stub vocabulary', () => {
  /**
   * Every control on this screen that draws but does not act.
   *
   * Listed rather than pattern-matched, so a stub that is *deleted* — because it was wired —
   * fails here and has to be removed deliberately.
   */
  const STUBS = [
    RESCAN_STUB_TOAST,
    SCAN_HISTORY_STUB_TOAST,
    COMPARE_BRANCHES_STUB_TOAST,
    REFRESH_FROM_REMOTE_STUB_TOAST,
    RESCAN_BRANCH_STUB_TOAST,
    DIFF_VS_DEFAULT_STUB_TOAST,
    SUBPATH_GLOB_STUB_NOTE,
    WEBHOOK_STUB_NOTE,
    MAP_IMPORT_DIFF_STUB_COPY,
    DEEP_LINK_MISS_TOAST,
  ];

  test('each one is a distinct sentence — no two stubs share an apology', () => {
    expect(new Set(STUBS).size).toBe(STUBS.length);
  });

  test('each one says what is missing rather than only that something is', () => {
    for (const sentence of STUBS) {
      expect(sentence.length).toBeGreaterThan(24);
      // A stub that only says "coming soon" tells a reader nothing they can act on.
      expect(sentence.toLowerCase()).not.toMatch(/^coming soon\.?$/);
    }
  });

  test('none of them promises a date', () => {
    for (const sentence of STUBS) {
      expect(sentence).not.toMatch(/\b(next release|this quarter|by \w+ 20\d\d)\b/i);
    }
  });
});
