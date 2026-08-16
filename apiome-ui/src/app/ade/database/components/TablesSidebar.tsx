'use client';

import * as React from 'react';
import { Database, FileCode, Search } from 'lucide-react';
import { useDatabase } from '../DatabaseContext';
import SchemaViewModal from './SchemaViewModal';
import SidebarShell, { SidebarSectionLabel } from '../../../components/sidebar/SidebarShell';
import SidebarDensityToggle from '../../../components/sidebar/SidebarDensityToggle';
import { sidebarTheme, useSidebarTokens } from '../../../components/sidebar/sidebar-theme';

interface TableRow {
  class_schema_id: string;
  class_id: string;
  class_name: string;
  schema: Record<string, unknown>;
}

export default function TablesSidebar() {
  const { selectedVersionId, selectedTable, setSelectedTable, refreshTableCountRef } = useDatabase();
  const tokens = useSidebarTokens();
  const [tables, setTables] = React.useState<TableRow[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(false);
  const [countsLoading, setCountsLoading] = React.useState(false);
  const [schemaModalRow, setSchemaModalRow] = React.useState<TableRow | null>(null);
  const [filter, setFilter] = React.useState('');

  const refreshCountForClass = React.useCallback((classSchemaId: string) => {
    fetch(`/api/database/snapshot/count?classSchemaId=${encodeURIComponent(classSchemaId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && typeof data.count === 'number') {
          setCounts((prev) => ({ ...prev, [classSchemaId]: data.count }));
        }
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    refreshTableCountRef.current = refreshCountForClass;
    return () => {
      refreshTableCountRef.current = null;
    };
  }, [refreshTableCountRef, refreshCountForClass]);

  React.useEffect(() => {
    if (!selectedVersionId) {
      setTables([]);
      setCounts({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/database/versions/${selectedVersionId}/tables`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success && data.tables) {
          setTables(data.tables);
          const ids = (data.tables as TableRow[]).map((t) => t.class_schema_id);
          if (ids.length > 0) {
            setCountsLoading(true);
            fetch(`/api/database/snapshot/counts?classSchemaIds=${ids.map(encodeURIComponent).join(',')}`)
              .then((r2) => r2.json())
              .then((data2) => {
                if (cancelled) return;
                if (data2.success && data2.counts) setCounts(data2.counts);
              })
              .catch(() => { if (!cancelled) setCounts({}); })
              .finally(() => { if (!cancelled) setCountsLoading(false); });
          } else {
            setCounts({});
          }
        } else {
          setTables([]);
          setCounts({});
        }
      })
      .catch(() => { if (!cancelled) setTables([]); setCounts({}); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedVersionId]);

  const handleTableClick = (row: TableRow) => {
    setSelectedTable({ classSchemaId: row.class_schema_id, className: row.class_name });
  };

  const openSchemaModal = (e: React.MouseEvent, row: TableRow) => {
    e.stopPropagation();
    setSchemaModalRow(row);
  };

  const closeSchemaModal = () => setSchemaModalRow(null);

  const filteredTables = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.class_name.toLowerCase().includes(q));
  }, [tables, filter]);

  const totalRowCount = React.useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0),
    [counts]
  );

  return (
    <SidebarShell
      icon={<Database />}
      title="Tables"
      subtitle={
        loading
          ? 'Loading…'
          : tables.length === 0
            ? 'No published schemas'
            : `${tables.length} table${tables.length === 1 ? '' : 's'} · ${totalRowCount.toLocaleString()} rows`
      }
      toolbar={
        tables.length > 0 ? (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tables…"
              className={[
                'w-full pl-7 pr-2 text-xs rounded-md border transition-colors',
                tokens.inputPaddingY,
                sidebarTheme.inputBase,
              ].join(' ')}
            />
          </div>
        ) : undefined
      }
      footer={<SidebarDensityToggle />}
    >
      <div className={tokens.sectionPadding}>
        {loading ? (
          <div className={['py-2 text-xs', sidebarTheme.textSecondary].join(' ')}>Loading tables…</div>
        ) : tables.length === 0 ? (
          <div
            className={[
              'rounded-md border border-dashed py-6 px-3 text-center',
              sidebarTheme.borderSoft,
              sidebarTheme.textSecondary,
              'text-xs',
            ].join(' ')}
          >
            Publish a version to see class schemas.
          </div>
        ) : filteredTables.length === 0 ? (
          <div className={['py-2 text-xs', sidebarTheme.textSecondary].join(' ')}>
            No tables match &quot;{filter}&quot;
          </div>
        ) : (
          <>
            <SidebarSectionLabel
              trailing={filter ? `${filteredTables.length} / ${tables.length}` : undefined}
            >
              Class schemas
            </SidebarSectionLabel>
            <ul className={['flex flex-col', tokens.rowGap].join(' ')}>
              {filteredTables.map((row) => {
                const isSelected = selectedTable?.classSchemaId === row.class_schema_id;
                const count = counts[row.class_schema_id];
                const showCount = typeof count === 'number';
                return (
                  <li key={row.class_schema_id}>
                    <div
                      className={[
                        'group relative flex items-center w-full rounded-md transition-colors',
                        isSelected
                          ? `${sidebarTheme.rowSelected} ${sidebarTheme.rowSelectedRing}`
                          : `${sidebarTheme.textPrimary} ${sidebarTheme.hover}`,
                      ].join(' ')}
                    >
                      {isSelected && (
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r bg-indigo-500"
                          aria-hidden
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => handleTableClick(row)}
                        className={[
                          'flex-1 min-w-0 text-left flex items-center gap-2',
                          tokens.rowPaddingX,
                          tokens.rowPaddingY,
                          tokens.rowText,
                          isSelected ? 'font-medium' : '',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'shrink-0 w-1.5 h-1.5 rounded-full',
                            isSelected ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-700',
                          ].join(' ')}
                          aria-hidden
                        />
                        <span className="truncate flex-1 min-w-0">{row.class_name}</span>
                        {countsLoading && !showCount && (
                          <span className={['shrink-0 text-2xs', sidebarTheme.textTertiary].join(' ')}>…</span>
                        )}
                        {showCount && (
                          <span
                            className={[
                              'shrink-0 px-1.5 py-0.5 rounded text-2xs font-semibold tabular-nums',
                              isSelected
                                ? 'bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
                            ].join(' ')}
                          >
                            {count.toLocaleString()}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => openSchemaModal(e, row)}
                        className={[
                          'shrink-0 mr-1 p-1.5 rounded-md transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100',
                          'text-slate-400 dark:text-slate-500',
                          'hover:text-indigo-600 dark:hover:text-indigo-400',
                          'hover:bg-indigo-50 dark:hover:bg-indigo-950/40',
                          isSelected ? 'opacity-100' : '',
                        ].join(' ')}
                        title="View JSON Schema"
                        aria-label={`View JSON Schema for ${row.class_name}`}
                      >
                        <FileCode className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <SchemaViewModal
        open={schemaModalRow != null}
        onClose={closeSchemaModal}
        className={schemaModalRow?.class_name ?? ''}
        schema={schemaModalRow?.schema ?? null}
      />
    </SidebarShell>
  );
}
