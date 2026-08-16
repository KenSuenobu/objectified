'use client';

import dynamic from 'next/dynamic';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCode2,
  LayoutList,
  Loader2,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/app/components/ui/Button';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { cn } from '@lib/utils';
import {
  extractRepositoryFileDetailTables,
  formatMetadataCell,
  getRepositoryFileImportableVerdict,
  parseRepositoryFileSpecMetadata,
  type RepositoryFileDetailClassRow,
  type RepositoryFileDetailPathRow,
  type RepositoryFileDetailPropertyRow,
  type RepositoryFileDetailTables,
} from '@lib/repository-file-spec-metadata';
import { analyzeSpecification, type AnalysisResult } from '@/app/utils/openapi-analyzer';
import { RepositoryFileSpecRelationshipFlow } from '@/app/components/ade/dashboard/repositories/RepositoryFileSpecRelationshipFlow';
import type { RepositoryFileStagedImportTarget } from '@/app/components/ade/dashboard/repositories/repositoryFileStagedImport';
import { CODE_BLOCK_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

/** Indexed file row from the repository files list API (subset used by file detail). */
export type RepositoryFileDetailRow = {
  id: string;
  path: string;
  name: string;
  ext?: string | null;
  size_bytes?: number | null;
  blob_sha?: string | null;
  detected_kind?: string | null;
  display_kind: string;
  confidence: string;
};

type FileContentApi = {
  success?: boolean;
  path: string;
  branch: string;
  display_kind: string;
  confidence: string;
  blob_sha?: string | null;
  size_bytes?: number | null;
  content: string;
  truncated?: boolean;
  error?: string;
};

const REPOSITORY_FILE_OVERSIZED_MESSAGE = 'The contents of this file is too large';

const REPOSITORY_FILE_UNRECOGNIZED_FORMAT_BLURB =
  'This file format is not recognized, you are viewing the raw file data.';

function fetchErrorIndicatesOversizedBody(message: string | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('too large') ||
    m.includes('request entity too large') ||
    m.includes('payload too large') ||
    m.includes('413')
  );
}

type FileViewTab = 'source' | 'diff' | 'visualize' | 'details';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[min(520px,70vh)] items-center justify-center bg-gray-50 text-sm text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
      Loading editor…
    </div>
  ),
});

/** Monaco `language` id derived from path (extension + well-known basenames). */
function monacoLanguageFromRepositoryPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const base = trimmed.split('/').pop() ?? trimmed;
  const lower = base.toLowerCase();

  if (lower === 'dockerfile' || lower.endsWith('/dockerfile')) return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile' || lower.endsWith('/makefile')) return 'makefile';
  if (lower === 'jenkinsfile' || lower.endsWith('/jenkinsfile')) return 'plaintext';
  if (lower.endsWith('.graphql') || lower.endsWith('.gql')) return 'graphql';

  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';

  switch (ext) {
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'json':
    case 'avsc':
      return 'json';
    case 'sql':
    case 'ddl':
      return 'sql';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'xml':
      return 'xml';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'less':
      return 'less';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascriptreact';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'toml':
      return 'ini';
    case 'ini':
    case 'cfg':
    case 'conf':
      return 'ini';
    case 'properties':
      return 'ini';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'rb':
      return 'ruby';
    case 'php':
      return 'php';
    case 'cs':
      return 'csharp';
    case 'proto':
      return 'plaintext';
    case 'prisma':
      return 'sql';
    default:
      if (lower.endsWith('schema.prisma')) return 'sql';
      return 'plaintext';
  }
}

