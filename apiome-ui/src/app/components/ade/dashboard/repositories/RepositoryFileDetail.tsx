'use client';

/**
 * One indexed repository file, in detail (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §File detail — the breadcrumb, the
 * ready-to-import banner, the file's head with its marks and the one action, the left column
 * (*Detected metadata* · *Importable verdict* · *Suggested target*) and the viewer's four
 * panes (*Source* · *Diff vs latest import* · *Visualize* · *Details*).
 *
 * It replaces the browser in place rather than opening as a peer tab — the mockup's own note
 * says the tab is a mockup device and the app keeps the in-place swap.
 *
 * ### Three things this fixes rather than restyles
 *
 * 1. **The verdict was coloured text on the card.** `text-emerald-800 dark:text-emerald-200`
 *    for importable, `text-amber-800` for a parse failure, `text-rose-700` for an unreadable
 *    body. A `-fg` ink on `--bg-surface` measures 1.5–3.5:1 in the six themes that inherit the
 *    light semantic pairs (the exposure HIVE-7.3 recorded), so the verdict is a tinted strip:
 *    a `-soft` ground with the `-fg` the vocabulary calibrated for it.
 * 2. **The four viewer panes were a bordered button row that looked like a tab strip.** They
 *    are `ui/Segmented` now, which is the control the design language spends on "the same
 *    content, drawn a different way" and which announces "Source, selected, 1 of 4".
 * 3. **The sortable headers were unlabelled.** Each carried an `aria-sort` on the `<th>` but
 *    the button inside said only the column's name, so a screen-reader user heard "Name,
 *    button" with no way to know it sorted. Each now names the action and its next direction.
 */

import dynamic from 'next/dynamic';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  Code2,
  Diff,
  ExternalLink,
  FileCode2,
  GitPullRequestArrow,
  LayoutList,
  Loader2,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { MethodChip } from '@/app/components/ui/MethodChip';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { FILE_DIFF_STUB_COPY, formatFileBytes } from '@/app/components/ade/repositories';
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
    <div className="repo-file-viewer__code flex items-center justify-center bg-subtle text-sm text-fg-muted">
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

/** A cell of a Details table. The shared table skin owns the padding and the hairlines. */
const detailTableTd = 'align-top';
const detailTableTdMono = cn(detailTableTd, 'mono leading-snug');

/** Caps table body height when many rows; short tables stay only as tall as their content. */
const detailSectionBodyScroll = 'max-h-[min(40vh,27.5rem)] overflow-auto';

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

