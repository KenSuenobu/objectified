/**
 * The rules the Projects screen runs on (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html` and its **Notes → Keeps (1:1)** list;
 * `docs/mockups/DESIGN.md` §8 (list page, destructive confirms) and §3.1 (status vocabulary).
 *
 * Projects is the app's front door, and before this ticket almost every decision it makes
 * lived inside the 1,731-line `page.tsx`: which chip counts what, what the header sentence
 * says, whether an orb has a score to draw, which of the two quality numbers wins, what the
 * permanent-delete confirm asks you to type. None of it could be tested without rendering
 * the whole screen, and the card and the table each carried their own copy of the score
 * derivation — which is why they could disagree about an empty project.
 *
 * Everything here is pure and React-free, so the two views import one answer instead of
 * writing two. There is no colour and no class name in this file: a tone is looked up from
 * `ui/statusVocabulary` and `ui/metrics/metricTiers` by the component that paints it.
 *
 * @see `./ProjectCard.tsx` and `./ProjectsTable.tsx` — the two views these rules serve.
 * @see `@/app/utils/projects-dashboard-sort` — the comparators, which predate this ticket
 *   and are unchanged; this module only bridges them to `DataTable`'s sort state.
 */

import type { DataTableSortState } from '@/app/components/ui/DataTable';
import {
  destructiveConfirm,
  type DestructiveConfirmOptions,
} from '@/app/components/dialogs/destructiveConfirm';
import { letterGradeFromOverallPercent } from '@/app/utils/numeric-score-tier';
import { getProjectDomainCategoryLabel } from '@/app/utils/project-domain-categories';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';
import {
  sortProjectsDashboardRows,
  type ProjectsDashboardSortColumn,
  type ProjectsDashboardSortDirection,
} from '@/app/utils/projects-dashboard-sort';
import type { ProjectOpenApiMetadata } from '@/app/utils/project-templates';

// ---------------------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------------------

/**
 * One project, as `/api/projects` returns it.
 *
 * Kept as an interface here rather than in the page because both views, the two dialogs and
 * every rule below read it, and a screen-local type would have to be exported from a
 * component to be reachable.
 */
export interface Project {
  id: string;
  tenant_id: string;
  creator_id: string;
  name: string;
  /** URL slug from the API when present — the phrase a permanent delete is gated on. */
  slug?: string;
  description: string;
  enabled: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  creator_name: string;
  creator_email: string;
  metadata?: ProjectOpenApiMetadata;
  /**
   * The Project-vs-Catalog boundary (MFI-23.1): `false` marks a catalog item, which never
   * lists here (#4587). Filtered on read, not here — see `isProjectPublishable`.
   */
  publishable?: boolean;
  /** Mean quality score across the project's versions (#3609), camelCase from REST. */
  qualityScore?: number | null;
  qualityGrade?: string | null;
  /** Live version count from the server summary (0 = empty project). */
  versionsCount?: number;
}

/** The quality history of every project on screen, keyed by project id. */
export type ProjectQualityHistoryMap = Readonly<
  Record<string, readonly ProjectQualitySnapshot[]>
>;

/** The latest quality score of every project on screen, or `null` where there is none. */
export type ProjectQualityMap = Readonly<Record<string, number | null>>;

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

/**
 * What state a project is in, as one word.
 *
 * Three states, not two flags: `enabled` and `deleted_at` are independent in the database,
 * but a deleted project's enabled flag is *remembered* rather than *meaningful* — undelete
 * restores it — so a reader should only ever be shown the outer one.
 */
export type ProjectLifecycle = 'active' | 'disabled' | 'deleted';

/**
 * The state a project is in.
 *
 * @param project The row.
 * @returns `deleted` when it is soft-deleted, otherwise `active` or `disabled`.
 */
export function projectLifecycle(project: Project): ProjectLifecycle {
  if (project.deleted_at) return 'deleted';
  return project.enabled ? 'active' : 'disabled';
}

/** The label for each lifecycle state — the shared vocabulary's spelling, sentence case. */
export const PROJECT_LIFECYCLE_LABEL: Readonly<Record<ProjectLifecycle, string>> = {
  active: 'Active',
  disabled: 'Disabled',
  deleted: 'Deleted',
};

