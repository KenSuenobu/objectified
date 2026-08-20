'use client';

import { useCallback, useMemo, useState } from 'react';
import type { BrowseFacetAxis, BrowseFacetSelection } from '../../../../lib/browseFacets';
import {
  NO_FACET_SELECTION,
  computeFacetOptions,
  describeFacetSelection,
  filterByFacets,
  formatLabel,
  hasFacetSelection,
  paradigmLabel,
  toggleFacet,
} from '../../../../lib/browseFacets';
import { AppShell } from '../../components/AppShell';
import { Breadcrumb } from '../../components/Breadcrumb';
import { DataTable } from '../../components/DataTable';
import { EntityHeader } from '../../components/EntityHeader';
import { FacetFilter, FacetValueChips } from '../../components/FacetFilter';
import { SpecCard } from '../../components/SpecCard';
import { sanitizeSearchInput, SAFE_SEARCH_HTML_PATTERN } from '../../utils/searchValidation';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_at?: string;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_at?: string;
  /**
   * Distinct paradigms across the project's published public versions, under the stored column's
   * name (MFI-6.1).
   */
  protocols?: string[] | null;
  /** Distinct source formats across the project's published public versions (MFI-6.1). */
  formats?: string[] | null;
}

interface TenantClientProps {
  tenant: Tenant;
  projects: Project[];
  tenantSlug: string;
}

type LayoutMode = 'grid' | 'table';
const LAYOUT_KEY = 'apiome-browse:tenant-layout';

function readLayoutPreference(): LayoutMode {
  if (typeof window === 'undefined') return 'grid';
  try {
    const saved = window.localStorage.getItem(LAYOUT_KEY);
    if (saved === 'grid' || saved === 'table') return saved;
  } catch {
    /* ignore */
  }
  return 'grid';
}

function monogram(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || name[0]?.toUpperCase() || '?';
}

/**
 * The paradigm/format chips a project card shows, so a visitor can see what a project *is* without
 * opening it — and recognise why it matched the active facet (MFI-6.1).
 */
function projectFacetMeta(project: Project): { label: string; value?: string }[] {
  const meta: { label: string; value?: string }[] = [];
  const protocols = project.protocols ?? [];
  const formats = project.formats ?? [];
  if (protocols.length > 0) {
    meta.push({ label: 'Paradigm', value: protocols.map(paradigmLabel).join(', ') });
  }
  if (formats.length > 0) {
    meta.push({ label: 'Format', value: formats.map(formatLabel).join(', ') });
  }
  return meta;
}