/**
 * One sortable column header.
 *
 * The `aria-sort` on the `<th>` tells assistive technology what the table is sorted by; the
 * button's own accessible name has to say what pressing it *does*, which the header this
 * replaces left out entirely — a screen-reader user heard "Name, button" and had no way to
 * know it was a sort control.
 *
 * @param props.label The column's name.
 * @param props.sortKey The key this column sorts on.
 * @param props.active The table's current sort.
 * @param props.onSort Cycle the sort onto this column.
 * @returns The header cell.
 */
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
  const direction = isActive ? active.dir : 'none';
  const ariaSort = isActive ? (active.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const nextDirection = isActive && active.dir === 'asc' ? 'descending' : 'ascending';

  return (
    <th scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        className="repo-file-sort"
        data-sorted={direction}
        aria-label={`${label} — sort ${nextDirection}`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {isActive ? (
          active.dir === 'asc' ? (
            <ArrowUp aria-hidden />
          ) : (
            <ArrowDown aria-hidden />
          )
        ) : (
          <ArrowUpDown aria-hidden />
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
/**
 * The *Details* pane: three sortable tables over one parsed document.
 *
 * @param props.tables The extracted classes, properties and paths.
 * @returns The three sections, each scrolling inside its own well.
 */
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

  /**
   * One table's heading row: what it lists, how many rows, and whether the extractor stopped
   * short of the whole document.
   *
   * @param props.title The section's name.
   * @param props.count How many rows it holds.
   * @param props.truncated Whether the extractor capped the list.
   * @returns The eyebrow line.
   */
  const sectionHead = (title: string, count: number, truncated: boolean) => (
    <div className="repo-det-card__head">
      <span className="repo-det-caps">{title}</span>
      <span className="repo-det-note mono">
        {count.toLocaleString()} row{count === 1 ? '' : 's'}
        {truncated ? ' · truncated' : ''}
      </span>
    </div>
  );

  return (
    <div className="repo-file-tables" data-testid="repository-file-detail-tables">
      <div className="repo-det-card__head">
        <div className="flex flex-col gap-1">
          <h3 className="repo-det-card__title">Specification structure</h3>
          <p className="repo-det-note">
            Extracted from the loaded file. Headers cycle ascending and descending.
          </p>
        </div>
        <FormatPill format={formatDetailFormatLabel(tables.format)} />
      </div>

      {tables.parseError ? (
        <Alert variant="warn">Details tables need valid YAML or JSON. {tables.parseError}</Alert>
      ) : null}

      <section className="repo-file-tables__section">
        {sectionHead('Classes', tables.classes.length, tables.truncated.classes)}
        <div className={cn('repo-det-table-wrap', detailSectionBodyScroll)}>
          {tables.classes.length === 0 ? (
            <EmptyState variant="inline" title={emptyCopy} />
          ) : (
            <table className="repo-det-table table-density table-dense min-w-[45rem]">
              <thead>
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
                    sortKey="propertyCount"
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
              <tbody>
                {sortedClasses.map((row, i) => (
                  <tr key={`${row.name}-${row.kind}-${i}`}>
                    <td className={cn(detailTableTdMono, 'font-semibold')}>{row.name}</td>
                    <td className={detailTableTd}>{row.kind}</td>
                    <td className={detailTableTdMono}>{row.typeSummary ?? '—'}</td>
                    <td className={cn(detailTableTd, 'repo-det-num')}>
                      {row.propertiesCount != null ? row.propertiesCount.toLocaleString() : '—'}
                    </td>
                    <td className={cn(detailTableTd, 'repo-det-quiet-cell max-w-md whitespace-pre-wrap break-words')}>
                      {row.description ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="repo-file-tables__section">
        {sectionHead('Properties', tables.properties.length, tables.truncated.properties)}
        <div className={cn('repo-det-table-wrap', detailSectionBodyScroll)}>
          {tables.properties.length === 0 ? (
            <EmptyState variant="inline" title={emptyCopy} />
          ) : (
            <table className="repo-det-table table-density table-dense min-w-[60rem]">
              <thead>
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
              <tbody>
                {sortedProperties.map((row, i) => (
                  <tr key={`${row.context}-${row.name}-${i}`}>
                    <td className={cn(detailTableTdMono, 'font-semibold')}>{row.name}</td>
                    <td className={detailTableTdMono}>{row.context}</td>
                    <td className={cn(detailTableTdMono, 'max-w-[14rem] whitespace-pre-wrap break-all')}>
                      {row.typeOrConstraint ?? '—'}
                    </td>
                    <td className={detailTableTd}>
                      {row.required === true ? 'Yes' : row.required === false ? 'No' : '—'}
                    </td>
                    <td className={detailTableTdMono}>{row.format ?? '—'}</td>
                    <td className={cn(detailTableTdMono, 'max-w-[12rem] whitespace-pre-wrap break-all')}>
                      {row.defaultValue ?? '—'}
                    </td>
                    <td className={cn(detailTableTd, 'repo-det-quiet-cell max-w-lg whitespace-pre-wrap break-words')}>
                      {row.description ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="repo-file-tables__section">
        {sectionHead('Paths & operations', tables.paths.length, tables.truncated.paths)}
        <div className={cn('repo-det-table-wrap', detailSectionBodyScroll)}>
          {tables.paths.length === 0 ? (
            <EmptyState variant="inline" title={emptyCopy} />
          ) : (
            <table className="repo-det-table table-density table-dense min-w-[60rem]">
              <thead>
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
              <tbody>
                {sortedPaths.map((row, i) => (
                  <tr key={`${row.template}-${row.method}-${row.operationId ?? ''}-${i}`}>
                    <td className={cn(detailTableTdMono, 'max-w-xs font-semibold break-all')}>
                      {row.template}
                    </td>
                    <td className={detailTableTd}>
                      {row.method ? <MethodChip method={row.method} /> : '—'}
                    </td>
                    <td className={cn(detailTableTdMono, 'max-w-[14rem] break-all')}>
                      {row.operationId ?? '—'}
                    </td>
                    <td className={cn(detailTableTd, 'max-w-xs whitespace-pre-wrap break-words')}>
                      {row.summary ?? '—'}
                    </td>
                    <td className={cn(detailTableTd, 'repo-det-quiet-cell max-w-xl whitespace-pre-wrap break-words')}>
                      {row.description ?? '—'}
                    </td>
                    <td className={cn(detailTableTd, 'repo-det-quiet-cell max-w-xs whitespace-pre-wrap break-words')}>
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
  );
}

/** The metadata card's shape while the file loads. */
function MetadataCardSkeleton() {
  return (
    <Card aria-hidden>
      <CardContent className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

/** The verdict card's shape while the file loads. */
function VerdictCardSkeleton() {
  return (
    <Card aria-hidden>
      <CardContent className="flex flex-col gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-3.5 w-3/4" />
      </CardContent>
    </Card>
  );
}

/** The suggested-target card's shape while the file loads. */
function SuggestedTargetCardSkeleton() {
  return (
    <Card aria-hidden>
      <CardContent className="flex flex-col gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3.5 w-full" />
      </CardContent>
    </Card>
  );
}

/** The viewer's shape while the file loads. */
function SourcePanelSkeleton() {
  return (
    <div className="repo-file-viewer__code flex flex-col gap-2 p-4" aria-hidden>
      {Array.from({ length: 12 }).map((_, i) => (
        <Skeleton key={i} className="h-3.5 w-full" />
      ))}
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
      sizeLabel: formatFileBytes(payload.size_bytes ?? file.size_bytes),
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

  /**
   * The verdict strip's tone.
   *
   * Four verdicts, three tones: *importable* is `ok`, an unreadable body is `danger` because
   * nothing can be said about the file at all, and the two that describe the file's own
   * contents — it will not parse, or it parses into something the importer does not take — are
   * `warn`. Neither of those is a failure of the product, and colouring them red files them in
   * a queue they do not belong to.
   */
  const verdictTone =
    importableVerdict.status === 'importable'
      ? 'ok'
      : importableVerdict.status === 'content_unavailable'
        ? 'danger'
        : 'warn';

  const providerLink = blobUrl ? (
    <a href={blobUrl} target="_blank" rel="noopener noreferrer" className="repo-det-link">
      <ExternalLink className="inline size-3" aria-hidden /> View on GitHub
    </a>
  ) : (
    <span className="repo-det-note">GitHub web link unavailable for this clone URL.</span>
  );

  /** The read-only editor and the syntax strip above it, shared by both layouts. */
  const sourcePane = (
    <div className="flex flex-col">
      <div className="repo-file-viewer__syntax">
        <span className="mono">
          Syntax: {monacoLanguage} · read-only
        </span>
        {sourceViewStats ? (
          <span className="mono tabular-nums">
            {sourceViewStats.lines.toLocaleString()} line{sourceViewStats.lines === 1 ? '' : 's'} ·{' '}
            {sourceViewStats.sizeLabel}
          </span>
        ) : null}
      </div>
      <div className="repo-file-viewer__code">
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
        <Alert variant="warn" bar>
          File body truncated at the server limit (
          {(payload.content?.length ?? 0).toLocaleString()} characters shown). Open it on the
          provider or clone locally for the full file.
        </Alert>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4" aria-busy={loading} data-testid="repository-file-detail">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="repo-det-link"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden />
          Back to {repositoryName}
        </Button>
        <span className="repo-det-note mono break-all">{file.path}</span>
      </div>

      {stagedImportTarget && stagedImportApplies ? (
        <Alert
          variant="ok"
          data-testid="repository-file-ready-banner"
          actions={
            onContinueStagedImport ? (
              <Button type="button" size="sm" variant="outline" onClick={onContinueStagedImport}>
                Map &amp; import
              </Button>
            ) : null
          }
        >
          <p className="font-semibold">Ready to import</p>
          {stagedImportSummary ? (
            <p className="repo-file-verdict__detail">
              {stagedImportSummary}. Open Map &amp; import to run the catalog import.
            </p>
          ) : null}
        </Alert>
      ) : null}

      <Card className="repo-file-head">
        <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
          <FileCode2 />
        </span>
        <div className="repo-file-head__text">
          <h2 className="repo-file-head__path mono">{file.path}</h2>
          <div className="repo-file-head__marks">
            {!sourceOnlyLayout ? (
              <>
                <FormatPill format={displayKind} />
                <Badge variant="outline" mono>
                  confidence: {confLabel}
                </Badge>
              </>
            ) : null}
            <span className="repo-det-note mono">
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Loading file…
                </span>
              ) : (
                <>
                  {formatFileBytes(payload?.size_bytes ?? file.size_bytes)} ·{' '}
                  {shortSha(payload?.blob_sha ?? file.blob_sha)} · branch {branch}
                </>
              )}
            </span>
          </div>
        </div>
        {!sourceOnlyLayout ? (
          <Button
            type="button"
            onClick={onMapImport}
            disabled={!mapImportAllowed}
            title={!mapImportAllowed ? (mapImportBlockHint ?? undefined) : undefined}
            data-testid="repository-file-map-import"
          >
            <GitPullRequestArrow aria-hidden />
            Map &amp; import
          </Button>
        ) : null}
      </Card>

      {!sourceOnlyLayout && mapImportBlockHint ? (
        <Alert variant="warn" data-testid="repository-file-map-import-blocked">
          <p className="font-semibold">Map &amp; import unavailable</p>
          <p className="repo-file-verdict__detail">{mapImportBlockHint}</p>
        </Alert>
      ) : null}

      <div className={cn('repo-file-split', sourceOnlyLayout && 'repo-file-split--source-only')}>
        {!sourceOnlyLayout ? (
          <div className="repo-file-column">
            {loading ? (
              <>
                <MetadataCardSkeleton />
                <VerdictCardSkeleton />
                <SuggestedTargetCardSkeleton />
              </>
            ) : (
              <>
                <Card data-testid="repository-file-metadata">
                  <CardContent className="flex flex-col gap-3">
                    <h3 className="repo-det-card__title">Detected metadata</h3>
                    <dl className="repo-file-kv">
                      <dt>Spec</dt>
                      <dd>{specMetadata.spec ?? '—'}</dd>
                      <dt>Title</dt>
                      <dd>{specMetadata.title ?? '—'}</dd>
                      <dt>Version</dt>
                      <dd className="mono">{specMetadata.version ?? '—'}</dd>
                      <dt>Endpoints</dt>
                      <dd className="mono">{formatMetadataCell(specMetadata.endpoints)}</dd>
                      <dt>Components</dt>
                      <dd className="mono">{formatMetadataCell(specMetadata.components)}</dd>
                      <dt>Servers</dt>
                      <dd className="mono">{formatMetadataCell(specMetadata.servers)}</dd>
                      <dt>Path</dt>
                      <dd className="mono">{file.path}</dd>
                      <dt>Blob</dt>
                      <dd className="mono">{shortSha(payload?.blob_sha ?? file.blob_sha)}</dd>
                    </dl>

                    {payload?.truncated ? (
                      <p className="repo-det-note">
                        File body is truncated; the counts above reflect only the loaded portion.
                      </p>
                    ) : null}
                    {specMetadata.parseError && payload ? (
                      <p className="repo-det-note">
                        Could not parse as YAML/JSON: {specMetadata.parseError}
                      </p>
                    ) : null}
                    {payload && specMetadata.format === 'unknown' && !specMetadata.parseError ? (
                      <p className="repo-det-note">
                        No recognised OpenAPI, Swagger, AsyncAPI, Arazzo, JSON Schema, or GraphQL
                        SDL structure in this file.
                      </p>
                    ) : null}
                    {payload && specMetadata.format !== 'unknown' ? (
                      <p className="repo-det-note">
                        Values derived from the loaded file (client-side parse). Index kind:{' '}
                        <span className="mono">{displayKind}</span>.
                      </p>
                    ) : null}

                    {payload &&
                    specMetadata.format !== 'unknown' &&
                    specMetadata.components === 0 &&
                    !specMetadata.parseError ? (
                      <Alert variant="warn" data-testid="repository-file-zero-components-warning">
                        <p className="font-semibold">No component definitions detected</p>
                        <p className="repo-file-verdict__detail">
                          The loaded document has no reusable schemas or other named components
                          in the usual buckets (for example OpenAPI{' '}
                          <span className="mono">components</span> or JSON Schema{' '}
                          <span className="mono">$defs</span>). Many importable files are
                          effectively path-only, so this summary can look sparse even when the
                          file is fine — import may still succeed.
                        </p>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>

                <Card
                  data-importable-verdict={JSON.stringify(importableVerdict)}
                  data-testid="repository-file-importable-verdict"
                >
                  <CardContent className="flex flex-col gap-3">
                    <h3 className="repo-det-card__title">Importable verdict</h3>
                    <div className="repo-file-verdict" data-tone={verdictTone}>
                      {importableVerdict.status === 'content_unavailable' ? (
                        <>
                          <span>Content unavailable — cannot evaluate importability.</span>
                          <span className="repo-file-verdict__detail mono">
                            {importableVerdict.loadError}
                          </span>
                        </>
                      ) : null}
                      {importableVerdict.status === 'parse_failed' ? (
                        <>
                          <span>Not evaluable as YAML/JSON — fix syntax to detect a spec.</span>
                          <span className="repo-file-verdict__detail mono">
                            {importableVerdict.parseError}
                          </span>
                        </>
                      ) : null}
                      {importableVerdict.status === 'not_importable' ? (
                        <span>
                          {importableVerdict.notImportableMessage ??
                            'Not importable — the loaded content does not match a supported specification shape (OpenAPI 3.x, AsyncAPI, Arazzo, JSON Schema, or GraphQL SDL).'}
                        </span>
                      ) : null}
                      {importableVerdict.status === 'importable' ? (
                        <>
                          <span>
                            Importable — the client parse recognised{' '}
                            <span className="font-semibold">
                              {importableVerdict.spec ?? importableVerdict.format}
                            </span>
                            .
                          </span>
                          {importableVerdict.truncated ? (
                            <span className="repo-file-verdict__detail">
                              The body is truncated, so the verdict reflects only the loaded
                              portion. Open the full file before relying on counts or structure.
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </div>

                    <p className="repo-det-note">
                      Index hint (filename / indexer):{' '}
                      <span className="mono">{file.detected_kind ?? '—'}</span>
                      {payload ? (
                        <>
                          {' '}
                          · loaded kind: <span className="mono">{displayKind}</span>
                        </>
                      ) : null}
                      .
                    </p>

                    <ul className="repo-file-verdict-facts">
                      <li>
                        <Check aria-hidden />
                        Indexed path on branch {branch}
                      </li>
                      <li>
                        <AlertTriangle aria-hidden />
                        Structural validation runs on import
                      </li>
                    </ul>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="flex flex-col gap-2">
                    <h3 className="repo-det-card__title">Suggested target</h3>
                    <p className="repo-det-note">
                      A default project mapping from globs will surface here once repository
                      importer mappings exist.
                    </p>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        ) : null}

        <Card className="repo-file-viewer">
          <div className="repo-file-viewer__bar">
            {loading ? (
              <Skeleton className="h-8 w-[22rem] rounded-md" aria-hidden />
            ) : sourceOnlyLayout ? (
              <span className="repo-det-caps">Source</span>
            ) : (
              <Segmented
                value={tab}
                onValueChange={(next) => setTab(next as FileViewTab)}
                aria-label="File view"
                size="sm"
              >
                <SegmentedItem value="source">
                  <Code2 aria-hidden />
                  Source
                </SegmentedItem>
                <SegmentedItem value="diff">
                  <Diff aria-hidden />
                  Diff vs latest import
                </SegmentedItem>
                <SegmentedItem value="visualize">
                  <Workflow aria-hidden />
                  Visualize
                </SegmentedItem>
                <SegmentedItem value="details">
                  <LayoutList aria-hidden />
                  Details
                </SegmentedItem>
              </Segmented>
            )}
            {providerLink}
          </div>

          {loading ? (
            <SourcePanelSkeleton />
          ) : sourceOnlyLayout ? (
            <>
              {showUnrecognizedImportFormatBlurb ? (
                <Alert variant="warn" bar data-testid="repository-file-unrecognized">
                  {REPOSITORY_FILE_UNRECOGNIZED_FORMAT_BLURB}
                </Alert>
              ) : null}
              {error && !payload ? (
                <div className="repo-det-table__state" data-tone={
                  fetchErrorIndicatesOversizedBody(error) ? undefined : 'danger'
                }>
                  {fetchErrorIndicatesOversizedBody(error)
                    ? REPOSITORY_FILE_OVERSIZED_MESSAGE
                    : error}
                </div>
              ) : showOversizedSourcePlaceholder ? (
                <div className="repo-file-viewer__code flex items-center justify-center px-6 text-center text-sm text-fg-muted">
                  {REPOSITORY_FILE_OVERSIZED_MESSAGE}
                </div>
              ) : (
                sourcePane
              )}
            </>
          ) : error ? (
            <div className="repo-det-table__state" data-tone="danger">
              {error}
            </div>
          ) : (
            <>
              {tab === 'source' ? sourcePane : null}
              {tab === 'diff' ? (
                <EmptyState
                  icon={<Diff aria-hidden />}
                  title="Diff not wired yet"
                  description={FILE_DIFF_STUB_COPY}
                />
              ) : null}
              {tab === 'visualize' ? (
                <div className="repo-file-viewer__code flex flex-col">
                  {vizLoading ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-fg-muted">
                      <Loader2 className="size-8 animate-spin" aria-hidden />
                      Building relationship diagram from this file…
                    </div>
                  ) : vizError && !vizAnalysis?.document ? (
                    <div className="repo-det-table__state" data-tone="danger">
                      {vizError}
                    </div>
                  ) : (
                    <>
                      {vizAnalysis && !vizAnalysis.isValid ? (
                        <Alert variant="warn" bar>
                          Spec has validation issues; the diagram may be incomplete.{' '}
                          {vizError ?? vizAnalysis.errors?.[0]?.message ?? ''}
                        </Alert>
                      ) : null}
                      <div className="min-h-0 flex-1">
                        <RepositoryFileSpecRelationshipFlow document={vizAnalysis?.document} />
                      </div>
                    </>
                  )}
                </div>
              ) : null}
              {tab === 'details' && payload ? (
                <RepositorySpecDetailTables
                  key={`${file.id}:${payload.blob_sha ?? ''}:${payload.content.length}`}
                  tables={detailTables}
                />
              ) : null}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
