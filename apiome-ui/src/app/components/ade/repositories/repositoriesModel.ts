/**
 * Every rule the Repositories list obeys, in one React-free module (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria, plus DESIGN.md §3.1 (status vocabulary), §5.3 (page
 * header) and §8 (list page → stat strip → toolbar → table).
 *
 * The 598-line screen this replaces derived all of it inline: the KPI arithmetic, the three
 * filters, the two sorts, the status pill's palette, the provider label and the remove
 * confirm's copy were expressions inside JSX, which is how the card and the table came to
 * print a different last-scan string for the same repository. Everything here is a plain
 * function over plain data, so it is unit-tested directly (`tests/repositories-model.test.ts`)
 * and both views are handed the same answers by construction.
 *
 * ### What is deliberately *not* here
 *
 * - **Parsing.** `dashboardRepositoryFromApi` and `DashboardRepository` stay in
 *   `components/ade/dashboard/repositories/repositoryStoreUi.tsx`: the Add-repository screen
 *   (HIVE-7.4) and the repository detail (HIVE-7.5) read the same payload, and a list-only
 *   module is the wrong home for a shared wire contract.
 * - **Colour.** No tone below is a hue. A status, a health level and a refresh state each
 *   resolve through `ui/statusVocabulary.ts`, which is the module the acceptance criterion
 *   "health states map to the shared status vocabulary" names.
 */

import {
  destructiveConfirm,
  type DestructiveConfirmOptions,
} from '@/app/components/dialogs/destructiveConfirm';
import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import type { RepositoryHealthLevel } from '@/app/components/ade/dashboard/repositories/repositoryHealth';
import type { RefreshStatusCode } from '@/app/components/ade/dashboard/repositories/repository-refresh-status-chip-copy';
import {
  formatLastScan,
  type DashboardRepository,
  type RepositoryProvider,
  type RepositoryStatus,
} from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';

/**
 * The wire types this screen reads, re-exported from their home.
 *
 * They belong to `repositoryStoreUi` — the Add-repository and repository-detail screens parse
 * the same payload — but every component in *this* folder should have one import to reach for,
 * so they are surfaced here rather than each card and cell importing across the tree.
 */
export type { DashboardRepository, RepositoryProvider, RepositoryStatus };

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

/** The four providers a repository may be registered through, in the mockup's order. */
export const REPOSITORY_PROVIDERS: readonly RepositoryProvider[] = [
  'github',
  'gitlab',
  'bitbucket',
  'public_url',
] as const;

/**
 * What each provider is called.
 *
 * `Public URL` rather than `Public Git URL`: it is the label the Add-repository screen already
 * uses for the same choice, and the two must agree or the filter reads as a different axis.
 */
export const REPOSITORY_PROVIDER_LABEL: Readonly<Record<RepositoryProvider, string>> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  public_url: 'Public URL',
};

/** The five lifecycle states a repository row can be in. */
export const REPOSITORY_STATUSES: readonly RepositoryStatus[] = [
  'pending',
  'scanning',
  'ready',
  'error',
  'archived',
] as const;

/** What each lifecycle state is called on a pill. */
export const REPOSITORY_STATUS_LABEL: Readonly<Record<RepositoryStatus, string>> = {
  pending: 'Pending',
  scanning: 'Scanning',
  ready: 'Ready',
  error: 'Error',
  archived: 'Archived',
};

/**
 * A repository's lifecycle state as a tone.
 *
 * Every value is what `statusTone()` already answers for the same string — `pending` is warn,
 * `error` is danger, `archived` is outline — so the table is a *restatement* of the shared
 * vocabulary rather than a second opinion about it. It exists as its own constant only so a
 * test can enumerate the five states without rendering a badge.
 */
export const REPOSITORY_STATUS_TONE: Readonly<Record<RepositoryStatus, StatusTone>> = {
  pending: 'warn',
  scanning: 'accent',
  ready: 'ok',
  error: 'danger',
  archived: 'outline',
};

/** A health level as a tone — `healthy` / `warnings` / `error` (REPO-6.5). */
export const REPOSITORY_HEALTH_TONE: Readonly<Record<RepositoryHealthLevel, StatusTone>> = {
  healthy: 'ok',
  warnings: 'warn',
  error: 'danger',
};

