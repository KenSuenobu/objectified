'use client';

/**
 * The repository wire contract, shared by every repository screen.
 *
 * After HIVE-7.5 (#5322) this file draws nothing at all: what is left is the payload parser,
 * the types it produces, the polling constants and the three pure rules every repository
 * screen reads — the importable split, the initials and the last-scan phrase.
 *
 * The list screen's own card, index snapshot, provider badge and status palette moved to
 * `components/ade/repositories/*` in HIVE-7.3 (#5320); the Add-repository screen's
 * `SourceOptionCard`, `LinkedAccountIcon` and `ManageLinkedAccountsLink` went the same way in
 * HIVE-7.4 (#5321); and `RepositoryKpiCard`, the last component here, was retired by HIVE-7.5
 * when the detail screen's strip moved onto `ui/metrics`'s `StatGrid`. There is no `'use
 * client'`-only code left in it, and no colour named anywhere.
 */

import { type RepositoryHealth, parseRepositoryHealth } from './repositoryHealth';

export type RepositoryProvider = 'github' | 'gitlab' | 'bitbucket' | 'public_url';
export type RepositoryStatus = 'pending' | 'scanning' | 'ready' | 'error' | 'archived';

/** Refresh repository list/detail while registration or scan is still in progress. */
export const REPOSITORY_STATUS_POLL_MS = 2_000;

export function repositoryStatusNeedsPolling(status: RepositoryStatus | undefined): boolean {
  return status === 'pending' || status === 'scanning';
}

/** One finished (or failed) scan line when `GET …/repositories/{id}` exposes `recent_scans`. */
export type RecentRepositoryScanRow = {
  branch: string;
  /** ISO timestamp shown in the list (e.g. job finished_at). */
  finished_at: string;
  failed: boolean;
};

export interface DashboardRepository {
  id: string;
  name: string;
  full_name: string;
  description?: string | null;
  provider: RepositoryProvider;
  default_branch: string;
  visibility?: 'public' | 'private';
  status: RepositoryStatus;
  last_scanned_at?: string | null;
  /** Scan job history for the Recent scans list; omitted or empty until REST exposes it. */
  recent_scans?: RecentRepositoryScanRow[];
  total_files?: number | null;
  importable_count?: number | null;
  /** Git remote branches (GitHub list-branches at registration); null if unknown. */
  branch_count?: number | null;
  /** Per-repo auto-refresh opt-out (RAR-3.3). True (default) = sweep may refresh this repo. */
  auto_refresh_enabled?: boolean;
  /**
   * At-a-glance health badge (REPO-6.5). Null when the API returned none — an older
   * payload, or a repository whose health signals could not be read — in which case no
   * badge is rendered rather than a guessed one.
   */
  health?: RepositoryHealth | null;
  clone_url?: string | null;
  source?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function normalizeProvider(p: unknown): RepositoryProvider {
  const s = String(p ?? '').toLowerCase();
  if (s === 'gitlab') return 'gitlab';
  if (s === 'bitbucket') return 'bitbucket';
  if (s === 'public_url' || s === 'publicurl') return 'public_url';
  return 'github';
}

function normalizeStatus(s: unknown): RepositoryStatus {
  const v = String(s ?? '').toLowerCase();
  if (v === 'pending') return 'pending';
  if (v === 'scanning') return 'scanning';
  if (v === 'error') return 'error';
  if (v === 'archived') return 'archived';
  return 'ready';
}

function parseRecentScansFromApi(v: unknown): RecentRepositoryScanRow[] {
  if (!Array.isArray(v) || v.length === 0) return [];
  const out: RecentRepositoryScanRow[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const branch = String(r.branch ?? r.ref ?? r.default_branch ?? '').trim() || 'main';
    const rawAt = r.finished_at ?? r.completed_at ?? r.ended_at ?? r.created_at ?? r.started_at;
    if (rawAt == null) continue;
    const iso = String(rawAt).trim();
    if (!iso) continue;
    const st = String(r.status ?? r.outcome ?? '').toLowerCase();
    const failed = st === 'failed' || st === 'error';
    out.push({ branch, finished_at: iso, failed });
  }
  return out;
}

/** Parse a repository object from the REST / Next API (list or detail). */
export function dashboardRepositoryFromApi(x: unknown): DashboardRepository | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const id = String(o.id ?? '');
  if (!id) return null;
  const vis = o.visibility;
  const visibility =
    vis === 'private' ? 'private' : vis === 'public' ? 'public' : undefined;
  return {
    id,
    name: String(o.name ?? o.full_name ?? 'Repository'),
    full_name: String(o.full_name ?? o.clone_url ?? o.name ?? ''),
    description: o.description != null ? String(o.description) : null,
    provider: normalizeProvider(o.provider),
    default_branch: String(o.default_branch ?? 'main'),
    visibility,
    status: normalizeStatus(o.status),
    last_scanned_at: (() => {
      const v = o.last_scanned_at ?? (o as { lastScannedAt?: unknown }).lastScannedAt;
      if (v == null) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    })(),
    recent_scans: parseRecentScansFromApi(o.recent_scans),
    total_files: typeof o.total_files === 'number' ? o.total_files : null,
    importable_count: typeof o.importable_count === 'number' ? o.importable_count : null,
    branch_count: typeof o.branch_count === 'number' ? o.branch_count : null,
    // Default-on: a repo whose API payload omits the flag (older row) reads as enabled.
    auto_refresh_enabled: (() => {
      const v = o.auto_refresh_enabled ?? (o as { autoRefreshEnabled?: unknown }).autoRefreshEnabled;
      return v == null ? true : Boolean(v);
    })(),
    health: parseRepositoryHealth(o.health),
    clone_url: o.clone_url != null ? String(o.clone_url) : null,
    source: o.source != null ? String(o.source) : null,
    created_at: o.created_at != null ? String(o.created_at) : null,
    updated_at: o.updated_at != null ? String(o.updated_at) : null,
  };
}

