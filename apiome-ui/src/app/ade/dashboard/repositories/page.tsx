"use client";

import { useAuthSession } from '@lib/auth/session-client';
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  FolderGit2,
  LayoutGrid,
  Library,
  List,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Button, buttonVariants } from "@/app/components/ui/Button";
import { Input } from "@/app/components/ui/Input";
import { LoadingState } from "@/app/components/ui/LoadingState";
import { EmptyState } from "@/app/components/ui/EmptyState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/Select";
import { toast } from "sonner";
import { cn } from "@lib/utils";
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from "@/app/components/ade/dashboard/dashboardScreenClasses";
import {
  type DashboardRepository,
  ProviderBadge,
  RepositoryCard,
  RepositoryKpiCard,
  RepositoryIndexSnapshot,
  dashboardRepositoriesFromListPayload,
  formatLastScan,
  REPOSITORY_STATUS_POLL_MS,
  repoInitials,
  repositoryStatusClass,
  repositoryStatusLabel,
  repositoryStatusNeedsPolling,
} from "@/app/components/ade/dashboard/repositories/repositoryStoreUi";
import { RepositoryRowMenu } from "@/app/components/ade/dashboard/repositories/RepositoryRowMenu";
import { RepositoryHealthBadge } from "@/app/components/ade/dashboard/repositories/RepositoryHealthBadge";
import { RepositoryRefreshActivityCard } from "@/app/components/ade/dashboard/repositories/RepositoryRefreshActivityCard";

const VIEW_STORAGE = "apiome-dashboard-repositories-view";