/**
 * A refresh state as a tone — the five the mockup's refresh-activity card draws.
 *
 * `diverged` is violet for the reason the vocabulary gives `private` and `false_positive` the
 * same tone: it is a *judgement* (someone edited the imported copy), not a step on the
 * healthy → broken scale, and painting it amber would put it in a queue it does not belong to.
 */
export const REFRESH_STATUS_TONE: Readonly<Record<RefreshStatusCode, StatusTone>> = {
  'up-to-date': 'ok',
  stale: 'warn',
  refreshing: 'accent',
  failed: 'danger',
  diverged: 'violet',
};

/** The order the refresh-activity chips are drawn in: what needs doing first, healthy last. */
export const REFRESH_STATUS_ORDER: readonly RefreshStatusCode[] = [
  'stale',
  'diverged',
  'failed',
  'refreshing',
  'up-to-date',
] as const;

// ---------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------

/** Where a repository row goes. */
export function repositoryDetailHref(repositoryId: string): string {
  return `/ade/dashboard/repositories/${encodeURIComponent(repositoryId)}/preview`;
}

/** Where the Add-repository screen lives. */
export const ADD_REPOSITORY_HREF = '/ade/dashboard/repositories/new';

/**
 * One tab of the Repositories sub-nav.
 *
 * The four screens were four `secondary` buttons crowded into the page header; the mockup
 * makes them a tab row, which is what they always were — four sibling destinations, not four
 * actions on this page.
 */
export interface RepositoriesNavTab {
  /** Stable id, and the `data-testid` suffix. */
  id: 'list' | 'catalog' | 'telemetry' | 'allowlist';
  /** The tab's label. */
  label: string;
  /** Its route — unchanged from the buttons it replaces. */
  href: string;
  /** What it is for, as the link's `title`. */
  description: string;
}

/**
 * The sub-nav, in the mockup's order.
 *
 * The hrefs are the acceptance criterion "sub-nav tabs preserve the current routes": each one
 * is the exact route the header button it replaces linked to.
 */
export const REPOSITORIES_NAV_TABS: readonly RepositoriesNavTab[] = [
  {
    id: 'list',
    label: 'Repositories',
    href: '/ade/dashboard/repositories',
    description: 'Every repository registered to this workspace',
  },
  {
    id: 'catalog',
    label: 'Discovered specs',
    href: '/ade/dashboard/repositories/catalog',
    description: 'Search every discovered spec across all repositories',
  },
  {
    id: 'telemetry',
    label: 'Quota & rate limits',
    href: '/ade/dashboard/repositories/telemetry',
    description: 'Polling quota usage, deferrals and scan volume over the last week',
  },
  {
    id: 'allowlist',
    label: 'Webhook IP allowlist',
    href: '/ade/dashboard/repositories/webhook-ip-allowlist',
    description: "Provider IP ranges and this workspace's own allowlist for webhook delivery",
  },
] as const;

// ---------------------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------------------

/** The neutral value of every single-choice filter — "not narrowing on this axis". */
export const REPOSITORY_FILTER_ANY = 'all';

/** What the toolbar is currently narrowing the list by. */
export interface RepositoryFilterState {
  /** `all`, or one {@link RepositoryProvider}. */
  provider: string;
  /** `all`, `public`, or `private`. */
  visibility: string;
}

/** Nothing narrowed. */
export const EMPTY_REPOSITORY_FILTERS: RepositoryFilterState = {
  provider: REPOSITORY_FILTER_ANY,
  visibility: REPOSITORY_FILTER_ANY,
};

/** One option of a single-choice filter. */
export interface RepositoryFilterOption {
  /** The stored value. */
  value: string;
  /** What the reader sees. */
  label: string;
}

/** The Provider filter's options, the neutral one first. */
export const REPOSITORY_PROVIDER_OPTIONS: readonly RepositoryFilterOption[] = [
  { value: REPOSITORY_FILTER_ANY, label: 'All providers' },
  ...REPOSITORY_PROVIDERS.map((provider) => ({
    value: provider,
    label: REPOSITORY_PROVIDER_LABEL[provider],
  })),
];

/**
 * The Visibility filter's options.
 *
 * "Private (linked account)" is the mockup's wording and is precise: a private repository is
 * one this workspace can only reach *through* a linked account's credentials, which is a
 * different fact from the `visibility` flag the provider reports.
 */
export const REPOSITORY_VISIBILITY_OPTIONS: readonly RepositoryFilterOption[] = [
  { value: REPOSITORY_FILTER_ANY, label: 'All visibilities' },
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private (linked account)' },
];