export function dashboardRepositoriesFromListPayload(data: unknown): DashboardRepository[] {
  if (!data || typeof data !== 'object') return [];
  const raw = (data as { repositories?: unknown }).repositories;
  if (!Array.isArray(raw)) return [];
  return raw.map(dashboardRepositoryFromApi).filter((r): r is DashboardRepository => r != null);
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export type EstimatedImportableMix = {
  openapi: number;
  arazzo: number;
  jsonSchema: number;
};

/**
 * Deterministic split of a repo's `importable_count` into UI kinds until the API returns
 * real per-kind tallies. The three counts always sum to `importable_count` (or all zero).
 */
export function estimatedImportableMixForRepo(
  importableCount: number | null | undefined,
  repositoryId: string,
): EstimatedImportableMix {
  const T =
    typeof importableCount === 'number' && importableCount > 0
      ? Math.floor(importableCount)
      : 0;
  if (T === 0) return { openapi: 0, arazzo: 0, jsonSchema: 0 };
  const h = hashSeed(repositoryId);
  const w0 = 300 + (h % 700);
  const w1 = 200 + ((h >> 10) % 600);
  const w2 = 400 + ((h >> 20) % 500);
  const s = w0 + w1 + w2;
  const openapi = Math.floor((T * w0) / s);
  const arazzo = Math.floor((T * w1) / s);
  const jsonSchema = T - openapi - arazzo;
  return { openapi, arazzo, jsonSchema };
}

export function aggregateEstimatedImportableMix(
  repos: DashboardRepository[],
): EstimatedImportableMix & { total: number } {
  let openapi = 0;
  let arazzo = 0;
  let jsonSchema = 0;
  let total = 0;
  for (const r of repos) {
    const t = r.importable_count ?? 0;
    total += t;
    const m = estimatedImportableMixForRepo(r.importable_count, r.id);
    openapi += m.openapi;
    arazzo += m.arazzo;
    jsonSchema += m.jsonSchema;
  }
  return { openapi, arazzo, jsonSchema, total };
}

/*
 * `formatEstimatedImportableMixInline` and `RepositoryKpiCard` were here until
 * HIVE-7.5 (#5322).
 *
 * The card was a bordered `border-gray-200 bg-white … dark:border-gray-700 dark:bg-gray-800`
 * tile whose figure took a caller-supplied `valueClassName` — in practice `text-indigo-600
 * dark:text-indigo-400` when a value was known and `text-gray-400 dark:text-gray-500` when it
 * was not, which made a figure's *colour* the only signal that it was a placeholder. Both of
 * its call sites are gone: HIVE-7.3 moved the list page's strip onto `ui/metrics`'s `StatGrid`
 * and this ticket moved the detail page's, where an unmeasured figure carries `data-unwired`
 * and a footnote that says so in words.
 *
 * `formatEstimatedImportableMixInline` rendered the split as one sentence for that card's
 * tooltip; `repositoryDetailKpis` composes its own now.
 *
 * `estimatedImportableMixForRepo` and `aggregateEstimatedImportableMix` above are unchanged —
 * they are the rule, not the paint, and both screens still read them.
 */

export function repoInitials(name: string): string {
  const parts = name.replace(/[/_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  const compact = name.replace(/[^a-zA-Z0-9]/g, '');
  return compact.slice(0, 2).toUpperCase() || 'R';
}

export function formatLastScan(
  iso: string | null | undefined,
  failed: boolean,
  now: number = Date.now(),
): string {
  if (failed) return 'Scan failed';
  if (!iso) return 'Never scanned';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = now - then;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