export default function RepositoriesPage() {
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })
    ?.current_tenant_id;

  const [repos, setRepos] = useState<DashboardRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [visibilityFilter, setVisibilityFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<string>("scanned");
  const [view, setView] = useState<"grid" | "list">(() => {
    if (typeof window === "undefined") return "grid";
    return window.localStorage.getItem(VIEW_STORAGE) === "list"
      ? "list"
      : "grid";
  });

  const persistView = useCallback((v: "grid" | "list") => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_STORAGE, v);
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!currentTenantId) {
      setRepos([]);
      if (!silent) setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/repositories", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : res.statusText,
        );
      }
      setRepos(dashboardRepositoriesFromListPayload(data));
    } catch (e) {
      console.error(e);
      if (!silent) {
        setRepos([]);
        toast.error("Could not load repositories.");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentTenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const anyPendingOrScanning = useMemo(
    () => repos.some((r) => repositoryStatusNeedsPolling(r.status)),
    [repos],
  );

  useEffect(() => {
    if (!currentTenantId || !anyPendingOrScanning) return;
    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, REPOSITORY_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [currentTenantId, anyPendingOrScanning, load]);

  const filtered = useMemo(() => {
    let list = repos.slice();
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.full_name.toLowerCase().includes(q) ||
          r.default_branch.toLowerCase().includes(q),
      );
    }
    if (providerFilter !== "all") {
      list = list.filter((r) => r.provider === providerFilter);
    }
    if (visibilityFilter === "public") {
      list = list.filter(
        (r) => r.provider === "public_url" || r.visibility === "public",
      );
    } else if (visibilityFilter === "private") {
      list = list.filter((r) => r.provider !== "public_url");
    }
    if (sortKey === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      list.sort((a, b) => {
        const ta = a.last_scanned_at
          ? new Date(a.last_scanned_at).getTime()
          : 0;
        const tb = b.last_scanned_at
          ? new Date(b.last_scanned_at).getTime()
          : 0;
        return tb - ta;
      });
    }
    return list;
  }, [repos, search, providerFilter, visibilityFilter, sortKey]);

  const kpis = useMemo(() => {
    const byProvider = {
      github: 0,
      gitlab: 0,
      bitbucket: 0,
      public_url: 0 as number,
    };
    let files = 0;
    let lastScanMs = 0;
    for (const r of repos) {
      byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
      files += r.total_files ?? 0;
      if (r.last_scanned_at) {
        const t = new Date(r.last_scanned_at).getTime();
        if (!Number.isNaN(t)) lastScanMs = Math.max(lastScanMs, t);
      }
    }
    const providerBits = [
      byProvider.github ? `${byProvider.github} GitHub` : null,
      byProvider.gitlab ? `${byProvider.gitlab} GitLab` : null,
      byProvider.bitbucket ? `${byProvider.bitbucket} Bitbucket` : null,
      byProvider.public_url ? `${byProvider.public_url} public URL` : null,
    ].filter(Boolean);
    const hasErrors = repos.some((r) => r.status === "error");
    const lastScanTitle =
      lastScanMs > 0
        ? formatLastScan(new Date(lastScanMs).toISOString(), false)
        : "—";
    const lastScanSub =
      repos.length === 0
        ? "No scans yet"
        : lastScanMs > 0
          ? `${hasErrors ? "Some repos need attention" : "All repos healthy"}`
          : "No scans yet";
    return {
      count: repos.length,
      providerSubtitle: providerBits.length ? providerBits.join(" · ") : "—",
      files,
      lastScanTitle,
      lastScanSub,
    };
  }, [repos]);

  if (!currentTenantId) {
    return (
      <div className={cn(dashboardMainClass, "max-w-3xl")}>
        <div className="rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50 to-yellow-50 p-8 dark:border-amber-700/50 dark:from-amber-900/20 dark:to-yellow-900/20">
          <h2 className="mb-2 text-xl font-bold text-amber-900 dark:text-amber-100">
            No tenant selected
          </h2>
          <p className="mb-4 text-amber-800 dark:text-amber-200">
            Select a tenant to manage repositories.
          </p>
          <Link href="/ade/dashboard/tenants" className={cn(buttonVariants())}>
            Go to Tenants
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
                <FolderGit2
                  className="h-6 w-6 text-indigo-600 dark:text-indigo-400"
                  aria-hidden
                />
                Repositories
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Browse repositories registered to this workspace and pick one to
                explore its files.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {/* REPO-6.4: the tenant-wide view of what all these repositories contain. */}
              <Link
                href="/ade/dashboard/repositories/catalog"
                className={cn(
                  buttonVariants({ variant: "secondary" }),
                  "h-auto min-h-10 shrink-0 whitespace-nowrap py-2",
                )}
                title="Search every discovered spec across all repositories"
              >
                <Library className="h-4 w-4 shrink-0" aria-hidden />
                Spec catalog
              </Link>
              {/* REPO-7.3: what the polling quota and the scanner have actually been doing. */}
              <Link
                href="/ade/dashboard/repositories/telemetry"
                className={cn(
                  buttonVariants({ variant: "secondary" }),
                  "h-auto min-h-10 shrink-0 whitespace-nowrap py-2",
                )}
                title="Polling quota usage, deferrals and scan volume over the last week"
              >
                <Activity className="h-4 w-4 shrink-0" aria-hidden />
                Quota &amp; limits
              </Link>
              {/* REPO-7.6: which source addresses may deliver webhooks here at all. */}
              <Link
                href="/ade/dashboard/repositories/webhook-ip-allowlist"
                className={cn(
                  buttonVariants({ variant: "secondary" }),
                  "h-auto min-h-10 shrink-0 whitespace-nowrap py-2",
                )}
                title="Provider IP ranges and this workspace's own allowlist for webhook delivery"
              >
                <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
                Webhook IPs
              </Link>
              <Button
                type="button"
                variant="secondary"
                className="h-auto min-h-10 shrink-0 whitespace-nowrap py-2"
                onClick={() =>
                  toast.message(
                    "Rescan all repositories will run when scan jobs are wired to the API.",
                  )
                }
                title="Runs when scan jobs are wired to the API"
              >
                <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                Rescan all
              </Button>
              <Link
                href="/ade/dashboard/repositories/new"
                className={cn(
                  buttonVariants(),
                  "h-auto min-h-10 shrink-0 whitespace-nowrap py-2",
                )}
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden />
                Add repository
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className={dashboardMainClass} aria-busy={loading}>
        <div className={dashboardContentStackClass}>
          <div className="border-b border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-2 lg:grid-cols-4">
              <RepositoryKpiCard
                label="Repositories"
                value={kpis.count.toLocaleString()}
                subtitle={kpis.providerSubtitle}
              />
              <RepositoryKpiCard
                label="Files indexed"
                value={kpis.files.toLocaleString()}
                subtitle="Sum of `total_files` from scan results across repos (0 until indexing runs)."
              />
              <RepositoryKpiCard
                label="Imports (30d)"
                value="—"
                subtitle="Needs import-event aggregation per tenant + repo (API not wired yet)."
              />
              <RepositoryKpiCard
                label="Last scan"
                value={kpis.lastScanTitle}
                subtitle={kpis.lastScanSub}
                valueClassName={
                  kpis.lastScanTitle === "—"
                    ? "text-gray-400 dark:text-gray-500"
                    : undefined
                }
              />
            </div>
            {/* RAR-5.5: tenant-wide auto-refresh health with drill-in per repo. */}
            <div className="mt-4">
              <RepositoryRefreshActivityCard />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="relative min-w-[260px] max-w-md flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, owner, or URL…"
                className="bg-gray-50 pl-9 dark:bg-gray-900/50"
              />
            </div>
            <Select value={providerFilter} onValueChange={setProviderFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All providers</SelectItem>
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="gitlab">GitLab</SelectItem>
                <SelectItem value="bitbucket">Bitbucket</SelectItem>
                <SelectItem value="public_url">Public URL</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={visibilityFilter}
              onValueChange={setVisibilityFilter}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Visibility" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All visibilities</SelectItem>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="private">
                  Private (linked account)
                </SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortKey} onValueChange={setSortKey}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="scanned">Sort: Recently scanned</SelectItem>
                <SelectItem value="name">Sort: Name</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => persistView("grid")}
                className={cn(
                  "inline-flex items-center gap-1 px-3 py-2 text-sm",
                  view === "grid"
                    ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300"
                    : "text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700",
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
                Grid
              </button>
              <button
                type="button"
                onClick={() => persistView("list")}
                className={cn(
                  "inline-flex items-center gap-1 px-3 py-2 text-sm",
                  view === "list"
                    ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300"
                    : "text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700",
                )}
              >
                <List className="h-3.5 w-3.5" aria-hidden />
                List
              </button>
            </div>
          </div>

          <div className="px-6 pb-8 pt-2">
            {loading ? (
              <div className={dashboardTableWrapClass}>
                <LoadingState
                  minHeightClassName="min-h-[220px]"
                  message="Loading repositories…"
                />
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                className="mt-6"
                icon={
                  <FolderGit2 className="h-10 w-10 text-white" aria-hidden />
                }
                title={
                  repos.length === 0 ? "No repositories yet" : "No matches"
                }
                description={
                  repos.length === 0
                    ? "Register a Git repository through a linked account or a public clone URL. After the API is enabled, scans and file indexing appear here."
                    : "Try adjusting search or filters."
                }
                action={
                  repos.length === 0 ? (
                    <Link
                      href="/ade/dashboard/repositories/new"
                      className={cn(
                        buttonVariants({ size: "sm" }),
                        "h-auto min-h-9 shrink-0 whitespace-nowrap py-2",
                      )}
                    >
                      Add repository
                    </Link>
                  ) : undefined
                }
              />
            ) : view === "grid" ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {filtered.map((repo, i) => (
                  <RepositoryCard
                    key={repo.id}
                    repo={repo}
                    index={i}
                    detailHref={`/ade/dashboard/repositories/${repo.id}/preview`}
                    onRemoved={() => void load()}
                  />
                ))}
              </div>
            ) : (
              <div className={dashboardTableWrapClass}>
                <table className="w-full text-sm">
                  <thead className={dashboardTableTheadClass}>
                    <tr>
                      <th className={cn(dashboardThClass, "align-middle")}>Repository</th>
                      <th className={cn(dashboardThClass, "align-middle")}>Provider</th>
                      <th className={cn(dashboardThClass, "align-middle")}>Branch</th>
                      <th className={cn(dashboardThRightClass, "align-middle")}>Files</th>
                      <th className={cn(dashboardThClass, "align-middle")}>Health</th>
                      <th className={cn(dashboardThClass, "align-middle")}>Status</th>
                      <th className={cn(dashboardThClass, "align-middle")}>Last scan</th>
                      <th className={cn(dashboardThClass, "align-middle")}>Importable</th>
                      <th className={cn(dashboardThRightClass, "pr-6 align-middle")}>
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className={dashboardTbodyClass}>
                    {filtered.map((repo, i) => (
                      <tr key={repo.id} className={dashboardTrHoverClass}>
                        <td className="px-6 py-3 align-middle">
                          <Link
                            href={`/ade/dashboard/repositories/${repo.id}/preview`}
                            className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none ring-indigo-500/40 focus-visible:ring-2"
                          >
                            <span
                              className={cn(
                                "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-gradient-to-br font-mono text-[10px] font-bold text-white",
                                i % 6 === 0
                                  ? "from-emerald-500 to-teal-500"
                                  : i % 6 === 1
                                    ? "from-indigo-500 to-purple-500"
                                    : i % 6 === 2
                                      ? "from-purple-500 to-pink-500"
                                      : i % 6 === 3
                                        ? "from-amber-500 to-orange-500"
                                        : i % 6 === 4
                                          ? "from-rose-500 to-pink-500"
                                          : "from-cyan-500 to-blue-500",
                              )}
                            >
                              {repoInitials(repo.name)}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-gray-900 hover:text-indigo-600 dark:text-gray-100 dark:hover:text-indigo-300">
                                {repo.name}
                              </span>
                              <span className="block truncate font-mono text-[10px] text-gray-500 dark:text-gray-400">
                                {repo.full_name}
                              </span>
                            </span>
                          </Link>
                        </td>
                        <td className="px-6 py-3 align-middle">
                          <ProviderBadge provider={repo.provider} />
                        </td>
                        <td className="px-6 py-3 align-middle font-mono text-xs">
                          {repo.default_branch}
                        </td>
                        <td className="px-6 py-3 align-middle text-right font-mono text-xs">
                          {(repo.total_files ?? 0).toLocaleString()}
                        </td>
                        <td className="px-6 py-3 align-middle">
                          {repo.health ? (
                            <RepositoryHealthBadge health={repo.health} />
                          ) : (
                            <span className="text-xs text-gray-400 dark:text-gray-500">
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3 align-middle">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                              repositoryStatusClass(repo.status),
                            )}
                          >
                            {repo.status === "scanning" ? (
                              <Loader2
                                className="h-3 w-3 shrink-0 animate-spin"
                                aria-hidden
                              />
                            ) : null}
                            {repositoryStatusLabel(repo.status)}
                          </span>
                        </td>
                        <td className="px-6 py-3 align-middle text-xs text-gray-500 dark:text-gray-400">
                          {formatLastScan(
                            repo.last_scanned_at,
                            repo.status === "error",
                          )}
                        </td>
                        <td className="px-6 py-3 align-middle">
                          <RepositoryIndexSnapshot repo={repo} />
                        </td>
                        <td className="px-6 py-3 align-middle text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Link
                              href={`/ade/dashboard/repositories/${repo.id}/preview`}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                            >
                              Detail{" "}
                              <ArrowRight className="h-3 w-3" aria-hidden />
                            </Link>
                            <RepositoryRowMenu
                              repositoryId={repo.id}
                              label={repo.name}
                              onRemoved={() => void load()}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <span>
                    Showing {filtered.length} of {repos.length} repositories
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