/**
 * Whether a project's row or card opens its versions.
 *
 * A deleted project has nothing to open — its versions are hidden with it — so the whole
 * hit area goes inert rather than routing to a page that would say "no versions".
 *
 * @param project The row.
 * @returns True when clicking it should route to `/ade/dashboard/versions`.
 */
export function isProjectOpenable(project: Project): boolean {
  return !project.deleted_at;
}

/** Where a project's versions live. */
export function projectVersionsHref(project: Project): string {
  return `/ade/dashboard/versions?projectId=${encodeURIComponent(project.id)}`;
}

// ---------------------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------------------

/** The four view chips of the mockup's toolbar. */
export type ProjectFacet = 'all' | 'active' | 'attention' | 'deleted';

/** Every facet, in the order the toolbar draws them. */
export const PROJECT_FACETS: readonly ProjectFacet[] = [
  'all',
  'active',
  'attention',
  'deleted',
] as const;

/** What each chip says. */
export const PROJECT_FACET_LABELS: Readonly<Record<ProjectFacet, string>> = {
  all: 'All',
  active: 'Active',
  attention: 'Needs attention',
  deleted: 'Deleted',
};

/**
 * Whether a project belongs to a facet.
 *
 * "Needs attention" is *disabled or deleted* — the two states that stop a project being
 * usable — which is why a deleted project is counted by two chips rather than one. That is
 * deliberate and matches the mockup's counts: the chips narrow the list, they do not
 * partition it.
 *
 * @param project The row.
 * @param facet The chip.
 * @returns True when the chip should keep this row.
 */
export function matchesProjectFacet(project: Project, facet: ProjectFacet): boolean {
  switch (facet) {
    case 'active':
      return project.enabled && !project.deleted_at;
    case 'attention':
      return !project.enabled || Boolean(project.deleted_at);
    case 'deleted':
      return Boolean(project.deleted_at);
    case 'all':
    default:
      return true;
  }
}

/**
 * The free-text filter behind the toolbar's search box.
 *
 * Matches the name, the slug and the description — the three things a reader can see on a
 * card — plus the OpenAPI summary, because that is what the card actually prints when a
 * project has one.
 *
 * @param projects The rows.
 * @param query What was typed. Blank returns the input unchanged.
 * @returns The rows that match, in their original order.
 */
