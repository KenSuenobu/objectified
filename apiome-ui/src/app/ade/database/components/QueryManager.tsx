'use client';

import * as React from 'react';
import { useDatabase } from '../DatabaseContext';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { List, Search, Plus, Database, Info, FileJson, ArrowUp, ArrowDown, ArrowUpDown, Trash2, RotateCcw, Pencil } from 'lucide-react';
import { Switch } from '@/app/components/ui/Switch';
import type { SnapshotQueryFilters } from './query-manager-types';
import InsertStubModal from './InsertStubModal';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/app/components/ui/Dialog';
import dynamic from 'next/dynamic';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

const PAGE_SIZE = 20;
const DATA_PREVIEW_MAX_LEN = 80;

type SortColumn = 'record_id' | 'created_at' | 'updated_at' | 'record_sequence' | 'last_action';

type SnapshotRow = {
  record_id: string;
  data: Record<string, unknown>;
  updated_at: string;
  created_at?: string;
  record_sequence?: number;
  last_action?: string;
};

type RecordHistoryEvent = {
  record_sequence: number;
  action: string;
  created_at: string;
  created_by?: string | null;
  data: Record<string, unknown>;
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

function SortHeader({
  label,
  column,
  currentSortBy,
  currentSortDir,
  onSort,
}: {
  label: string;
  column: SortColumn;
  currentSortBy: SortColumn;
  currentSortDir: 'asc' | 'desc';
  onSort: (c: SortColumn) => void;
}) {
  const isActive = currentSortBy === column;
  return (
    <th className="text-left py-2 px-2 font-medium text-gray-700 dark:text-gray-300">
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 hover:text-indigo-600 dark:hover:text-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded"
      >
        {label}
        {isActive ? (
          currentSortDir === 'desc' ? (
            <ArrowDown className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <ArrowUp className="w-3.5 h-3.5 shrink-0" />
          )
        ) : (
          <ArrowUpDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
        )}
      </button>
    </th>
  );
}

export default function QueryManager() {
  const { selectedProjectId, selectedVersionId, selectedTable, isReadOnly, refreshTableCount } = useDatabase();
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [viewMode, setViewMode] = React.useState<'none' | 'viewAll' | 'search' | 'ai'>('none');
  const [count, setCount] = React.useState<number | null>(null);
  const [rows, setRows] = React.useState<SnapshotRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [searchQ, setSearchQ] = React.useState('');
  const [insertModalOpen, setInsertModalOpen] = React.useState(false);
  const [editRecordId, setEditRecordId] = React.useState<string | null>(null);
  const [viewRecord, setViewRecord] = React.useState<SnapshotRow | null>(null);
  const [recordViewTab, setRecordViewTab] = React.useState<'current' | 'historical'>('current');
  const [recordHistory, setRecordHistory] = React.useState<RecordHistoryEvent[]>([]);
  const [recordHistoryLoading, setRecordHistoryLoading] = React.useState(false);
  const [selectedHistoryIndex, setSelectedHistoryIndex] = React.useState<number>(0);
  const [sortBy, setSortBy] = React.useState<SortColumn>('updated_at');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);
  const [showDeleted, setShowDeleted] = React.useState(false);

  const classSchemaId = selectedTable?.classSchemaId ?? null;

  const loadCount = React.useCallback(() => {
    if (!classSchemaId) return;
    const params = new URLSearchParams({ classSchemaId });
    if (showDeleted) params.set('includeDeleted', 'true');
    fetch(`/api/database/snapshot/count?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && typeof data.count === 'number') setCount(data.count);
      });
  }, [classSchemaId, showDeleted]);

  React.useEffect(() => {
    if (!classSchemaId) {
      setCount(null);
      setViewMode('none');
      setRows([]);
      setTotal(0);
      setPage(1);
      return;
    }
    // When a table is selected, start in "View all records" and load the first page.
    setViewMode('viewAll');
    setRows([]);
    setTotal(0);
    setPage(1);
    setSearchQ('');
    loadCount();
    runQuery({ classSchemaId }, 1, PAGE_SIZE, undefined, sortBy, sortDir);
    // Intentionally only depend on classSchemaId so toggling showDeleted doesn't reset the view
  }, [classSchemaId]); // eslint-disable-line react-hooks/exhaustive-deps -- loadCount, runQuery, sortBy, sortDir omitted so showDeleted toggle only refreshes via next effect

  React.useEffect(() => {
    if (!classSchemaId) return;
    loadCount();
    if (viewMode === 'viewAll') runQuery({ classSchemaId }, page, PAGE_SIZE, undefined, sortBy, sortDir);
    if (viewMode === 'search') runQuery({ classSchemaId }, page, PAGE_SIZE, searchQ, sortBy, sortDir);
  }, [showDeleted]); // eslint-disable-line react-hooks/exhaustive-deps -- only re-fetch when showDeleted toggles

  React.useEffect(() => {
    if (!viewRecord) return;
    setRecordViewTab('current');
    setRecordHistory([]);
    setSelectedHistoryIndex(0);
  }, [viewRecord?.record_id]);

  React.useEffect(() => {
    if (recordViewTab !== 'historical' || !viewRecord || !classSchemaId) return;
    setRecordHistoryLoading(true);
    fetch(`/api/database/snapshot/${encodeURIComponent(viewRecord.record_id)}/history?classSchemaId=${encodeURIComponent(classSchemaId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && Array.isArray(data.events)) {
          setRecordHistory(data.events);
          setSelectedHistoryIndex(Math.max(0, data.events.length - 1));
        }
      })
      .finally(() => setRecordHistoryLoading(false));
  }, [recordViewTab, viewRecord?.record_id, classSchemaId]);

  const runQuery = React.useCallback((filters: SnapshotQueryFilters, pageNum: number, pageSize: number, searchQuery?: string, orderBy?: string, orderDir?: string) => {
    if (!filters.classSchemaId) return;
    setLoading(true);
    const base = `/api/database/snapshot`;
    const params = new URLSearchParams({
      classSchemaId: filters.classSchemaId,
      page: String(pageNum),
      pageSize: String(pageSize),
    });
    if (showDeleted) params.set('includeDeleted', 'true');
    if (orderBy) params.set('orderBy', orderBy);
    if (orderDir) params.set('orderDir', orderDir);
    const url = searchQuery
      ? `${base}/search?${params.toString()}&q=${encodeURIComponent(searchQuery)}`
      : `${base}?${params.toString()}`;
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
  }, [showDeleted]);

  const handleViewAll = () => {
    setViewMode('viewAll');
    if (classSchemaId) runQuery({ classSchemaId }, 1, PAGE_SIZE, undefined, sortBy, sortDir);
  };

  const handleSearch = () => {
    setViewMode('search');
    if (classSchemaId) runQuery({ classSchemaId }, 1, PAGE_SIZE, searchQ, sortBy, sortDir);
  };

  const handlePageChange = (newPage: number) => {
    if (!classSchemaId) return;
    if (viewMode === 'search') {
      runQuery({ classSchemaId }, newPage, PAGE_SIZE, searchQ, sortBy, sortDir);
    } else {
      runQuery({ classSchemaId }, newPage, PAGE_SIZE, undefined, sortBy, sortDir);
    }
  };

  const handleSort = (column: SortColumn) => {
    const nextDir = sortBy === column && sortDir === 'desc' ? 'asc' : 'desc';
    setSortBy(column);
    setSortDir(nextDir);
    if (!classSchemaId) return;
    if (viewMode === 'search') {
      runQuery({ classSchemaId }, page, PAGE_SIZE, searchQ, column, nextDir);
    } else {
      runQuery({ classSchemaId }, page, PAGE_SIZE, undefined, column, nextDir);
    }
  };

  const handleDelete = async (recordId: string) => {
    if (!classSchemaId || isReadOnly) return;
    const confirmed = await confirmDialog({
      title: 'Delete record',
      message: 'Delete this record? The data will be stored in the event log and can be restored later.',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setDeletingId(recordId);
    fetch(`/api/database/snapshot/${encodeURIComponent(recordId)}?classSchemaId=${encodeURIComponent(classSchemaId)}`, {
      method: 'DELETE',
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          loadCount();
          if (viewMode === 'viewAll') runQuery({ classSchemaId }, page, PAGE_SIZE, undefined, sortBy, sortDir);
          if (viewMode === 'search') runQuery({ classSchemaId }, page, PAGE_SIZE, searchQ, sortBy, sortDir);
          refreshTableCount(classSchemaId);
        } else {
          alertDialog({ message: data.error ?? 'Delete failed' });
        }
      })
      .catch((err) => {
        console.error(err);
        alertDialog({ message: err instanceof Error ? err.message : 'Delete failed' });
      })
      .finally(() => setDeletingId(null));
  };

  const handleRestore = async (recordId: string) => {
    if (!classSchemaId || isReadOnly) return;
    const confirmed = await confirmDialog({
      title: 'Restore record',
      message: 'Restore this deleted record? The data will be recreated in the table.',
      confirmLabel: 'Restore',
    });
    if (!confirmed) return;
    setRestoringId(recordId);
    fetch(`/api/database/snapshot/${encodeURIComponent(recordId)}/restore?classSchemaId=${encodeURIComponent(classSchemaId)}`, {
      method: 'POST',
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          loadCount();
          if (viewMode === 'viewAll') runQuery({ classSchemaId }, page, PAGE_SIZE, undefined, sortBy, sortDir);
          if (viewMode === 'search') runQuery({ classSchemaId }, page, PAGE_SIZE, searchQ, sortBy, sortDir);
          refreshTableCount(classSchemaId);
        } else {
          alertDialog({ message: data.error ?? 'Restore failed' });
        }
      })
      .catch((err) => {
        console.error(err);
        alertDialog({ message: err instanceof Error ? err.message : 'Restore failed' });
      })
      .finally(() => setRestoringId(null));
  };

  if (!selectedProjectId || !selectedVersionId) {
    return (
      <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800">
        <div className="relative">
          <div className="absolute -top-20 -left-20 w-40 h-40 bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-full blur-3xl opacity-60" />
          <div className="absolute -bottom-20 -right-20 w-40 h-40 bg-gradient-to-br from-blue-100 to-cyan-100 dark:from-blue-900/20 dark:to-cyan-900/20 rounded-full blur-3xl opacity-60" />

          <div className="relative bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl border border-gray-200/50 dark:border-gray-700/50 rounded-2xl p-12 md:p-16 text-center shadow-xl shadow-gray-200/50 dark:shadow-gray-900/50">
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/25">
              <Database className="h-10 w-10 text-white" />
            </div>
            <h3 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-3">
              No Project Selected
            </h3>
            <p className="text-gray-500 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
              Select a project and version from the dropdowns above to view and query data records
            </p>

            <div className="mt-8 pt-6 border-t border-gray-100 dark:border-gray-700/50">
              <p className="text-xs text-gray-400 dark:text-gray-500 flex items-center justify-center gap-2">
                <Info className="w-4 h-4" />
                Tip: Published versions have frozen schemas; pick a table to view records, search, or query with AI
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedTable) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="relative bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border border-gray-200/50 dark:border-gray-700/50 rounded-2xl p-10 text-center shadow-lg max-w-md">
          <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-indigo-500/20 to-purple-600/20 dark:from-indigo-500/30 dark:to-purple-600/30 rounded-xl flex items-center justify-center">
            <Database className="h-8 w-8 text-indigo-600 dark:text-indigo-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Select a table</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Select a table from the left to view records, search, or query with AI.
          </p>
        </div>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col h-full overflow-hidden p-4">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-white">{selectedTable.className}</h3>
          {count !== null && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{count} record{count !== 1 ? 's' : ''}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <Switch
              checked={showDeleted}
              onCheckedChange={(checked) => setShowDeleted(checked)}
            />
            <span>Show deleted</span>
          </label>
          <button
            type="button"
            onClick={handleViewAll}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <List className="w-4 h-4" />
            View all records
          </button>
          <div className="inline-flex items-center gap-2">
            <input
              type="text"
              placeholder="Search..."
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white min-w-[160px]"
            />
            <button
              type="button"
              onClick={handleSearch}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              <Search className="w-4 h-4" />
              Search
            </button>
          </div>
          {!isReadOnly && (
            <button
              type="button"
              onClick={() => setInsertModalOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 text-sm text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/50"
            >
              <Plus className="w-4 h-4" />
              Insert
            </button>
          )}
        </div>
      </div>

      {(viewMode === 'viewAll' || viewMode === 'search') && (
        <div className="flex-1 flex flex-col min-h-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-4 text-sm text-gray-500">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No records found.</div>
          ) : (
            <>
              <div className="flex-1 overflow-auto p-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-600">
                      <SortHeader label="OID" column="record_id" currentSortBy={sortBy} currentSortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Created" column="created_at" currentSortBy={sortBy} currentSortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Updated" column="updated_at" currentSortBy={sortBy} currentSortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Seq" column="record_sequence" currentSortBy={sortBy} currentSortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Last action" column="last_action" currentSortBy={sortBy} currentSortDir={sortDir} onSort={handleSort} />
                      <th className="text-left py-2 px-2 font-medium text-gray-700 dark:text-gray-300 max-w-[200px]">Data</th>
                      <th className="text-left py-2 px-2 font-medium text-gray-700 dark:text-gray-300 w-0" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const isDeleted = row.last_action === 'deleted';
                      return (
                      <tr
                        key={row.record_id}
                        className={`border-b border-gray-100 dark:border-gray-700 ${isDeleted ? 'bg-gray-50 dark:bg-gray-800/50 opacity-90' : ''}`}
                      >
                        <td className="py-2 px-2 font-mono text-xs text-gray-600 dark:text-gray-400">{row.record_id}</td>
                        <td className="py-2 px-2 text-gray-600 dark:text-gray-400 whitespace-nowrap">{formatDateTime(row.created_at)}</td>
                        <td className="py-2 px-2 text-gray-600 dark:text-gray-400 whitespace-nowrap">{formatDateTime(row.updated_at)}</td>
                        <td className="py-2 px-2 text-gray-600 dark:text-gray-400">{row.record_sequence ?? '—'}</td>
                        <td className="py-2 px-2 text-gray-600 dark:text-gray-400">
                          {row.last_action ?? '—'}
                          {isDeleted && (
                            <span className="ml-1.5 inline-flex items-center rounded-md bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                              Deleted
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 max-w-[200px]">
                          <span className="text-xs text-gray-700 dark:text-gray-300 truncate block" title={JSON.stringify(row.data)}>
                            {truncateDataPreview(row.data, DATA_PREVIEW_MAX_LEN)}
                          </span>
                        </td>
                        <td className="py-2 px-2">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setViewRecord(row)}
                              className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                            >
                              <FileJson className="w-3.5 h-3.5" />
                              View
                            </button>
                            {!isReadOnly && !isDeleted && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setEditRecordId(row.record_id)}
                                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 text-xs text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40"
                                  title="Edit record"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDelete(row.record_id)}
                                disabled={deletingId === row.record_id}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
                                title="Delete record (data stored in event log for restore)"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </button>
                              </>
                            )}
                            {!isReadOnly && isDeleted && (
                              <button
                                type="button"
                                onClick={() => handleRestore(row.record_id)}
                                disabled={restoringId === row.record_id}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
                                title="Restore deleted record"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                Restore
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between gap-2 p-2 border-t border-gray-200 dark:border-gray-700">
                  <button
                    type="button"
                    onClick={() => handlePageChange(page - 1)}
                    disabled={page <= 1}
                    className="px-3 py-1 text-sm rounded border border-gray-200 dark:border-gray-600 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => handlePageChange(page + 1)}
                    disabled={page >= totalPages}
                    className="px-3 py-1 text-sm rounded border border-gray-200 dark:border-gray-600 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {viewMode === 'none' && (
        <div className="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
          Click &quot;View all records&quot; or &quot;Search&quot; to load data.
        </div>
      )}

      {classSchemaId && (
        <InsertStubModal
          open={insertModalOpen || Boolean(editRecordId)}
          onClose={() => {
            setInsertModalOpen(false);
            setEditRecordId(null);
          }}
          tableName={selectedTable.className}
          classSchemaId={classSchemaId}
          recordId={editRecordId}
          onInserted={() => {
            loadCount();
            if (viewMode === 'viewAll') runQuery({ classSchemaId }, 1, PAGE_SIZE, undefined, sortBy, sortDir);
            if (viewMode === 'search') runQuery({ classSchemaId }, 1, PAGE_SIZE, searchQ, sortBy, sortDir);
            if (classSchemaId) refreshTableCount(classSchemaId);
          }}
          onUpdated={() => {
            loadCount();
            if (viewMode === 'viewAll') runQuery({ classSchemaId }, page, PAGE_SIZE, undefined, sortBy, sortDir);
            if (viewMode === 'search') runQuery({ classSchemaId }, page, PAGE_SIZE, searchQ, sortBy, sortDir);
            if (classSchemaId) refreshTableCount(classSchemaId);
            setEditRecordId(null);
          }}
        />
      )}
      <Dialog open={!!viewRecord} onOpenChange={(open) => !open && setViewRecord(null)}>
        <DialogContent className="h-[70vh] max-h-[70vh] w-[90vw] max-w-4xl flex flex-col gap-4" showCloseButton aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Record — {viewRecord?.record_id ?? ''}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 flex-1 min-h-0">
            <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 pb-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">View:</span>
              <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-600 p-0.5 bg-gray-50 dark:bg-gray-800/50">
                <button
                  type="button"
                  onClick={() => setRecordViewTab('current')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    recordViewTab === 'current'
                      ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  Current
                </button>
                <button
                  type="button"
                  onClick={() => setRecordViewTab('historical')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    recordViewTab === 'historical'
                      ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  Historical
                </button>
              </div>
            </div>
            {recordViewTab === 'current' && viewRecord && (
              <>
                <div className="shrink-0 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Record sequence</span>
                    <p className="font-medium text-gray-900 dark:text-white">{viewRecord.record_sequence ?? '—'}</p>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Created</span>
                    <p className="font-medium text-gray-900 dark:text-white whitespace-nowrap">{formatDateTime(viewRecord.created_at)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Updated</span>
                    <p className="font-medium text-gray-900 dark:text-white whitespace-nowrap">{formatDateTime(viewRecord.updated_at)}</p>
                  </div>
                </div>
                <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700" style={{ height: '55vh' }}>
                  <MonacoEditor
                  height="100%"
                  language="json"
                  theme="vs-dark"
                  value={JSON.stringify(viewRecord.data, null, 2)}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: CODE_EDITOR_FONT_SIZE,
                    wordWrap: 'on',
                  }}
                />
                </div>
              </>
            )}
            {recordViewTab === 'historical' && (
              <div className="flex-1 flex gap-3 min-h-0">
                <div className="w-56 shrink-0 flex flex-col gap-1 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <div className="px-2 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                    Events
                  </div>
                  {recordHistoryLoading ? (
                    <div className="p-3 text-sm text-gray-500">Loading…</div>
                  ) : recordHistory.length === 0 ? (
                    <div className="p-3 text-sm text-gray-500">No history</div>
                  ) : (
                    <div className="overflow-auto flex-1 min-h-0 p-1">
                      {recordHistory.map((evt, idx) => (
                        <button
                          key={evt.record_sequence}
                          type="button"
                          onClick={() => setSelectedHistoryIndex(idx)}
                          className={`w-full text-left px-2 py-1.5 rounded text-sm truncate block ${
                            selectedHistoryIndex === idx
                              ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50'
                          }`}
                          title={`#${evt.record_sequence} ${evt.action} — ${formatDateTime(evt.created_at)}`}
                        >
                          <span className="font-medium">#{evt.record_sequence}</span> {evt.action}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-2 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                  {recordHistory.length > 0 && recordHistory[selectedHistoryIndex] && (
                    <>
                      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700 text-sm">
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">Sequence</span>
                          <p className="font-medium text-gray-900 dark:text-white">{recordHistory[selectedHistoryIndex].record_sequence}</p>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">Action</span>
                          <p className="font-medium text-gray-900 dark:text-white capitalize">{recordHistory[selectedHistoryIndex].action}</p>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">Created at</span>
                          <p className="font-medium text-gray-900 dark:text-white whitespace-nowrap">{formatDateTime(recordHistory[selectedHistoryIndex].created_at)}</p>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">Created by</span>
                          <p className="font-mono text-xs text-gray-900 dark:text-white truncate" title={recordHistory[selectedHistoryIndex].created_by ?? undefined}>
                            {recordHistory[selectedHistoryIndex].created_by ?? '—'}
                          </p>
                        </div>
                      </div>
                      <div className="flex-1 min-h-0 flex flex-col" style={{ height: '50vh' }}>
                        <MonacoEditor
                          height="100%"
                          language="json"
                          theme="vs-dark"
                          value={JSON.stringify(recordHistory[selectedHistoryIndex].data, null, 2)}
                          options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            fontSize: CODE_EDITOR_FONT_SIZE,
                            wordWrap: 'on',
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
