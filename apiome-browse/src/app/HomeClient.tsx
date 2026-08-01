'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { BrowseFacetAxis, BrowseFacetSelection } from '../../lib/browseFacets';
import {
  NO_FACET_SELECTION,
  computeFacetOptions,
  describeFacetSelection,
  filterByFacets,
  hasFacetSelection,
  toggleFacet,
} from '../../lib/browseFacets';
import { AppShell } from './components/AppShell';
import { DataTable } from './components/DataTable';
import { DiscoveryRail } from './components/DiscoveryRail';
import { FacetFilter, FacetValueChips } from './components/FacetFilter';
import { SpecCard } from './components/SpecCard';
import { sanitizeSearchInput } from './utils/searchValidation';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_at?: string;
  /** Distinct protocols this organization publishes (MFI-6.1). */
  protocols?: string[] | null;
  /** Distinct source formats this organization publishes (MFI-6.1). */
  formats?: string[] | null;
}

interface RecentVersion {
  id: string;
  version_id: string;
  description?: string;
  published_at?: string;
  project_name: string;
  project_slug: string;
  project_description?: string;
  tenant_name: string;
  tenant_slug: string;
}

interface PopularProject {
  id: string;
  name: string;
  slug: string;
  description?: string;
  tenant_name: string;
  tenant_slug: string;
  version_count: number;
  latest_published_at?: string;
}

interface HomeClientProps {
  tenants: Tenant[];
  recentVersions: RecentVersion[];
  popularProjects: PopularProject[];
  newestTenants: Tenant[];
}

function relativeTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

function monogram(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || name[0]?.toUpperCase() || '?';
}