export function searchProjects<T extends Project>(
  projects: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...projects];
  return projects.filter((project) =>
    [project.name, project.slug ?? '', project.description ?? '', project.metadata?.summary ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}

/**
 * How many rows each chip would leave.
 *
 * Counted over the *searched* set, so the chips describe what pressing them would actually
 * show rather than the unfiltered total.
 *
 * @param projects The rows the search left.
 * @returns One count per facet.
 */
export function projectFacetCounts(
  projects: readonly Project[]
): Readonly<Record<ProjectFacet, number>> {
  return {
    all: projects.length,
    active: projects.filter((p) => matchesProjectFacet(p, 'active')).length,
    attention: projects.filter((p) => matchesProjectFacet(p, 'attention')).length,
    deleted: projects.filter((p) => matchesProjectFacet(p, 'deleted')).length,
  };
}

// ---------------------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------------------

/** What a project's three orbs and its trend cell have to draw. */
export interface ProjectScores {
  /** Versions the server summary counted. */
  versionsCount: number;
  /** True when there are none — the "Empty project" case, which never shows a score. */
  isEmpty: boolean;
  /** The overall quality score, 0–100, or `null` when nothing has scored it. */
  quality: number | null;
  /** The A–F letter the Lint orb prints, or `null` when there is no score behind it. */
  grade: string | null;
  /** The browser-local trend, oldest first — empty when this browser has never imported. */
  history: readonly ProjectQualitySnapshot[];
}

/**
 * The one derivation both views use.
 *
 * Three rules, in this order, and the reason each exists:
 *
 * 1. **An empty project has no score at all.** A project with no versions cannot have a
 *    mean quality across them, and stale browser-local history from before its last version
 *    was deleted would otherwise light the orbs for a project that has nothing in it.
 * 2. **Browser-local history wins.** It is the newest measurement — it is written the moment
 *    an import finishes — and it is the series the trend and the sparkline are drawn from.
 *    Preferring the server's mean would make the number disagree with the shape beside it.
 * 3. **The server's version-summary score is the fallback.** An import made from the CLI, or
 *    in another browser, still has a score; it just is not in `localStorage` here.
 *
 * The letter follows the same ladder, and is derived from the score when the snapshot did
 * not keep one — so the Lint orb and the Quality orb can never describe different numbers.
 *
 * @param project The row.
 * @param history This project's browser-local snapshots, oldest first.
 * @returns The figures both views print. See {@link ProjectScores}.
 */
export function projectScores(
  project: Project,
  history: readonly ProjectQualitySnapshot[] = []
): ProjectScores {
  const versionsCount = typeof project.versionsCount === 'number' ? project.versionsCount : 0;
  const isEmpty = versionsCount === 0;

  if (isEmpty) {
    return { versionsCount, isEmpty, quality: null, grade: null, history: [] };
  }

  const latest = history.length > 0 ? history[history.length - 1] : null;
  const serverScore = typeof project.qualityScore === 'number' ? project.qualityScore : null;
  const quality = latest ? latest.overall : serverScore;

  const grade = latest
    ? (latest.grade ?? letterGradeFromOverallPercent(latest.overall))
    : (project.qualityGrade?.trim() ||
      (quality != null ? letterGradeFromOverallPercent(quality) : null));

  return { versionsCount, isEmpty, quality, grade: grade || null, history };
}

/**
 * The latest quality score of every project, for sorting and for the header average.
 *
 * @param projects The rows.
 * @param historyById Every project's browser-local snapshots.
 * @returns One score (or `null`) per project id.
 */
export function latestQualityByProject(
  projects: readonly Project[],
  historyById: ProjectQualityHistoryMap
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const project of projects) {
    out[project.id] = projectScores(project, historyById[project.id] ?? []).quality;
  }
  return out;
}

/** The line under the page title: `4 projects · avg quality 84 · 3 active · 1 deleted`. */
export function projectsSummaryLine(
  projects: readonly Project[],
  latestQuality: ProjectQualityMap,
  showDeleted: boolean
): string {
  const total = projects.length;
  const scored = projects
    .map((project) => latestQuality[project.id])
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  const parts: string[] = [`${total} ${total === 1 ? 'project' : 'projects'}`];
  if (scored.length > 0) {
    parts.push(
      `avg quality ${Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length)}`
    );
  }
  parts.push(`${projects.filter((p) => matchesProjectFacet(p, 'active')).length} active`);
  // Only when the switch is on: a deleted count on a list that is not showing deleted
  // projects names rows the reader cannot see, and cannot act on.
  if (showDeleted) {
    const deleted = projects.filter((p) => p.deleted_at).length;
    if (deleted > 0) parts.push(`${deleted} deleted`);
  }
  return parts.join(' · ');
}

/**
 * The short, stable id the card and the row print beside the slug.
 *
 * Six hex characters of the uuid, as `build/projects.html` prints them (`prj_8f2a1c`). It is
 * a *label*, never an identifier to look anything up by — the uuid is what the API takes.
 *
 * @param id The project's uuid.
 * @returns `prj_` plus the first six characters with the dashes removed.
 */
export function projectShortId(id: string): string {
  return `prj_${id.replace(/-/g, '').slice(0, 6)}`;
}

/** `6 versions`, `1 version`, `0 versions`. */
export function projectVersionsLabel(count: number): string {
  return `${count} ${count === 1 ? 'version' : 'versions'}`;
}

/**
 * The two-line blurb on a card.
 *
 * The OpenAPI summary first — it is the one line the spec itself says the API is for — then
 * the project description, then a statement that there is neither. Never an empty paragraph:
 * the card's body has a minimum height so a grid of cards keeps its rhythm, and an empty one
 * would read as a rendering fault.
 */