/**
 * Search the list.
 *
 * Name, `owner/name` and the default branch — the three the screen this replaces searched, and
 * the three printed on the card, so every hit is visible on the row it matched.
 *
 * @param repositories The rows.
 * @param query The raw search box contents.
 * @returns The rows that match, in their original order. A blank query matches everything.
 */
export function searchRepositories<T extends DashboardRepository>(
  repositories: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return repositories.slice();
  return repositories.filter(
    (repository) =>
      repository.name.toLowerCase().includes(needle) ||
      repository.full_name.toLowerCase().includes(needle) ||
      repository.default_branch.toLowerCase().includes(needle)
  );
}

/**
 * Whether one repository survives the two single-choice filters.
 *
 * A public-URL registration is *always* public whatever the payload's `visibility` says: there
 * is no account behind it to be private with. That is the same rule the screen this replaces
 * applied, kept because the alternative — trusting a field the public-URL path never sets —
 * hides rows the reader can plainly see.
 *
 * @param repository The row.
 * @param filters The toolbar's state.
 * @returns True when the row is not narrowed away.
 */
export function matchesRepositoryFilters(
  repository: DashboardRepository,
  filters: RepositoryFilterState
): boolean {
  if (filters.provider !== REPOSITORY_FILTER_ANY && repository.provider !== filters.provider) {
    return false;
  }
  if (filters.visibility === 'public') {
    return repository.provider === 'public_url' || repository.visibility === 'public';
  }
  if (filters.visibility === 'private') {
    return repository.provider !== 'public_url' && repository.visibility !== 'public';
  }
  return true;
}

/**
 * Whether anything is narrowing the list — which of the two empty states to draw.
 *
 * @param query The search box.
 * @param filters The two filters.
 * @returns True when a reader has narrowed the list themselves.
 */
export function isRepositoryListNarrowed(
  query: string,
  filters: RepositoryFilterState
): boolean {
  return (
    query.trim() !== '' ||
    filters.provider !== REPOSITORY_FILTER_ANY ||
    filters.visibility !== REPOSITORY_FILTER_ANY
  );
}

// ---------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------

/** The two orders the toolbar offers. */
export type RepositorySortKey = 'scanned' | 'name';

/** The default: what was looked at most recently is what a reader came back for. */
export const DEFAULT_REPOSITORY_SORT: RepositorySortKey = 'scanned';

/** The sort options, in the mockup's order. */
export const REPOSITORY_SORT_OPTIONS: readonly { value: RepositorySortKey; label: string }[] = [
  { value: 'scanned', label: 'Sort: Recently scanned' },
  { value: 'name', label: 'Sort: Name' },
];

/** Whether a stored string still names a sort this screen offers. */
export function isRepositorySortKey(value: string): value is RepositorySortKey {
  return value === 'scanned' || value === 'name';
}