export function TenantClient({ tenant, projects, tenantSlug }: TenantClientProps) {
  const [layout, setLayout] = useState<LayoutMode>(readLayoutPreference);
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<BrowseFacetSelection>(NO_FACET_SELECTION);

  const updateLayout = (next: LayoutMode) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const onToggleFacet = useCallback((axis: BrowseFacetAxis, value: string) => {
    setFacets((current) => toggleFacet(current, axis, value));
  }, []);

  const onClearFacets = useCallback(() => setFacets(NO_FACET_SELECTION), []);

  // Text search first: the facet chips count what the current search left on screen, and the
  // counts ignore the facet selection itself so the row always shows what else can be picked.
  const searchedProjects = useMemo(() => {
    if (!query.trim()) return projects;
    const q = query.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q)
    );
  }, [projects, query]);

  const paradigmOptions = useMemo(
    () => computeFacetOptions(searchedProjects, 'paradigm'),
    [searchedProjects]
  );
  const formatOptions = useMemo(
    () => computeFacetOptions(searchedProjects, 'format'),
    [searchedProjects]
  );

  const filteredProjects = useMemo(
    () => filterByFacets(searchedProjects, facets),
    [searchedProjects, facets]
  );

  // The table view keeps its own search box, so it only takes the facet narrowing.
  const facetedProjects = useMemo(() => filterByFacets(projects, facets), [projects, facets]);

  const facetsActive = hasFacetSelection(facets);
  const emptyFilterSummary = [query.trim() ? `"${query.trim()}"` : '', describeFacetSelection(facets)]
    .filter(Boolean)
    .join(' · ');

  return (
    <AppShell containerSize="wide">
      <div className="space-y-8 py-8">
        <Breadcrumb items={[{ label: tenant.name }]} />

        <EntityHeader
          variant="tenant"
          title={tenant.name}
          subtitle={`/${tenant.slug}`}
          description={tenant.description}
          monogram={monogram(tenant.name)}
          meta={[
            { label: 'Projects', value: projects.length },
            {
              label: 'Joined',
              value: tenant.created_at
                ? new Date(tenant.created_at).toLocaleDateString()
                : '—',
            },
            { label: 'Visibility', value: 'Public' },
          ]}
        />

        <section className="space-y-4">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                Projects
              </h2>
              <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">
                {facetsActive
                  ? `${facetedProjects.length} of ${projects.length} project${
                      projects.length === 1 ? '' : 's'
                    } match the selected paradigm/format.`
                  : `${projects.length} project${
                      projects.length === 1 ? '' : 's'
                    } with at least one published version.`}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {projects.length > 0 && (
                <div className="relative max-w-xs">
                  <svg
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
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
                    pattern={SAFE_SEARCH_HTML_PATTERN}
                    placeholder="Filter projects..."
                    className="h-9 w-64 rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm text-zinc-900 placeholder-zinc-400 shadow-xs transition-colors focus-visible:border-[var(--brand)] focus-visible:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
                  />
                </div>
              )}
              <div
                role="tablist"
                aria-label="Layout"
                className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-0.5 shadow-xs dark:border-zinc-800 dark:bg-zinc-900"
              >
                <LayoutToggle
                  active={layout === 'grid'}
                  onClick={() => updateLayout('grid')}
                  label="Grid view"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h4v6H4V6zm10-2h4a2 2 0 012 2v4h-6V4zm-4 10v6H6a2 2 0 01-2-2v-4h6zm4 0h6v4a2 2 0 01-2 2h-4v-6z" />
                  </svg>
                </LayoutToggle>
                <LayoutToggle
                  active={layout === 'table'}
                  onClick={() => updateLayout('table')}
                  label="Table view"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </LayoutToggle>
              </div>
            </div>
          </header>

          {projects.length > 0 && (
            <FacetFilter
              paradigmOptions={paradigmOptions}
              formatOptions={formatOptions}
              selection={facets}
              onToggle={onToggleFacet}
              onClear={onClearFacets}
              entityLabel="projects"
            />
          )}

          {projects.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-300 bg-white/40 p-10 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                No projects with published versions available.
              </p>
            </div>
          ) : layout === 'grid' ? (
            filteredProjects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 bg-white/40 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-500">
                No projects match {emptyFilterSummary || 'the current filters'}.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredProjects.map((p) => (
                  <SpecCard
                    key={p.id}
                    variant="project"
                    href={`/tenant/${tenantSlug}/${p.slug}`}
                    title={p.name}
                    subtitle={`/${p.slug}`}
                    description={p.description}
                    meta={[
                      ...projectFacetMeta(p),
                      ...(p.created_at
                        ? [
                            {
                              label: 'Created',
                              value: new Date(p.created_at).toLocaleDateString(),
                            },
                          ]
                        : []),
                    ]}
                  />
                ))}
              </div>
            )
          ) : (
            <DataTable
              data={facetedProjects}
              keyField="id"
              getRowHref={(project) => `/tenant/${tenantSlug}/${project.slug}`}
              searchable={true}
              searchPlaceholder="Search projects..."
              searchFields={['name', 'slug', 'description']}
              emptyMessage={
                facetsActive
                  ? 'No projects match the selected paradigm/format.'
                  : 'No projects with published versions available.'
              }
              columns={[
                {
                  key: 'name',
                  header: 'Project',
                  sortable: true,
                  render: (project) => (
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500/15 to-blue-500/5 text-blue-700 ring-1 ring-inset ring-blue-500/30 dark:text-blue-300">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-900 group-hover:text-[var(--brand)] dark:text-zinc-50">
                          {project.name}
                        </div>
                        <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          /{project.slug}
                        </div>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'description',
                  header: 'Description',
                  render: (project) => (
                    <span className="line-clamp-2 text-zinc-600 dark:text-zinc-400">
                      {project.description || '—'}
                    </span>
                  ),
                },
                {
                  key: 'protocols',
                  header: 'Paradigm / Format',
                  width: 'w-48',
                  render: (project) => (
                    <FacetValueChips protocols={project.protocols} formats={project.formats} />
                  ),
                },
                {
                  key: 'created_at',
                  header: 'Created',
                  width: 'w-32',
                  sortable: true,
                  render: (project) => (
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {project.created_at
                        ? new Date(project.created_at).toLocaleDateString()
                        : '—'}
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
          )}
        </section>
      </div>
    </AppShell>
  );
}

function LayoutToggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
        active
          ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50'
          : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-50'
      }`}
    >
      {children}
    </button>
  );
}