function formatBytes(n: number | null | undefined): string {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Line count for the string shown in the editor (LF-based; empty buffer counts as one line). */
function countDisplayLines(content: string): number {
  if (content.length === 0) return 1;
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  return n;
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  const s = sha.trim();
  return s.length > 7 ? s.slice(0, 7) : s;
}

function githubBlobHref(base: string | null, branch: string, path: string): string | null {
  if (!base) return null;
  const trimmed = base.replace(/\.git\/?$/i, '').replace(/\/$/, '');
  if (!trimmed.includes('github.com')) return null;
  const encPath = path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  return `${trimmed}/blob/${encodeURIComponent(branch)}/${encPath}`;
}

function kindPillClass(displayKind: string): string {
  const k = displayKind.toLowerCase();
  if (k.includes('openapi')) {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  }
  if (k.includes('arazzo')) {
    return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300';
  }
  if (k.includes('asyncapi')) {
    return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
  }
  if (k.includes('json schema')) {
    return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300';
  }
  if (k.includes('graphql')) {
    return 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300';
  }
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
}

function tabBtnClass(active: boolean): string {
  return cn(
    'px-3 py-1.5 text-xs transition-colors',
    active
      ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300'
      : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700'
  );
}

function formatDetailFormatLabel(format: RepositoryFileDetailTables['format']): string {
  switch (format) {
    case 'openapi':
      return 'OpenAPI';
    case 'swagger2':
      return 'Swagger 2.0';
    case 'asyncapi':
      return 'AsyncAPI';
    case 'arazzo':
      return 'Arazzo';
    case 'json_schema':
      return 'JSON Schema';
    case 'graphql':
      return 'GraphQL SDL';
    default:
      return 'Unknown';
  }
}

const detailTableTh =
  'whitespace-nowrap px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400';
const detailTableTd = 'px-3 py-3 align-top text-sm text-gray-800 dark:text-gray-200';
const detailTableTdMono = cn(detailTableTd, 'font-mono text-sm leading-snug');

/** Caps table body height when many rows; short tables stay only as tall as their content. */
const detailSectionBodyScroll = 'max-h-[min(40vh,440px)] overflow-auto';

type DetailSortDir = 'asc' | 'desc';

type DetailColumnSort = { key: string; dir: DetailSortDir };

function compareDetailStrings(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: DetailSortDir
): number {
  const cmp = (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base', numeric: true });
  return dir === 'asc' ? cmp : -cmp;
}

/** Null / undefined numeric values sort after finite numbers. */
function compareDetailNumbers(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: DetailSortDir
): number {
  const na = a != null && Number.isFinite(a) ? a : null;
  const nb = b != null && Number.isFinite(b) ? b : null;
  if (na == null && nb == null) return 0;
  if (na == null) return 1;
  if (nb == null) return -1;
  const cmp = na - nb;
  return dir === 'asc' ? cmp : -cmp;
}

function propertyRequiredSortKey(required: boolean | undefined): string {
  if (required === true) return '1';
  if (required === false) return '2';
  return '3';
}

function SortableDetailTh({
  label,
  sortKey,
  active,
  onSort,
}: {
  label: string;
  sortKey: string;
  active: DetailColumnSort;
  onSort: (key: string) => void;
}) {
  const isActive = active.key === sortKey;
  const ariaSort = isActive ? (active.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th className={detailTableTh} scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="-mx-1 inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-gray-200/90 dark:hover:bg-gray-600/60"
      >
        <span>{label}</span>
        {isActive ? (
          active.dir === 'asc' ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-35" aria-hidden />
        )}
      </button>
    </th>
  );
}

function cycleDetailSort(prev: DetailColumnSort, key: string): DetailColumnSort {
  if (prev.key === key) {
    return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { key, dir: 'asc' };
}

function sortClassRows(rows: RepositoryFileDetailClassRow[], sort: DetailColumnSort): RepositoryFileDetailClassRow[] {
  const next = [...rows];
  const { key, dir } = sort;
  next.sort((a, b) => {
    let c = 0;
    switch (key) {
      case 'name':
        c = compareDetailStrings(a.name, b.name, dir);
        break;
      case 'kind':
        c = compareDetailStrings(a.kind, b.kind, dir);
        break;
      case 'typeSummary':
        c = compareDetailStrings(a.typeSummary, b.typeSummary, dir);
        break;
      case 'propertiesCount':
        c = compareDetailNumbers(a.propertiesCount, b.propertiesCount, dir);
        break;
      case 'description':
        c = compareDetailStrings(a.description, b.description, dir);
        break;
      default:
        c = compareDetailStrings(a.name, b.name, 'asc');
    }
    if (c !== 0) return c;
    return compareDetailStrings(a.name, b.name, 'asc');
  });
  return next;
}

function sortPropertyRows(
  rows: RepositoryFileDetailPropertyRow[],
  sort: DetailColumnSort
): RepositoryFileDetailPropertyRow[] {
  const next = [...rows];
  const { key, dir } = sort;
  next.sort((a, b) => {
    let c = 0;
    switch (key) {
      case 'name':
        c = compareDetailStrings(a.name, b.name, dir);
        break;
      case 'context':
        c = compareDetailStrings(a.context, b.context, dir);
        break;
      case 'typeOrConstraint':
        c = compareDetailStrings(a.typeOrConstraint, b.typeOrConstraint, dir);
        break;
      case 'required':
        c = compareDetailStrings(propertyRequiredSortKey(a.required), propertyRequiredSortKey(b.required), dir);
        break;
      case 'format':
        c = compareDetailStrings(a.format, b.format, dir);
        break;
      case 'defaultValue':
        c = compareDetailStrings(a.defaultValue, b.defaultValue, dir);
        break;
      case 'description':
        c = compareDetailStrings(a.description, b.description, dir);
        break;
      default:
        c = compareDetailStrings(a.name, b.name, 'asc');
    }
    if (c !== 0) return c;
    return compareDetailStrings(a.context, b.context, 'asc') || compareDetailStrings(a.name, b.name, 'asc');
  });
  return next;
}

function sortPathRows(rows: RepositoryFileDetailPathRow[], sort: DetailColumnSort): RepositoryFileDetailPathRow[] {
  const next = [...rows];
  const { key, dir } = sort;
  next.sort((a, b) => {
    let c = 0;
    switch (key) {
      case 'template':
        c = compareDetailStrings(a.template, b.template, dir);
        break;
      case 'method':
        c = compareDetailStrings(a.method, b.method, dir);
        break;
      case 'operationId':
        c = compareDetailStrings(a.operationId, b.operationId, dir);
        break;
      case 'summary':
        c = compareDetailStrings(a.summary, b.summary, dir);
        break;
      case 'description':
        c = compareDetailStrings(a.description, b.description, dir);
        break;
      case 'tags':
        c = compareDetailStrings(a.tags, b.tags, dir);
        break;
      default:
        c = compareDetailStrings(a.template, b.template, 'asc');
    }
    if (c !== 0) return c;
    return (
      compareDetailStrings(a.template, b.template, 'asc') ||
      compareDetailStrings(a.method ?? '', b.method ?? '', 'asc')
    );
  });
  return next;
}

function RepositorySpecDetailTables({ tables }: { tables: RepositoryFileDetailTables }) {
  const [classSort, setClassSort] = useState<DetailColumnSort>({ key: 'name', dir: 'asc' });
  const [propertySort, setPropertySort] = useState<DetailColumnSort>({ key: 'name', dir: 'asc' });
  const [pathSort, setPathSort] = useState<DetailColumnSort>({ key: 'template', dir: 'asc' });

  const sortedClasses = useMemo(
    () => sortClassRows(tables.classes, classSort),
    [tables.classes, classSort]
  );
  const sortedProperties = useMemo(
    () => sortPropertyRows(tables.properties, propertySort),
    [tables.properties, propertySort]
  );
  const sortedPaths = useMemo(() => sortPathRows(tables.paths, pathSort), [tables.paths, pathSort]);

  const emptyCopy =
    tables.format === 'unknown'
      ? 'Parse this file as a supported spec (OpenAPI, AsyncAPI, GraphQL SDL, JSON Schema, …) to populate structured rows.'
      : 'Nothing to list for this section in the current document.';

  return (
    <div className="flex max-h-[min(92vh,960px)] flex-col gap-3 overflow-y-auto bg-gradient-to-b from-gray-50/95 to-white px-4 pb-4 pt-3 dark:from-gray-950/50 dark:to-gray-900/50">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-3 dark:border-gray-700">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Specification structure</p>
          <p className="mt-1 max-w-[62rem] text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            Types and reusable components, schema fields, and routable surfaces (HTTP paths, Async channels, GraphQL
            operations, or workflows). Each block scrolls independently; tables also scroll horizontally when needed.
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold',
            tables.format === 'unknown'
              ? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
              : 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200'
          )}
        >
          {formatDetailFormatLabel(tables.format)}
        </span>
      </div>

      {tables.parseError ? (
        <p className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-100">
          Details tables need valid YAML or JSON. {tables.parseError}
        </p>
      ) : null}

      <div className="flex min-w-0 flex-col gap-3">
        <section className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900/70">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/90">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Classes</h4>
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {tables.classes.length.toLocaleString()} row{tables.classes.length === 1 ? '' : 's'}
              {tables.truncated.classes ? ' · truncated' : ''}
            </span>
          </header>
          <div className={detailSectionBodyScroll}>
            {tables.classes.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{emptyCopy}</p>
            ) : (
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-100 shadow-[0_1px_0_rgba(0,0,0,0.06)] dark:border-gray-700 dark:bg-gray-800">
                  <tr>
                    <SortableDetailTh
                      label="Name"
                      sortKey="name"
                      active={classSort}
                      onSort={(k) => setClassSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Kind"
                      sortKey="kind"
                      active={classSort}
                      onSort={(k) => setClassSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Schema type"
                      sortKey="typeSummary"
                      active={classSort}
                      onSort={(k) => setClassSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Properties"
                      sortKey="propertiesCount"
                      active={classSort}
                      onSort={(k) => setClassSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Description"
                      sortKey="description"
                      active={classSort}
                      onSort={(k) => setClassSort((p) => cycleDetailSort(p, k))}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {sortedClasses.map((row, i) => (
                    <tr key={`${row.name}-${row.kind}-${i}`} className="hover:bg-gray-50/90 dark:hover:bg-gray-800/50">
                      <td className={cn(detailTableTdMono, 'font-semibold text-gray-950 dark:text-gray-50')}>
                        {row.name}
                      </td>
                      <td className={detailTableTdMono}>{row.kind}</td>
                      <td className={detailTableTdMono}>{row.typeSummary ?? '—'}</td>
                      <td className={detailTableTdMono}>
                        {row.propertiesCount != null ? row.propertiesCount.toLocaleString() : '—'}
                      </td>
                      <td className={cn(detailTableTd, 'max-w-md whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300')}>
                        {row.description ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900/70">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/90">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Properties</h4>
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {tables.properties.length.toLocaleString()} row{tables.properties.length === 1 ? '' : 's'}
              {tables.truncated.properties ? ' · truncated' : ''}
            </span>
          </header>
          <div className={detailSectionBodyScroll}>
            {tables.properties.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{emptyCopy}</p>
            ) : (
              <table className="w-full min-w-[960px] border-collapse text-left">
                <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-100 shadow-[0_1px_0_rgba(0,0,0,0.06)] dark:border-gray-700 dark:bg-gray-800">
                  <tr>
                    <SortableDetailTh
                      label="Name"
                      sortKey="name"
                      active={propertySort}
                      onSort={(k) => setPropertySort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Context"
                      sortKey="context"
                      active={propertySort}
                      onSort={(k) => setPropertySort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Type"
                      sortKey="typeOrConstraint"
                      active={propertySort}
                      onSort={(k) => setPropertySort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Required"
                      sortKey="required"
                      active={propertySort}
                      onSort={(k) => setPropertySort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Format"
                      sortKey="format"
                      active={propertySort}
                      onSort={(k) => setPropertySort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Default"
                      sortKey="defaultValue"
                      active={propertySort}
                      onSort={(k) => setPropertySort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Description"
                      sortKey="description"
                      active={propertySort}
                      onSort={(k) => setPropertySort((p) => cycleDetailSort(p, k))}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {sortedProperties.map((row, i) => (
                    <tr key={`${row.context}-${row.name}-${i}`} className="hover:bg-gray-50/90 dark:hover:bg-gray-800/50">
                      <td className={cn(detailTableTdMono, 'font-semibold text-gray-950 dark:text-gray-50')}>
                        {row.name}
                      </td>
                      <td className={cn(detailTableTdMono, 'text-indigo-800 dark:text-indigo-300')}>{row.context}</td>
                      <td className={cn(detailTableTdMono, 'max-w-[14rem] whitespace-pre-wrap break-all')}>
                        {row.typeOrConstraint ?? '—'}
                      </td>
                      <td className={detailTableTd}>{row.required === true ? 'Yes' : row.required === false ? 'No' : '—'}</td>
                      <td className={detailTableTdMono}>{row.format ?? '—'}</td>
                      <td className={cn(detailTableTdMono, 'max-w-[12rem] whitespace-pre-wrap break-all')}>
                        {row.defaultValue ?? '—'}
                      </td>
                      <td className={cn(detailTableTd, 'max-w-lg whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300')}>
                        {row.description ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900/70">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/90">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Paths &amp; operations</h4>
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
              {tables.paths.length.toLocaleString()} row{tables.paths.length === 1 ? '' : 's'}
              {tables.truncated.paths ? ' · truncated' : ''}
            </span>
          </header>
          <div className={detailSectionBodyScroll}>
            {tables.paths.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{emptyCopy}</p>
            ) : (
              <table className="w-full min-w-[960px] border-collapse text-left">
                <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-100 shadow-[0_1px_0_rgba(0,0,0,0.06)] dark:border-gray-700 dark:bg-gray-800">
                  <tr>
                    <SortableDetailTh
                      label="Location"
                      sortKey="template"
                      active={pathSort}
                      onSort={(k) => setPathSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Verb"
                      sortKey="method"
                      active={pathSort}
                      onSort={(k) => setPathSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Identifier"
                      sortKey="operationId"
                      active={pathSort}
                      onSort={(k) => setPathSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Summary"
                      sortKey="summary"
                      active={pathSort}
                      onSort={(k) => setPathSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Details"
                      sortKey="description"
                      active={pathSort}
                      onSort={(k) => setPathSort((p) => cycleDetailSort(p, k))}
                    />
                    <SortableDetailTh
                      label="Tags"
                      sortKey="tags"
                      active={pathSort}
                      onSort={(k) => setPathSort((p) => cycleDetailSort(p, k))}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {sortedPaths.map((row, i) => (
                    <tr
                      key={`${row.template}-${row.method}-${row.operationId ?? ''}-${i}`}
                      className="hover:bg-gray-50/90 dark:hover:bg-gray-800/50"
                    >
                      <td className={cn(detailTableTdMono, 'max-w-xs font-semibold text-gray-950 dark:text-gray-50')}>
                        <span className="break-all">{row.template}</span>
                      </td>
                      <td className={detailTableTdMono}>{row.method ?? '—'}</td>
                      <td className={cn(detailTableTdMono, 'max-w-[14rem] break-all')}>{row.operationId ?? '—'}</td>
                      <td className={cn(detailTableTd, 'max-w-xs whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300')}>
                        {row.summary ?? '—'}
                      </td>
                      <td className={cn(detailTableTd, 'max-w-xl whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300')}>
                        {row.description ?? '—'}
                      </td>
                      <td className={cn(detailTableTd, 'max-w-xs whitespace-pre-wrap break-words text-gray-600 dark:text-gray-400')}>
                        {row.tags ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MetadataCardSkeleton() {
  return (
    <div
      className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
      aria-hidden
    >
      <Skeleton className="mb-4 h-4 w-40" />
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex justify-between gap-3">
            <Skeleton className="h-3.5 w-20 shrink-0" />
            <Skeleton className="h-3.5 max-w-[55%] flex-1" />
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-2 border-t border-gray-100 pt-3 dark:border-gray-700">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-28" />
      </div>
    </div>
  );
}

function VerdictCardSkeleton() {
  return (
    <div
      className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
      aria-hidden
    >
      <Skeleton className="mb-3 h-4 w-36" />
      <Skeleton className="h-[4.5rem] w-full rounded-lg" />
      <div className="mt-3 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
    </div>
  );
}

function SuggestedTargetCardSkeleton() {
  return (
    <div
      className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
      aria-hidden
    >
      <Skeleton className="mb-3 h-4 w-36" />
      <Skeleton className="mb-2 h-3 w-full" />
      <Skeleton className="h-3 max-w-sm w-[80%]" />
    </div>
  );
}

function SourcePanelSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden>
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="hidden h-3 w-28 sm:block" />
      </div>
      <div className="h-[min(520px,70vh)] min-h-[240px] w-full p-2">
        <Skeleton className="h-full min-h-[220px] w-full rounded-sm" />
      </div>
    </div>
  );
}

export function RepositoryFileDetail({
  repositoryId,
  repositoryName,
  branch,
  file,
  githubWebBase,
  onBack,
  onMapImport,
  stagedImportTarget = null,
  onContinueStagedImport,
}: {
  repositoryId: string;
  repositoryName: string;
  branch: string;
  file: RepositoryFileDetailRow;
  githubWebBase: string | null;
  onBack: () => void;
  onMapImport: () => void;
  /** When set for this file/branch, show Ready to Import (returned from Map & import staging). */
  stagedImportTarget?: RepositoryFileStagedImportTarget | null;
  onContinueStagedImport?: () => void;
}) {
  const [tab, setTab] = useState<FileViewTab>('source');
  const [payload, setPayload] = useState<FileContentApi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [vizAnalysis, setVizAnalysis] = useState<AnalysisResult | null>(null);
  const [vizLoading, setVizLoading] = useState(false);
  const [vizError, setVizError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setIsDark(document.documentElement.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const monacoLanguage = useMemo(() => monacoLanguageFromRepositoryPath(file.path), [file.path]);

  const specMetadata = useMemo(
    () => parseRepositoryFileSpecMetadata(payload?.content ?? '', file.path),
    [payload?.content, file.path]
  );

  const detailTables = useMemo(
    () => extractRepositoryFileDetailTables(payload?.content ?? '', file.path),
    [payload?.content, file.path]
  );

  const importableVerdict = useMemo(
    () =>
      getRepositoryFileImportableVerdict(specMetadata, {
        loadError: error,
        truncated: payload?.truncated === true,
      }),
    [specMetadata, error, payload?.truncated]
  );

  const mapImportAllowed =
    !loading && !error && importableVerdict.status === 'importable';

  const mapImportBlockHint = useMemo(() => {
    if (loading) return null;
    if (error) return error;
    if (!payload) return null;
    if (importableVerdict.status === 'importable') return null;
    if (importableVerdict.notImportableMessage) return importableVerdict.notImportableMessage;
    if (importableVerdict.status === 'parse_failed') {
      return importableVerdict.parseError ?? 'Fix YAML/JSON syntax before this file can be validated for import.';
    }
    if (importableVerdict.status === 'content_unavailable') {
      return importableVerdict.loadError ?? 'Content unavailable.';
    }
    return 'Map & import is available only after the loaded file validates as OpenAPI 3.0 / 3.1 or another supported catalog format (AsyncAPI, Arazzo, JSON Schema, GraphQL SDL).';
  }, [loading, error, payload, importableVerdict]);

  const sourceOnlyLayout = !loading && importableVerdict.status !== 'importable';

  const showOversizedSourcePlaceholder =
    sourceOnlyLayout &&
    (Boolean(payload?.truncated) || fetchErrorIndicatesOversizedBody(error));

  const showUnrecognizedImportFormatBlurb = useMemo(() => {
    if (!sourceOnlyLayout || !payload || showOversizedSourcePlaceholder) return false;
    if (importableVerdict.status === 'not_importable' && importableVerdict.format === 'unknown') {
      return true;
    }
    if (
      importableVerdict.status === 'parse_failed' &&
      (importableVerdict.format == null || importableVerdict.format === 'unknown')
    ) {
      return true;
    }
    return false;
  }, [sourceOnlyLayout, payload, showOversizedSourcePlaceholder, importableVerdict]);

  useEffect(() => {
    if (sourceOnlyLayout) setTab('source');
  }, [sourceOnlyLayout]);

  const sourceViewStats = useMemo(() => {
    if (!payload) return null;
    return {
      lines: countDisplayLines(payload.content),
      sizeLabel: formatBytes(payload.size_bytes ?? file.size_bytes),
    };
  }, [payload, file.size_bytes]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/repositories/${encodeURIComponent(repositoryId)}/files/${encodeURIComponent(file.id)}/content`,
        { credentials: 'include' }
      );
      const json = (await res.json().catch(() => ({}))) as FileContentApi & { error?: string };
      if (!res.ok) {
        throw new Error(typeof json.error === 'string' ? json.error : res.statusText);
      }
      if (typeof json.content !== 'string') {
        throw new Error('Invalid response from server');
      }
      setPayload(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load file';
      setError(msg);
      setPayload(null);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [repositoryId, file.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading || sourceOnlyLayout) {
      setVizLoading(false);
      setVizAnalysis(null);
      setVizError(null);
      return;
    }
    const content = payload?.content;
    if (content == null || content === '') {
      setVizAnalysis(null);
      setVizError(null);
      setVizLoading(false);
      return;
    }
    let cancelled = false;
    setVizLoading(true);
    setVizError(null);
    void analyzeSpecification(content, file.path || file.name || 'spec.yaml')
      .then((r) => {
        if (cancelled) return;
        setVizAnalysis(r);
        if (!r.isValid && r.errors?.length) {
          setVizError(r.errors.map((e) => e.message).join(' '));
        } else {
          setVizError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setVizAnalysis(null);
          setVizError(e instanceof Error ? e.message : 'Analysis failed');
        }
      })
      .finally(() => {
        if (!cancelled) setVizLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, sourceOnlyLayout, payload?.content, file.path, file.name, file.id]);

  const blobUrl = githubBlobHref(githubWebBase, branch, file.path);
  const displayKind = payload?.display_kind ?? file.display_kind;
  const confLabel =
    (payload?.confidence ?? file.confidence).toLowerCase().includes('filename') ||
    (payload?.confidence ?? file.confidence).toLowerCase() === 'filename'
      ? 'filename'
      : payload?.confidence ?? file.confidence;

  const stagedImportApplies = useMemo(() => {
    if (!stagedImportTarget) return false;
    if (loading) return false;
    const currentBlob = payload?.blob_sha ?? file.blob_sha ?? null;
    const stagedBlob = stagedImportTarget.blobSha ?? null;
    return stagedBlob === currentBlob;
  }, [stagedImportTarget, loading, payload?.blob_sha, file.blob_sha]);

  const stagedImportSummary = useMemo(() => {
    if (!stagedImportTarget) return '';
    if (stagedImportTarget.targetMode === 'existing' && stagedImportTarget.existingProject) {
      const { name, slug } = stagedImportTarget.existingProject;
      return `Mapped to ${name} (${slug})`;
    }
    if (stagedImportTarget.targetMode === 'new' && stagedImportTarget.newProject) {
      const { name, slug } = stagedImportTarget.newProject;
      return `New project: ${name} (${slug})`;
    }
    return '';
  }, [stagedImportTarget]);

  return (
    <div className="space-y-6" aria-busy={loading}>
      <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-6 pb-5 pt-6 dark:border-gray-700">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400"
            >
              <ArrowLeft className="h-3 w-3 shrink-0" aria-hidden />
              Back to {repositoryName}
            </button>
            <span className="text-gray-300 dark:text-gray-600">·</span>
            <span className="break-all font-mono text-gray-600 dark:text-gray-300">{file.path}</span>
          </div>
          {stagedImportTarget && stagedImportApplies ? (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-900/25">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <CheckCircle2
                    className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">Ready to Import</p>
                    {stagedImportSummary ? (
                      <p className="mt-0.5 text-xs leading-relaxed text-emerald-800 dark:text-emerald-200/90">
                        {stagedImportSummary}. Open Map &amp; import to run the catalog import.
                      </p>
                    ) : null}
                  </div>
                </div>
                {onContinueStagedImport ? (
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0 gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                    onClick={onContinueStagedImport}
                  >
                    <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Map &amp; import
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-start gap-4">
            <span className="inline-flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white">
              <FileCode2 className="h-6 w-6" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="break-all font-mono text-xl font-bold text-gray-900 dark:text-gray-100">{file.path}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {!sourceOnlyLayout ? (
                  <>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-2xs font-semibold',
                        kindPillClass(displayKind)
                      )}
                    >
                      {displayKind}
                    </span>
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-2xs font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                      confidence: {confLabel}
                    </span>
                  </>
                ) : null}
                <span className="inline-flex flex-wrap items-center gap-x-1.5 font-mono text-2xs text-gray-500 dark:text-gray-400">
                  {loading ? (
                    <span className="inline-flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                      Loading file…
                    </span>
                  ) : (
                    <>
                      {formatBytes(payload?.size_bytes ?? file.size_bytes)} ·{' '}
                      {shortSha(payload?.blob_sha ?? file.blob_sha)} · branch{' '}
                      <span className="text-indigo-600 dark:text-indigo-400">{branch}</span>
                    </>
                  )}
                </span>
              </div>
            </div>
            {!sourceOnlyLayout ? (
              <Button
                type="button"
                size="sm"
                className="shrink-0 gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                onClick={onMapImport}
                disabled={!mapImportAllowed}
                title={!mapImportAllowed ? mapImportBlockHint ?? undefined : undefined}
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                Map &amp; import
              </Button>
            ) : null}
          </div>
          {!sourceOnlyLayout && mapImportBlockHint ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900/90 dark:text-amber-200/90">
                Map &amp; import unavailable
              </p>
              <p className="mt-1 text-xs leading-relaxed">{mapImportBlockHint}</p>
            </div>
          ) : null}
        </div>

        <div className={cn('grid grid-cols-1 gap-5 px-6 py-6', !sourceOnlyLayout && 'lg:grid-cols-3')}>
          {!sourceOnlyLayout ? (
          <div className="space-y-4 lg:col-span-1">
            {loading ? (
              <>
                <MetadataCardSkeleton />
                <VerdictCardSkeleton />
                <SuggestedTargetCardSkeleton />
              </>
            ) : null}
            {!loading ? (
              <>
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Detected metadata</h3>
              {payload?.truncated ? (
                <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
                  File body is truncated; counts below reflect only the loaded portion.
                </p>
              ) : null}
              {specMetadata.parseError && !loading && payload ? (
                <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
                  Could not parse as YAML/JSON: {specMetadata.parseError}
                </p>
              ) : null}
              {!loading && payload && specMetadata.format === 'unknown' && !specMetadata.parseError ? (
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  No recognised OpenAPI, Swagger, AsyncAPI, Arazzo, JSON Schema, or GraphQL SDL structure in this file.
                </p>
              ) : null}
              {!loading && payload && specMetadata.format !== 'unknown' ? (
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  Values derived from the loaded file (client-side parse). Index kind:{' '}
                  <span className="font-medium text-gray-700 dark:text-gray-300">{displayKind}</span>.
                </p>
              ) : null}
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-500">Spec</dt>
                  <dd className="max-w-[60%] text-right font-medium text-gray-900 dark:text-gray-100">
                    {specMetadata.spec ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-500">Title</dt>
                  <dd className="max-w-[60%] text-right font-medium text-gray-900 dark:text-gray-100">
                    {specMetadata.title ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-500">Version</dt>
                  <dd className="text-right font-mono text-xs text-gray-800 dark:text-gray-200">
                    {specMetadata.version ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-500">Endpoints</dt>
                  <dd className="text-right font-mono text-xs text-gray-800 dark:text-gray-200">
                    {formatMetadataCell(specMetadata.endpoints)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-500">Components</dt>
                  <dd className="text-right font-mono text-xs text-gray-800 dark:text-gray-200">
                    {formatMetadataCell(specMetadata.components)}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-500">Servers</dt>
                  <dd className="text-right font-mono text-xs text-gray-800 dark:text-gray-200">
                    {formatMetadataCell(specMetadata.servers)}
                  </dd>
                </div>
                <div className="border-t border-gray-100 pt-2 dark:border-gray-700">
                  <div className="flex justify-between gap-2 text-xs">
                    <dt className="text-gray-500">Path</dt>
                    <dd className="break-all text-right font-mono text-gray-600 dark:text-gray-400">{file.path}</dd>
                  </div>
                  <div className="mt-1 flex justify-between gap-2 text-xs">
                    <dt className="text-gray-500">Blob</dt>
                    <dd className="font-mono text-gray-600 dark:text-gray-400">
                      {shortSha(payload?.blob_sha ?? file.blob_sha)}
                    </dd>
                  </div>
                </div>
              </dl>
              {payload &&
              specMetadata.format !== 'unknown' &&
              specMetadata.components === 0 &&
              !specMetadata.parseError ? (
                <div
                  className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-950 dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-100"
                  data-testid="repository-file-zero-components-warning"
                >
                  <p className="font-semibold text-amber-900 dark:text-amber-200">No component definitions detected</p>
                  <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">
                    The loaded document has no reusable schemas or other named components in the usual buckets (for
                    example OpenAPI <span className="font-mono">components</span> or JSON Schema{' '}
                    <span className="font-mono">$defs</span>). Many importable files are effectively path-only or lightly
                    structured, so this summary can look sparse even when the file is fine. Import may still succeed and
                    need not produce a problematic project.
                  </p>
                </div>
              ) : null}
            </div>

            <div
              className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
              data-importable-verdict={JSON.stringify(importableVerdict)}
              data-testid="repository-file-importable-verdict"
            >
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Importable verdict</h3>
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-900/40">
                {importableVerdict.status === 'content_unavailable' ? (
                  <>
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      Content unavailable — cannot evaluate importability.
                    </p>
                    <p className="mt-1 font-mono text-xs text-rose-700 dark:text-rose-300">
                      {importableVerdict.loadError}
                    </p>
                  </>
                ) : null}
                {importableVerdict.status === 'parse_failed' ? (
                  <>
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      Not evaluable as YAML/JSON — fix syntax to detect an importable spec.
                    </p>
                    <p className="mt-1 font-mono text-xs text-amber-800 dark:text-amber-200">
                      {importableVerdict.parseError}
                    </p>
                  </>
                ) : null}
                {importableVerdict.status === 'not_importable' ? (
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {importableVerdict.notImportableMessage ??
                      'Not importable — loaded content does not match a supported specification shape (OpenAPI 3.x, AsyncAPI, Arazzo, JSON Schema, or GraphQL SDL).'}
                  </p>
                ) : null}
                {importableVerdict.status === 'importable' ? (
                  <>
                    <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
                      Importable — client parse recognised{' '}
                      <span className="font-semibold">{importableVerdict.spec ?? importableVerdict.format}</span>.
                    </p>
                    {importableVerdict.truncated ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        Body is truncated; verdict reflects only the loaded portion. Open the full file before relying on
                        counts or structure.
                      </p>
                    ) : null}
                  </>
                ) : null}
                <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                  Index hint (filename / indexer):{' '}
                  <span className="font-mono">{file.detected_kind ?? '—'}</span>
                  {payload ? (
                    <>
                      {' '}
                      · loaded kind: <span className="font-mono">{displayKind}</span>
                    </>
                  ) : null}
                  .
                </p>
              </div>
              <ul className="mt-3 space-y-1.5 text-xs text-gray-500 dark:text-gray-400">
                <li className="inline-flex items-center gap-1.5">
                  <Check className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
                  Indexed path on branch {branch}
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" aria-hidden />
                  Structural validation runs on import
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Suggested target</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Default project mapping from globs will surface here once repository importer mappings exist.
              </p>
            </div>
              </>
            ) : null}
          </div>
          ) : null}

          <div
            className={cn(
              'overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
              !sourceOnlyLayout && 'lg:col-span-2'
            )}
          >
            {loading ? (
              <>
                <div className="flex flex-col gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-1.5">
                    <Skeleton className="h-8 w-[4.5rem] rounded-md" />
                    <Skeleton className="h-8 w-[8.5rem] rounded-md" />
                    <Skeleton className="h-8 w-[5.5rem] rounded-md" />
                    <Skeleton className="h-8 w-[5rem] rounded-md" />
                  </div>
                  <Skeleton className="h-4 w-28 shrink-0 max-sm:hidden" />
                </div>
                <SourcePanelSkeleton />
              </>
            ) : sourceOnlyLayout ? (
              <>
                <div className="flex flex-col gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Source
                  </span>
                  {blobUrl ? (
                    <a
                      href={blobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-2xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden />
                      View on GitHub
                    </a>
                  ) : (
                    <span className="text-2xs text-gray-400">GitHub web link unavailable for this clone URL.</span>
                  )}
                </div>
                {showUnrecognizedImportFormatBlurb ? (
                  <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-100">
                    <p className="flex items-start gap-2 leading-relaxed">
                      <AlertTriangle
                        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                        aria-hidden
                      />
                      <span>{REPOSITORY_FILE_UNRECOGNIZED_FORMAT_BLURB}</span>
                    </p>
                  </div>
                ) : null}
                {error && !payload ? (
                  <p
                    className={cn(
                      'px-4 py-12 text-center text-sm',
                      fetchErrorIndicatesOversizedBody(error)
                        ? 'text-gray-600 dark:text-gray-400'
                        : 'text-rose-600 dark:text-rose-400'
                    )}
                  >
                    {fetchErrorIndicatesOversizedBody(error) ? REPOSITORY_FILE_OVERSIZED_MESSAGE : error}
                  </p>
                ) : showOversizedSourcePlaceholder ? (
                  <div className="flex h-[min(520px,70vh)] min-h-[240px] flex-col items-center justify-center px-6 text-center text-sm text-gray-600 dark:text-gray-400">
                    {REPOSITORY_FILE_OVERSIZED_MESSAGE}
                  </div>
                ) : (
                  <div className="flex flex-col">
                    <div className="flex w-full min-w-0 flex-nowrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 font-mono text-2xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400">
                      <span className="min-w-0 flex-1">
                        Syntax: <span className="text-indigo-600 dark:text-indigo-400">{monacoLanguage}</span>
                        <span className="mx-2 text-gray-300 dark:text-gray-600">·</span>
                        read-only
                      </span>
                      {sourceViewStats ? (
                        <span className="shrink-0 text-right tabular-nums text-gray-600 dark:text-gray-300">
                          {sourceViewStats.lines.toLocaleString()} line{sourceViewStats.lines === 1 ? '' : 's'}
                          <span className="mx-2 text-gray-300 dark:text-gray-600">·</span>
                          {sourceViewStats.sizeLabel}
                        </span>
                      ) : null}
                    </div>
                    <div className="h-[min(520px,70vh)] min-h-[240px] w-full overflow-hidden">
                      <MonacoEditor
                        height="100%"
                        path={file.path}
                        language={monacoLanguage}
                        value={payload?.content ?? ''}
                        theme={isDark ? 'vs-dark' : 'light'}
                        options={{
                          readOnly: true,
                          minimap: { enabled: true },
                          scrollBeyondLastLine: false,
                          fontSize: CODE_BLOCK_FONT_SIZE,
                          wordWrap: 'on',
                          lineNumbers: 'on',
                          folding: true,
                          padding: { top: 8, bottom: 8 },
                          renderWhitespace: 'selection',
                          automaticLayout: true,
                        }}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
            <div className="flex flex-col gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex flex-wrap overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
                <button type="button" className={tabBtnClass(tab === 'source')} onClick={() => setTab('source')}>
                  Source
                </button>
                <button type="button" className={tabBtnClass(tab === 'diff')} onClick={() => setTab('diff')}>
                  Diff vs latest import
                </button>
                <button
                  type="button"
                  className={cn(tabBtnClass(tab === 'visualize'), 'inline-flex items-center gap-1')}
                  onClick={() => setTab('visualize')}
                >
                  <Workflow className="h-3 w-3" aria-hidden />
                  Visualize
                </button>
                <button
                  type="button"
                  className={cn(tabBtnClass(tab === 'details'), 'inline-flex items-center gap-1')}
                  onClick={() => setTab('details')}
                >
                  <LayoutList className="h-3 w-3" aria-hidden />
                  Details
                </button>
              </div>
              {blobUrl ? (
                <a
                  href={blobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 text-2xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400"
                >
                  <ExternalLink className="h-3 w-3" aria-hidden />
                  View on GitHub
                </a>
              ) : (
                <span className="text-2xs text-gray-400">GitHub web link unavailable for this clone URL.</span>
              )}
            </div>

            {error ? (
              <p className="px-4 py-12 text-center text-sm text-rose-600 dark:text-rose-400">{error}</p>
            ) : (
              <>
                {tab === 'source' && (
                  <div className="flex flex-col">
                    <div className="flex w-full min-w-0 flex-nowrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 font-mono text-2xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400">
                      <span className="min-w-0 flex-1">
                        Syntax: <span className="text-indigo-600 dark:text-indigo-400">{monacoLanguage}</span>
                        <span className="mx-2 text-gray-300 dark:text-gray-600">·</span>
                        read-only
                      </span>
                      {sourceViewStats ? (
                        <span className="shrink-0 text-right tabular-nums text-gray-600 dark:text-gray-300">
                          {sourceViewStats.lines.toLocaleString()} line{sourceViewStats.lines === 1 ? '' : 's'}
                          <span className="mx-2 text-gray-300 dark:text-gray-600">·</span>
                          {sourceViewStats.sizeLabel}
                        </span>
                      ) : null}
                    </div>
                    <div className="h-[min(520px,70vh)] min-h-[240px] w-full overflow-hidden">
                      <MonacoEditor
                        height="100%"
                        path={file.path}
                        language={monacoLanguage}
                        value={payload?.content ?? ''}
                        theme={isDark ? 'vs-dark' : 'light'}
                        options={{
                          readOnly: true,
                          minimap: { enabled: true },
                          scrollBeyondLastLine: false,
                          fontSize: CODE_BLOCK_FONT_SIZE,
                          wordWrap: 'on',
                          lineNumbers: 'on',
                          folding: true,
                          padding: { top: 8, bottom: 8 },
                          renderWhitespace: 'selection',
                          automaticLayout: true,
                        }}
                      />
                    </div>
                    {payload?.truncated ? (
                      <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                        File body truncated at the server limit (~{(payload.content?.length ?? 0).toLocaleString()}{' '}
                        characters shown). Open on GitHub or clone locally for the full file.
                      </p>
                    ) : null}
                  </div>
                )}
                {tab === 'diff' && (
                  <div className="max-h-[min(520px,70vh)] overflow-y-auto bg-gray-50 p-4 dark:bg-gray-900/50">
                    <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                      Unified diff vs the last version imported from this path requires import history joined to blob
                      SHAs. Not wired yet.
                    </p>
                    <pre className="font-mono text-xs text-gray-500 dark:text-gray-400">—</pre>
                  </div>
                )}
                {tab === 'visualize' && (
                  <div className="flex min-h-[min(520px,70vh)] flex-col bg-gray-50 dark:bg-gray-900/50">
                    {vizLoading ? (
                      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-16 text-sm text-gray-500 dark:text-gray-400">
                        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" aria-hidden />
                        Building relationship diagram from this file…
                      </div>
                    ) : vizError && !vizAnalysis?.document ? (
                      <p className="px-4 py-8 text-center text-sm text-rose-600 dark:text-rose-400">{vizError}</p>
                    ) : (
                      <>
                        {vizAnalysis && !vizAnalysis.isValid ? (
                          <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-200">
                            Spec has validation issues; diagram may be incomplete.{' '}
                            {vizError ?? vizAnalysis.errors?.[0]?.message ?? ''}
                          </p>
                        ) : null}
                        <div className="min-h-0 flex-1 border-t border-gray-200 dark:border-gray-700">
                          <RepositoryFileSpecRelationshipFlow document={vizAnalysis?.document} />
                        </div>
                      </>
                    )}
                  </div>
                )}
                {tab === 'details' && payload ? (
                  <RepositorySpecDetailTables
                    key={`${file.id}:${payload.blob_sha ?? ''}:${payload.content.length}`}
                    tables={detailTables}
                  />
                ) : null}
              </>
            )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