/** Epoch milliseconds of a repository's last scan, or 0 when it has never finished one. */
function lastScanMs(repository: DashboardRepository): number {
  if (!repository.last_scanned_at) return 0;
  const parsed = new Date(repository.last_scanned_at).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Order the list.
 *
 * `scanned` is newest first with a name tie-break, which is what makes the order *stable*: a
 * workspace whose repositories have never been scanned has every timestamp at 0, and without
 * the tie-break the grid re-ordered itself on every poll.
 *
 * @param repositories The rows.
 * @param key Which order.
 * @returns A new array; the input is not mutated.
 */
export function sortRepositories<T extends DashboardRepository>(
  repositories: readonly T[],
  key: RepositorySortKey
): T[] {
  const rows = repositories.slice();
  if (key === 'name') {
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return rows;
  }
  rows.sort(
    (a, b) => lastScanMs(b) - lastScanMs(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
  return rows;
}

// ---------------------------------------------------------------------------------------
// The KPI strip
// ---------------------------------------------------------------------------------------

/** The four figures above the list. */
export interface RepositoryKpis {
  /** How many repositories are registered. */
  count: number;
  /** `2 GitHub · 1 GitLab · 1 public URL` — the providers that are actually present. */
  providerSplit: string;
  /** Every provider including the absent ones, for the stat's hover. */
  providerTooltip: string;
  /** Indexed files summed across default branches. */
  files: number;
  /** `2h ago`, or `—` when nothing has ever finished a scan. */
  lastScanLabel: string;
  /** The sentence under it. */
  lastScanNote: string;
  /** Which tone the last-scan dot takes. */
  lastScanTone: StatusTone;
}

/** How the "Imports (30d)" figure is drawn: there is no aggregation behind it yet. */
export const IMPORTS_30D_PLACEHOLDER = '—';

/** …and why, as the stat's hover. Verbatim from the screen this replaces. */
export const IMPORTS_30D_TOOLTIP =
  'Needs import-event aggregation per tenant + repo (API not wired yet).';

/**
 * The four KPI figures.
 *
 * @param repositories Every registered repository, unfiltered — a KPI answers for the
 *   workspace, not for whatever the toolbar currently leaves on screen.
 * @param now Reference epoch milliseconds, passed explicitly so the relative last-scan phrase
 *   is deterministic under test.
 * @returns The figures and the sentences beneath them.
 */
export function repositoryKpis(
  repositories: readonly DashboardRepository[],
  now: number = Date.now()
): RepositoryKpis {
  const byProvider = new Map<RepositoryProvider, number>();
  let files = 0;
  let latest = 0;

  for (const repository of repositories) {
    byProvider.set(repository.provider, (byProvider.get(repository.provider) ?? 0) + 1);
    files += repository.total_files ?? 0;
    latest = Math.max(latest, lastScanMs(repository));
  }

  const split = REPOSITORY_PROVIDERS.filter((provider) => (byProvider.get(provider) ?? 0) > 0).map(
    (provider) => `${byProvider.get(provider)} ${REPOSITORY_PROVIDER_LABEL[provider]}`
  );
  const tooltip = REPOSITORY_PROVIDERS.map(
    (provider) => `${byProvider.get(provider) ?? 0} ${REPOSITORY_PROVIDER_LABEL[provider]}`
  ).join(' · ');

  const hasErrors = repositories.some((repository) => repository.status === 'error');
  const scanned = latest > 0;

  return {
    count: repositories.length,
    providerSplit: split.length > 0 ? split.join(' · ') : '—',
    providerTooltip: tooltip,
    files,
    lastScanLabel: scanned ? formatLastScan(new Date(latest).toISOString(), false, now) : '—',
    lastScanNote: !scanned
      ? 'No scans yet'
      : hasErrors
        ? 'Some repos need attention'
        : 'All repos healthy',
    lastScanTone: !scanned ? 'neutral' : hasErrors ? 'warn' : 'ok',
  };
}

/** The hover on the "Files indexed" stat — what the number is and is not. */
export const FILES_INDEXED_TOOLTIP =
  'Sum of `total_files` from scan results across repos (0 until indexing runs).';

/** The line under the "Files indexed" figure. */
export const FILES_INDEXED_FOOTNOTE = 'across all default branches';

// ---------------------------------------------------------------------------------------
// The index snapshot — what the card's footer and the table's last column draw
// ---------------------------------------------------------------------------------------

/** One bar of the last-scans strip. */
export interface RepositoryScanBar {
  /** Which branch the scan ran on. */
  branch: string;
  /** When it finished, ISO-8601. */
  finishedAt: string;
  /** Whether it failed. A failed scan is drawn short and in the danger tone. */
  failed: boolean;
}

/** How many scans the strip shows. The mockup draws ten. */
export const SCAN_BAR_LIMIT = 10;

/**
 * What a repository's index snapshot should draw, and the sentence that describes it.
 *
 * Four shapes, in the order the data supports them: the scan strip when scan history is
 * available, otherwise the importable-share meter when files have been indexed, otherwise a
 * spinner while a scan is running, otherwise a dash. The screen this replaces made the same
 * four choices inside a component; stating them as data is what lets a test assert that a
 * repository with both history *and* files draws the history.
 */
export type RepositoryIndexSnapshot =
  | { kind: 'scans'; bars: RepositoryScanBar[]; failed: number; label: string }
  | {
      kind: 'meter';
      /** Indexed files that matched an importable pattern, clamped into `total`. */
      importable: number;
      /** Indexed files. */
      total: number;
      /** The share as a whole percent, or `null` when no importable tally exists yet. */
      percent: number | null;
      label: string;
    }
  | { kind: 'scanning'; label: string }
  | { kind: 'none'; label: string };

/**
 * Decide what to draw for one repository.
 *
 * @param repository The row.
 * @returns The snapshot shape and its accessible sentence.
 */
export function repositoryIndexSnapshot(
  repository: DashboardRepository
): RepositoryIndexSnapshot {
  const history = repository.recent_scans ?? [];
  if (history.length > 0) {
    const bars = history
      .slice()
      .sort((a, b) => new Date(a.finished_at).getTime() - new Date(b.finished_at).getTime())
      .slice(-SCAN_BAR_LIMIT)
      .map((scan) => ({ branch: scan.branch, finishedAt: scan.finished_at, failed: scan.failed }));
    const failed = bars.filter((bar) => bar.failed).length;
    const latest = bars[bars.length - 1]?.branch ?? 'unknown branch';
    return {
      kind: 'scans',
      bars,
      failed,
      label:
        failed > 0
          ? `${bars.length} recent scans, ${failed} failed, latest on ${latest}.`
          : `${bars.length} recent scans, all succeeded, latest on ${latest}.`,
    };
  }

  const total = typeof repository.total_files === 'number' ? repository.total_files : 0;
  if (total > 0) {
    const raw = repository.importable_count;
    const hasImportable = typeof raw === 'number';
    const importable = hasImportable ? Math.max(0, Math.min(raw, total)) : 0;
    const percent = hasImportable ? Math.round((importable / total) * 100) : null;
    return {
      kind: 'meter',
      importable,
      total,
      percent,
      label: hasImportable
        ? `${importable.toLocaleString()} of ${total.toLocaleString()} indexed files matched importable patterns (${percent}%).`
        : `${total.toLocaleString()} indexed files; importable tally not available yet.`,
    };
  }

  if (repository.status === 'scanning') {
    return { kind: 'scanning', label: 'Repository scan in progress.' };
  }
  if (repository.status === 'pending') {
    return { kind: 'none', label: 'Scan not started yet.' };
  }
  return { kind: 'none', label: 'No indexed files yet.' };
}

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------

/**
 * The one-line summary under the page title.
 *
 * @param repositories Every registered repository.
 * @returns `4 repositories · 3,412 files indexed · 1 needs attention`, or the invitation when
 *   the workspace has none.
 */
export function repositoriesSummaryLine(repositories: readonly DashboardRepository[]): string {
  if (repositories.length === 0) {
    return 'Browse repositories registered to this workspace and pick one to explore its files.';
  }
  const files = repositories.reduce((sum, repository) => sum + (repository.total_files ?? 0), 0);
  const attention = repositories.filter(
    (repository) => repository.status === 'error' || repository.health?.level === 'error'
  ).length;
  const parts = [
    `${repositories.length.toLocaleString()} ${repositories.length === 1 ? 'repository' : 'repositories'}`,
    `${files.toLocaleString()} ${files === 1 ? 'file' : 'files'} indexed`,
  ];
  if (attention > 0) parts.push(`${attention.toLocaleString()} needs attention`);
  return parts.join(' · ');
}

/**
 * The table's foot.
 *
 * @param shown How many rows survived the toolbar.
 * @param total How many are registered.
 * @returns `Showing 3 of 4 repositories`.
 */
export function repositoryFootLabel(shown: number, total: number): string {
  return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${
    total === 1 ? 'repository' : 'repositories'
  }`;
}

/** What the stubbed "Rescan all" button says when pressed. Verbatim, per the mockup's notes. */
export const RESCAN_ALL_TOAST =
  'Rescan all repositories will run when scan jobs are wired to the API.';

/** …and the single-repository variant of the same stub. */
export const RESCAN_TOAST = 'Rescan will run when scan jobs are wired to the API.';

/** What a failed list read says. */
export const REPOSITORIES_LOAD_ERROR = 'Could not load repositories.';

/**
 * The remove confirm.
 *
 * Reversible — the repository can be registered again from Add repository — so no
 * type-to-confirm gate: DESIGN.md §8 reserves that for what cannot be undone, and the useful
 * sentence here is how to get the repository back. The consequence wording is the mockup's,
 * kept verbatim because it is the one piece of copy the **Keeps (1:1)** list quotes.
 *
 * @param repository The repository the menu was opened on.
 * @returns Options for `useDialog().confirm`.
 */
export function removeRepositoryConfirm(
  repository: Pick<DashboardRepository, 'name'>
): DestructiveConfirmOptions {
  return destructiveConfirm({
    action: 'Remove',
    name: repository.name,
    consequence:
      'The repository is removed from this workspace. You can add it again later from Add repository.',
    confirmLabel: 'Remove from list',
  });
}
