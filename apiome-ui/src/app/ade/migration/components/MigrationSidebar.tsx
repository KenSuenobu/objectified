'use client';

import * as React from 'react';
import { GitCompareArrows, AlertCircle, CheckCircle2, Search } from 'lucide-react';
import { useMigration } from '../MigrationContext';
import SidebarShell, { SidebarSectionLabel } from '../../../components/sidebar/SidebarShell';
import SidebarDensityToggle from '../../../components/sidebar/SidebarDensityToggle';
import { sidebarTheme, useSidebarTokens } from '../../../components/sidebar/sidebar-theme';

/** Normalize object for comparison by sorting keys (so key order doesn't affect equality). */
function normalizeForCompare(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = normalizeForCompare(obj[k]);
  }
  return sorted;
}

function schemaEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

export default function MigrationSidebar() {
  const {
    selectedProjectId,
    fromVersionId,
    toVersionId,
    fromTables,
    toTables,
    setFromTables,
    setToTables,
    selectedClassName,
    setSelectedClassName,
    ruleCountsVersion,
  } = useMigration();
  const tokens = useSidebarTokens();
  const [loading, setLoading] = React.useState(false);
  const [ruleCounts, setRuleCounts] = React.useState<Record<string, number>>({});
  const [filter, setFilter] = React.useState('');

  React.useEffect(() => {
    if (!fromVersionId || !toVersionId || fromVersionId === toVersionId) {
      setFromTables([]);
      setToTables([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`/api/database/versions/${fromVersionId}/tables`).then((r) => r.json()),
      fetch(`/api/database/versions/${toVersionId}/tables`).then((r) => r.json()),
    ])
      .then(([fromRes, toRes]) => {
        if (cancelled) return;
        setFromTables(fromRes.success && fromRes.tables ? fromRes.tables : []);
        setToTables(toRes.success && toRes.tables ? toRes.tables : []);
      })
      .catch(() => {
        if (!cancelled) {
          setFromTables([]);
          setToTables([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [fromVersionId, toVersionId, setFromTables, setToTables]);

  React.useEffect(() => {
    if (!selectedProjectId || !fromVersionId || !toVersionId || fromVersionId === toVersionId) {
      setRuleCounts({});
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      projectId: selectedProjectId,
      fromVersionId,
      toVersionId,
    });
    fetch(`/api/migration-plans/counts?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success && data.counts && typeof data.counts === 'object') {
          setRuleCounts(data.counts as Record<string, number>);
        } else if (!cancelled) {
          setRuleCounts({});
        }
      })
      .catch(() => {
        if (!cancelled) setRuleCounts({});
      });
    return () => { cancelled = true; };
  }, [selectedProjectId, fromVersionId, toVersionId, ruleCountsVersion]);

  const combinedList = React.useMemo(() => {
    const byName = new Map<string, { fromSchema?: Record<string, unknown>; toSchema?: Record<string, unknown>; hasDifference: boolean }>();
    for (const row of fromTables) {
      const existing = byName.get(row.class_name) ?? { hasDifference: false };
      existing.fromSchema = row.schema;
      byName.set(row.class_name, existing);
    }
    for (const row of toTables) {
      const existing = byName.get(row.class_name) ?? { hasDifference: false };
      existing.toSchema = row.schema;
      byName.set(row.class_name, existing);
    }
    for (const [, entry] of byName) {
      const inFrom = entry.fromSchema !== undefined;
      const inTo = entry.toSchema !== undefined;
      if (!inFrom || !inTo) {
        entry.hasDifference = true;
      } else {
        entry.hasDifference = !schemaEquals(entry.fromSchema!, entry.toSchema!);
      }
    }
    return Array.from(byName.entries())
      .map(([class_name, { hasDifference }]) => ({ class_name, hasDifference }))
      .sort((a, b) => a.class_name.localeCompare(b.class_name));
  }, [fromTables, toTables]);

  const filteredList = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return combinedList;
    return combinedList.filter((row) => row.class_name.toLowerCase().includes(q));
  }, [combinedList, filter]);

  const diffCount = combinedList.filter((c) => c.hasDifference).length;

  return (
    <SidebarShell
      icon={<GitCompareArrows />}
      title="Classes"
      subtitle={
        loading
          ? 'Loading…'
          : combinedList.length === 0
            ? 'No classes in either version'
            : `${combinedList.length} class${combinedList.length === 1 ? '' : 'es'} · ${diffCount} differ`
      }
      toolbar={
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter classes…"
            className={[
              'w-full pl-7 pr-2 text-xs rounded-md border transition-colors',
              tokens.inputPaddingY,
              sidebarTheme.inputBase,
            ].join(' ')}
          />
        </div>
      }
      footer={<SidebarDensityToggle />}
    >
      <div className={tokens.sectionPadding}>
        {loading ? (
          <div className={['py-2', sidebarTheme.textSecondary, 'text-xs'].join(' ')}>Loading classes…</div>
        ) : combinedList.length === 0 ? (
          <div
            className={[
              'rounded-md border border-dashed py-6 px-3 text-center',
              sidebarTheme.borderSoft,
              sidebarTheme.textSecondary,
              'text-xs',
            ].join(' ')}
          >
            No classes in either version.
          </div>
        ) : filteredList.length === 0 ? (
          <div className={['py-2 text-xs', sidebarTheme.textSecondary].join(' ')}>
            No classes match &quot;{filter}&quot;
          </div>
        ) : (
          <>
            <SidebarSectionLabel
              trailing={filter ? `${filteredList.length} / ${combinedList.length}` : undefined}
            >
              Schema diff
            </SidebarSectionLabel>
            <ul className={['flex flex-col', tokens.rowGap].join(' ')}>
              {filteredList.map(({ class_name, hasDifference }) => {
                const isSelected = selectedClassName === class_name;
                const count = ruleCounts[class_name] ?? 0;
                return (
                  <li key={class_name}>
                    <button
                      type="button"
                      onClick={() => setSelectedClassName(class_name)}
                      className={[
                        'group relative flex items-center w-full text-left rounded-md transition-colors',
                        tokens.rowPaddingX,
                        tokens.rowPaddingY,
                        tokens.rowText,
                        isSelected
                          ? `${sidebarTheme.rowSelected} ${sidebarTheme.rowSelectedRing} font-medium`
                          : `${sidebarTheme.textPrimary} ${sidebarTheme.hover}`,
                      ].join(' ')}
                    >
                      {isSelected && (
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r bg-indigo-500"
                          aria-hidden
                        />
                      )}
                      <span
                        className={[
                          'shrink-0 mr-2 flex items-center justify-center w-4 h-4',
                          hasDifference
                            ? 'text-amber-500 dark:text-amber-400'
                            : 'text-emerald-500 dark:text-emerald-400',
                        ].join(' ')}
                        title={hasDifference ? 'Schema differs between versions' : 'Schemas match'}
                      >
                        {hasDifference ? (
                          <AlertCircle className="w-3.5 h-3.5" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        )}
                      </span>
                      <span className="font-medium truncate flex-1 min-w-0">{class_name}</span>
                      {count > 0 && (
                        <span
                          className={[
                            'shrink-0 ml-2 px-1.5 py-0.5 rounded text-2xs font-semibold tabular-nums',
                            isSelected
                              ? 'bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
                          ].join(' ')}
                          title={`${count} rule${count === 1 ? '' : 's'} for this class`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </SidebarShell>
  );
}
