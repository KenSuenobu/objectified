'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { useMigration } from '../MigrationContext';
import { Database, Search, List, FileJson, Play } from 'lucide-react';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const PAGE_SIZE = 20;
const DATA_PREVIEW_MAX_LEN = 60;

type SnapshotRow = {
  record_id: string;
  data: Record<string, unknown>;
  updated_at: string;
  created_at?: string;
  record_sequence?: number;
  last_action?: string;
};

function truncateDataPreview(data: Record<string, unknown>, maxLen: number): string {
  const raw = JSON.stringify(data);
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen).trim() + '…';
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export default function DataInspectionView() {
  const { selectedClassName, fromTables, migrationRules } = useMigration();
  const [rows, setRows] = React.useState<SnapshotRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [searchQ, setSearchQ] = React.useState('');
  const [viewMode, setViewMode] = React.useState<'none' | 'viewAll' | 'search'>('none');
  const [selectedRecord, setSelectedRecord] = React.useState<SnapshotRow | null>(null);
  /** When user has clicked Evaluate for a record: that record id and the transformed result. */
  const [evaluatedRecordId, setEvaluatedRecordId] = React.useState<string | null>(null);
  const [evaluatedData, setEvaluatedData] = React.useState<Record<string, unknown> | null>(null);
  const [evaluateLoading, setEvaluateLoading] = React.useState(false);
  const [evaluateError, setEvaluateError] = React.useState<string | null>(null);

  const fromRow = selectedClassName
    ? fromTables.find((r) => r.class_name === selectedClassName)
    : null;
  const classSchemaId = fromRow?.class_schema_id ?? null;

  const runQuery = React.useCallback(
    (pageNum: number, searchQuery?: string) => {
      if (!classSchemaId) return;
      setLoading(true);
      const params = new URLSearchParams({
        classSchemaId,
        page: String(pageNum),
        pageSize: String(PAGE_SIZE),
        orderBy: 'updated_at',
        orderDir: 'desc',
      });
      const url = searchQuery
        ? `/api/database/snapshot/search?${params.toString()}&q=${encodeURIComponent(searchQuery)}`
        : `/api/database/snapshot?${params.toString()}`;
      fetch(url)
        .then((r) => r.json())
        .then((data) => {
          if (data.success && data.rows) {
            setRows(data.rows);
            setTotal(data.total ?? 0);
            setPage(data.page ?? pageNum);
          }
        })
        .finally(() => setLoading(false));
    },
    [classSchemaId]
  );

  const runEvaluate = React.useCallback(
    (record: SnapshotRow) => {
      if (!migrationRules || Object.keys(migrationRules).length === 0) {
        setEvaluateError('No migration rules defined. Add rules in the migration plan.');
        return;
      }
      setEvaluateLoading(true);
      setEvaluateError(null);
      fetch('/api/migration-plans/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordData: record.data, rules: migrationRules }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success && data.transformedData !== undefined) {
            setEvaluatedRecordId(record.record_id);
            setEvaluatedData(data.transformedData as Record<string, unknown>);
            setEvaluateError(null);
          } else {
            setEvaluateError(data.error ?? 'Evaluate failed');
            setEvaluatedData(null);
          }
        })
        .catch(() => {
          setEvaluateError('Request failed');
          setEvaluatedData(null);
        })
        .finally(() => setEvaluateLoading(false));
    },
    [migrationRules]
  );

  React.useEffect(() => {
    if (!classSchemaId) {
      setRows([]);
      setTotal(0);
      setPage(1);
      setViewMode('none');
      setSelectedRecord(null);
      setEvaluatedRecordId(null);
      setEvaluatedData(null);
      setEvaluateError(null);
      return;
    }
    setViewMode('viewAll');
    setSelectedRecord(null);
    setEvaluatedRecordId(null);
    setEvaluatedData(null);
    setEvaluateError(null);
    runQuery(1, undefined);
  }, [classSchemaId]); // eslint-disable-line react-hooks/exhaustive-deps -- only reset when class changes

  const handleViewAll = () => {
    setViewMode('viewAll');
    if (classSchemaId) runQuery(1, undefined);
  };

  const handleSearch = () => {
    setViewMode('search');
    if (classSchemaId) runQuery(1, searchQ);
  };

  const handlePageChange = (newPage: number) => {
    if (!classSchemaId) return;
    if (viewMode === 'search') runQuery(newPage, searchQ);
    else runQuery(newPage, undefined);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!selectedClassName) {
    return (
      <div className="h-full flex flex-col min-h-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 shrink-0">
          <Database className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Data inspection
          </h3>
        </div>
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500 p-4">
          <Search className="w-8 h-8" />
          <p className="text-sm text-center">Select a class in the sidebar to inspect migration data.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 shrink-0">
        <Database className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Data inspection — {selectedClassName}
        </h3>
      </div>
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left 20%: record list (from-data, searchable, read-only) */}
        <div className="shrink-0 flex flex-col border-r border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30" style={{ width: '20%', minWidth: 0 }}>
          <div className="p-2 border-b border-gray-200 dark:border-gray-700 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Search records..."
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={handleSearch}
                className="shrink-0 p-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                title="Search"
              >
                <Search className="w-4 h-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={handleViewAll}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <List className="w-4 h-4" />
              View all records
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {viewMode === 'none' ? (
              <div className="p-3 text-sm text-gray-500 dark:text-gray-400">
                Click &quot;View all records&quot; or search to load data.
              </div>
            ) : loading ? (
              <div className="p-3 text-sm text-gray-500 dark:text-gray-400">Loading…</div>
            ) : rows.length === 0 ? (
              <div className="p-3 text-sm text-gray-500 dark:text-gray-400">No records found.</div>
            ) : (
              <ul className="p-1 space-y-0.5">
                {rows.map((row) => {
                  const isSelected = selectedRecord?.record_id === row.record_id;
                  return (
                    <li key={row.record_id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedRecord(row);
                          setEvaluatedRecordId(null);
                          setEvaluatedData(null);
                          setEvaluateError(null);
                        }}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                          isSelected
                            ? 'bg-indigo-100 dark:bg-indigo-900/40 border-indigo-200 dark:border-indigo-800 text-indigo-900 dark:text-indigo-100'
                            : 'border-transparent text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                        }`}
                      >
                        <div className="font-mono text-xs text-gray-500 dark:text-gray-400 truncate">
                          {row.record_id}
                        </div>
                        <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 truncate">
                          {truncateDataPreview(row.data, DATA_PREVIEW_MAX_LEN)}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {formatDateTime(row.updated_at)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {viewMode !== 'none' && totalPages > 1 && (
              <div className="flex items-center justify-between gap-2 p-2 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page <= 1}
                  className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-600 disabled:opacity-50 text-gray-700 dark:text-gray-300"
                >
                  Prev
                </button>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page >= totalPages}
                  className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-600 disabled:opacity-50 text-gray-700 dark:text-gray-300"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Center 40% + Right 40%: before / after views (50/50 of remaining space) */}
        <div className="flex-1 min-w-0 flex overflow-hidden">
          {/* Before: source data (Monaco JSON) */}
          <div className="flex-1 min-w-0 flex flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            <div className="h-11 flex items-center gap-2 px-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30 shrink-0">
              <FileJson className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Before
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {selectedRecord ? (
                <MonacoEditor
                  height="100%"
                  language="json"
                  theme="vs-dark"
                  value={JSON.stringify(selectedRecord.data, null, 2)}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: CODE_EDITOR_FONT_SIZE,
                    wordWrap: 'on',
                  }}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500 p-4">
                  <FileJson className="w-10 h-10" />
                  <p className="text-sm text-center">Select a record to see source data.</p>
                </div>
              )}
            </div>
          </div>
          {/* After: transformed (Monaco JSON) — only show content when Evaluate was clicked for this record */}
          <div className="flex-1 min-w-0 flex flex-col bg-white dark:bg-gray-900">
            <div className="h-11 flex items-center justify-between gap-2 px-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileJson className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                  After rules applied
                </span>
              </div>
              <button
                type="button"
                onClick={() => selectedRecord && runEvaluate(selectedRecord)}
                disabled={!selectedRecord || evaluateLoading}
                className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 disabled:opacity-50 disabled:pointer-events-none text-sm font-medium"
              >
                <Play className="w-4 h-4" />
                {evaluateLoading ? 'Evaluating…' : 'Evaluate'}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {evaluateError && (
                <div className="shrink-0 px-3 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
                  {evaluateError}
                </div>
              )}
              {!selectedRecord ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500 p-4">
                  <FileJson className="w-10 h-10" />
                  <p className="text-sm text-center">
                    Select a record to see the transformed object (after rules are applied).
                  </p>
                </div>
              ) : evaluateLoading ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500 p-4">
                  <p className="text-sm">Applying rules…</p>
                </div>
              ) : evaluatedRecordId === selectedRecord.record_id && evaluatedData !== null ? (
                <MonacoEditor
                  height="100%"
                  language="json"
                  theme="vs-dark"
                  value={JSON.stringify(evaluatedData, null, 2)}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: CODE_EDITOR_FONT_SIZE,
                    wordWrap: 'on',
                  }}
                />
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500 p-4">
                  <Play className="w-10 h-10" />
                  <p className="text-sm text-center">
                    Click <strong>Evaluate</strong> above to see the result after rules are applied for this record.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