export function projectSummaryText(project: Project): string {
  return (
    project.metadata?.summary?.trim() || project.description?.trim() || 'No description yet.'
  );
}

/** The domain-category pill's text, or `undefined` when the project has no category. */
export function projectDomainLabel(project: Project): string | undefined {
  return getProjectDomainCategoryLabel(project.metadata?.domainCategory);
}

// ---------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------

/** One entry of the toolbar's sort menu. */
export interface ProjectSortOption {
  /** The comparator this option runs. */
  id: ProjectsDashboardSortColumn;
  /** What the menu row says. */
  label: string;
}

/**
 * The sort menu, in the order it lists.
 *
 * Seven of the eight are also table columns, so the menu and the column headers are two ways
 * into the same state. `created` is the eighth: the mockup's table drops the Created column
 * (Updated is the one a reader scans) but sorting a portfolio by age is worth keeping, and a
 * menu row costs nothing.
 */
export const PROJECT_SORT_OPTIONS: readonly ProjectSortOption[] = [
  { id: 'name', label: 'Name' },
  { id: 'description', label: 'Description' },
  { id: 'quality', label: 'Quality' },
  { id: 'versions', label: 'Versions' },
  { id: 'status', label: 'Status' },
  { id: 'creator', label: 'Created by' },
  { id: 'created', label: 'Created' },
  { id: 'updated', label: 'Updated' },
] as const;

/** The sort a fresh page starts on — the mockup's `Sorted by name ↑`. */
export const DEFAULT_PROJECT_SORT: DataTableSortState = { column: 'name', direction: 'asc' };

/** Whether a string names a sortable project column. */
export function isProjectSortColumn(id: string): id is ProjectsDashboardSortColumn {
  return PROJECT_SORT_OPTIONS.some((option) => option.id === id);
}

/**
 * `DataTable`'s sort state as the comparator's pair.
 *
 * `DataTable` speaks `{column, direction}` over arbitrary column ids and allows `null` for
 * "unsorted"; the comparators speak a closed union. This is the only place the two meet, so
 * a column id that is not sortable — or a cleared sort — falls back to the default rather
 * than reaching a comparator that has no case for it.
 *
 * @param sort The table's state, or `null`.
 * @returns The column and direction to compare by.
 */
export function projectSortKey(sort: DataTableSortState | null | undefined): {
  column: ProjectsDashboardSortColumn;
  direction: ProjectsDashboardSortDirection;
} {
  if (!sort || !isProjectSortColumn(sort.column)) {
    return {
      column: DEFAULT_PROJECT_SORT.column as ProjectsDashboardSortColumn,
      direction: DEFAULT_PROJECT_SORT.direction,
    };
  }
  return { column: sort.column, direction: sort.direction };
}

/**
 * Order the rows.
 *
 * @param projects The rows the search and the chip left.
 * @param sort The table's sort state.
 * @param latestQuality Every project's latest score, for the `quality` comparator.
 * @returns A new, sorted array.
 */
export function sortProjects<T extends Project>(
  projects: readonly T[],
  sort: DataTableSortState | null | undefined,
  latestQuality: ProjectQualityMap
): T[] {
  const { column, direction } = projectSortKey(sort);
  return sortProjectsDashboardRows(projects, column, direction, latestQuality);
}

/** `name ↑` — the phrase the toolbar button and the table foot both end with. */
export function projectSortLabel(sort: DataTableSortState | null | undefined): string {
  const { column, direction } = projectSortKey(sort);
  const option = PROJECT_SORT_OPTIONS.find((entry) => entry.id === column);
  return `${(option?.label ?? column).toLowerCase()} ${direction === 'asc' ? '↑' : '↓'}`;
}

/** The table foot: `4 projects · sorted by name ↑`. */
export function projectsFootLabel(
  count: number,
  sort: DataTableSortState | null | undefined
): string {
  return `${count} ${count === 1 ? 'project' : 'projects'} · sorted by ${projectSortLabel(sort)}`;
}

// ---------------------------------------------------------------------------------------
// Destructive confirms
// ---------------------------------------------------------------------------------------