export function HomeClient({
  tenants,
  recentVersions,
  popularProjects,
  newestTenants,
}: HomeClientProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<BrowseFacetSelection>(NO_FACET_SELECTION);

  const onToggleFacet = useCallback((axis: BrowseFacetAxis, value: string) => {
    setFacets((current) => toggleFacet(current, axis, value));
  }, []);

  const onClearFacets = useCallback(() => setFacets(NO_FACET_SELECTION), []);

  // Counts are over the whole directory and ignore the current selection, so the chip row always
  // shows what else is available to pick (the same contract the /v1/browse API's facets have).
  const protocolOptions = useMemo(() => computeFacetOptions(tenants, 'protocol'), [tenants]);
  const formatOptions = useMemo(() => computeFacetOptions(tenants, 'format'), [tenants]);
  const filteredTenants = useMemo(() => filterByFacets(tenants, facets), [tenants, facets]);
  const facetsActive = hasFacetSelection(facets);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
    else router.push('/search');
  };

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-zinc-200/80 bg-gradient-to-b from-white to-zinc-50 py-12 sm:py-16 dark:border-zinc-800/80 dark:from-zinc-950 dark:to-zinc-950/40">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-72 bg-[radial-gradient(ellipse_at_top_left,rgba(16,128,208,0.10),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(242,196,28,0.10),transparent_55%)] dark:bg-[radial-gradient(ellipse_at_top_left,rgba(46,151,221,0.16),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(242,196,28,0.09),transparent_55%)]"
        />
        <div aria-hidden="true" className="pointer-events-none absolute -left-10 top-8 -z-0 hidden lg:block">
          <div className="hex h-40 w-36 rotate-6 bg-gradient-to-br from-sky-500/15 to-sky-500/0 dark:from-sky-400/15" />
          <div className="hex -mt-10 ml-24 h-24 w-[5.5rem] -rotate-3 bg-gradient-to-br from-amber-400/25 to-amber-400/0 dark:from-amber-400/15" />
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute -right-8 bottom-4 -z-0 hidden lg:block">
          <div className="hex h-36 w-32 -rotate-6 bg-gradient-to-tl from-blue-700/15 to-blue-700/0 dark:from-blue-400/10" />
          <div className="hex -mt-24 -ml-16 h-20 w-[4.5rem] rotate-12 bg-gradient-to-br from-amber-400/20 to-amber-400/0 dark:from-amber-400/10" />
        </div>
        <AppShell>
          <div className="relative mx-auto max-w-3xl text-center">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-200/80 bg-white/80 px-3 py-1 text-[12px] font-medium text-zinc-600 shadow-xs backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-900/60 dark:text-zinc-400">
              <span aria-hidden="true" className="hex inline-block h-2 w-2 bg-[var(--gold)]"></span>
              Public API specification directory
            </div>
            <h1 className="text-balance text-[2rem] font-semibold tracking-tight text-zinc-900 sm:text-[2.5rem] dark:text-zinc-50">
              Discover, browse, and compare{' '}
              <span className="bg-gradient-to-r from-[var(--brand-navy)] via-[#1080d0] to-[var(--brand)] bg-clip-text text-transparent dark:from-sky-300 dark:via-sky-400 dark:to-sky-500">
                public API specifications
              </span>
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-pretty text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              An always-current directory of OpenAPI, Arazzo, and JSON Schema documents published by
              organizations on Apiome.
            </p>

            <form onSubmit={onSubmit} className="mx-auto mt-7 flex max-w-2xl items-center gap-2">
              <div className="relative flex-1">
                <svg
                  className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-zinc-400"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(sanitizeSearchInput(e.target.value))}
                  placeholder="Search paths, schemas, projects, organizations…"
              className="h-12 w-full rounded-xl border border-zinc-200 bg-white pl-12 pr-4 text-[15px] text-zinc-900 placeholder-zinc-400 shadow-sm transition-colors focus-visible:border-[var(--brand)] focus-visible:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
                />
              </div>
              <button
                type="submit"
                className="h-12 shrink-0 rounded-xl bg-[var(--brand)] px-5 text-[14px] font-medium text-white transition-colors hover:bg-[var(--brand-hover)]"
              >
                Search
              </button>
            </form>
          </div>
        </AppShell>
      </section>

      {/* Discovery rails */}
      <AppShell containerSize="wide">
        <div className="space-y-10 py-10">
          <DiscoveryRail
            title="Recently published"
            description="Latest version updates across the directory."
            seeAllHref="/search"
            itemCount={recentVersions.length}
            emptyMessage="No versions have been published yet."
          >
            {recentVersions.map((v) => (
              <div key={v.id} className="w-[300px] shrink-0">
                <SpecCard
                  variant="version"
                  href={`/tenant/${v.tenant_slug}/${v.project_slug}/${v.version_id}`}
                  title={`v${v.version_id}`}
                  subtitle={v.project_name}
                  description={v.description || v.project_description || `Published by ${v.tenant_name}`}
                  badge={
                    relativeTime(v.published_at)
                      ? { label: relativeTime(v.published_at) as string, tone: 'success' }
                      : undefined
                  }
                  meta={[{ label: v.tenant_name }, { label: v.project_name }]}
                />
              </div>
            ))}
          </DiscoveryRail>

          <DiscoveryRail
            title="Most active projects"
            description="Projects with the largest published version history."
            seeAllHref="#organizations"
            seeAllLabel="Browse all"
            itemCount={popularProjects.length}
            emptyMessage="No projects to highlight yet."
          >
            {popularProjects.map((p) => (
              <div key={p.id} className="w-[300px] shrink-0">
                <SpecCard
                  variant="project"
                  href={`/tenant/${p.tenant_slug}/${p.slug}`}
                  title={p.name}
                  subtitle={p.tenant_name}
                  description={p.description}
                  badge={{
                    label: `${p.version_count} ${p.version_count === 1 ? 'version' : 'versions'}`,
                    tone: 'brand',
                  }}
                  meta={
                    p.latest_published_at
                      ? [{ label: 'Updated', value: relativeTime(p.latest_published_at) }]
                      : undefined
                  }
                />
              </div>
            ))}
          </DiscoveryRail>

          <DiscoveryRail
            title="New organizations"
            description="The most recently onboarded publishers."
            seeAllHref="#organizations"
            seeAllLabel="Browse all"
            itemCount={newestTenants.length}
            emptyMessage="No organizations yet."
          >
            {newestTenants.map((t) => (
              <div key={t.id} className="w-[280px] shrink-0">
                <SpecCard
                  variant="tenant"
                  href={`/tenant/${t.slug}`}
                  title={t.name}
                  subtitle={`/${t.slug}`}
                  description={t.description}
                  monogram={monogram(t.name)}
                  meta={
                    t.created_at
                      ? [{ label: 'Joined', value: relativeTime(t.created_at) }]
                      : undefined
                  }
                />
              </div>
            ))}
          </DiscoveryRail>

          {/* Organization directory */}
          <section id="organizations" className="scroll-mt-20 space-y-4 pt-4">
            <header className="flex flex-wrap items-end justify-between gap-3 border-t border-zinc-200/80 pt-8 dark:border-zinc-800/80">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                  All organizations
                </h2>
                <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">
                  {facetsActive
                    ? `${filteredTenants.length} of ${tenants.length} organization${
                        tenants.length === 1 ? '' : 's'
                      } publish ${describeFacetSelection(facets)}.`
                    : `${tenants.length} organization${
                        tenants.length === 1 ? '' : 's'
                      } with at least one published public specification.`}
                </p>
              </div>
            </header>

            <FacetFilter
              protocolOptions={protocolOptions}
              formatOptions={formatOptions}
              selection={facets}
              onToggle={onToggleFacet}
              onClear={onClearFacets}
              entityLabel="organizations"
            />

            <DataTable
              data={filteredTenants}
              keyField="id"
              getRowHref={(tenant) => `/tenant/${tenant.slug}`}
              searchable={true}
              searchPlaceholder="Filter organizations..."
              searchFields={['name', 'slug', 'description']}
              emptyMessage={
                facetsActive
                  ? 'No organizations publish the selected protocol/format.'
                  : 'No organizations with published specifications available.'
              }
              columns={[
                {
                  key: 'name',
                  header: 'Organization',
                  sortable: true,
                  render: (tenant) => (
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-sky-500/15 to-sky-500/5 text-[12px] font-semibold text-sky-700 ring-1 ring-inset ring-sky-500/30 dark:text-sky-300">
                        {monogram(tenant.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-900 group-hover:text-[var(--brand)] dark:text-zinc-50">
                          {tenant.name}
                        </div>
                        <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          /{tenant.slug}
                        </div>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'description',
                  header: 'Description',
                  render: (tenant) => (
                    <span className="line-clamp-2 text-zinc-600 dark:text-zinc-400">
                      {tenant.description || '—'}
                    </span>
                  ),
                },
                {
                  key: 'protocols',
                  header: 'Publishes',
                  width: 'w-48',
                  render: (tenant) => (
                    <FacetValueChips protocols={tenant.protocols} formats={tenant.formats} />
                  ),
                },
                {
                  key: 'created_at',
                  header: 'Joined',
                  width: 'w-32',
                  sortable: true,
                  render: (tenant) => (
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {tenant.created_at ? new Date(tenant.created_at).toLocaleDateString() : '—'}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  width: 'w-12',
                  render: () => (
                    <svg
                      className="h-4 w-4 text-zinc-400 transition-colors group-hover:text-[var(--brand)]"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  ),
                },
              ]}
            />
          </section>
        </div>
      </AppShell>
    </>
  );
}