/**
 * Soft delete — reversible, so no gate.
 *
 * DESIGN.md §8 reserves type-to-confirm for what cannot be undone; a soft delete says how to
 * get the project back instead, which is the more useful sentence.
 */
export function softDeleteProjectConfirm(project: Project): DestructiveConfirmOptions {
  return destructiveConfirm({
    action: 'Delete',
    noun: 'project',
    name: project.name,
    consequence:
      'The project is hidden from lists and pickers. Turn on "Show deleted" to undelete it.',
  });
}

/**
 * Permanent delete — the one gate on this screen.
 *
 * What this replaces was **two** `window.confirm`s in a row, the second identical to the
 * first: a delay dressed as a check, which teaches a reader to click twice without reading.
 * It is one dialog now, gated on the project's **slug** — the mockup's field, and the right
 * phrase to ask for: a slug is unique within the workspace and is printed on the very card
 * the click came from, so the gate cannot be passed for the wrong project by a reader who is
 * looking at the right one. (Two projects may share a display name; two may not share a
 * slug.) A project with no slug falls back to its name rather than opening an ungated
 * confirm.
 */
export function permanentDeleteProjectConfirm(project: Project): DestructiveConfirmOptions {
  return destructiveConfirm({
    action: 'Permanently delete',
    noun: 'project',
    name: project.name,
    consequence:
      'Every version of this project, the publications made from them, and all its classes and properties are destroyed.',
    typeToConfirm: true,
    confirmLabel: 'Delete everything',
    confirmPhrase: project.slug?.trim() || project.name,
  });
}

/** Undelete — not destructive, but it changes what other pickers show, so it is confirmed. */
export function undeleteProjectConfirm(project: Project): {
  title: string;
  message: string;
  variant: 'info';
  confirmLabel: string;
  cancelLabel: string;
} {
  return {
    title: `Undelete project "${project.name}"?`,
    message:
      'It returns to lists and pickers with the enabled or disabled state it had before deletion.',
    variant: 'info',
    confirmLabel: 'Undelete project',
    cancelLabel: 'Cancel',
  };
}

// ---------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------

/** What a bulk action may do to the current selection. */
export interface ProjectBulkPlan {
  /** Selected rows that are live and can be soft-deleted. */
  deletable: Project[];
  /** Selected rows that are deleted and can be restored. */
  restorable: Project[];
}

/**
 * Split a selection into the two things a bulk action can do to it.
 *
 * The bulk bar offers Delete and Undelete at once because a selection can hold both kinds of
 * row, and hiding the verb that applies to *some* of the selection would leave the reader
 * clearing and re-selecting. Each button states its own count, so neither can be pressed
 * without knowing how many rows it reaches.
 *
 * @param projects Every row currently on screen.
 * @param selectedIds The ids the table reports as selected.
 * @returns The rows each verb applies to. See {@link ProjectBulkPlan}.
 */
export function projectBulkPlan(
  projects: readonly Project[],
  selectedIds: readonly string[]
): ProjectBulkPlan {
  const chosen = new Set(selectedIds);
  const selected = projects.filter((project) => chosen.has(project.id));
  return {
    deletable: selected.filter((project) => !project.deleted_at),
    restorable: selected.filter((project) => Boolean(project.deleted_at)),
  };
}

/**
 * What a bulk write says once it has finished.
 *
 * States the split rather than only the successes: "Deleted 3 of 5 projects" with the first
 * refusal named is the sentence a reader can act on, and a bare success count after a
 * partial failure reads as a complete success.
 *
 * @param verb Past tense, capitalised — `Deleted`, `Undeleted`.
 * @param applied How many writes succeeded.
 * @param total How many were attempted.
 * @param firstError The first failure's message, if any.
 * @returns The toast's text.
 */
export function bulkResultMessage(
  verb: string,
  applied: number,
  total: number,
  firstError?: string | null
): string {
  const noun = total === 1 ? 'project' : 'projects';
  if (applied === total) return `${verb} ${applied} ${noun}.`;
  const reason = firstError?.trim();
  return `${verb} ${applied} of ${total} ${noun} · ${total - applied} refused${
    reason ? ` — ${reason}` : ''
  }`;
}
