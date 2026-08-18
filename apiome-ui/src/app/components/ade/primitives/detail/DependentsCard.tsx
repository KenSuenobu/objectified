'use client';

/**
 * The dependents table of the primitive-detail page (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Dependents — the referencing type, the
 * property carrying the reference, its scope, the count in the foot, and the empty sentence.
 *
 * ### What this replaces, and what it keeps
 *
 * The same hand-built `<table>` the reference card replaced, plus a third spelling of the scope
 * pill (`bg-teal-100 text-teal-700 …` for system, `bg-indigo-100 text-indigo-700 …` for a
 * tenant) that disagreed with both the header's and the metadata aside's. All three read
 * {@link dependentScope} now.
 *
 * The counts are untouched — the ticket's third acceptance criterion. The reverse index sends
 * one entry per referencing edge (#3477), so a type that references this one from two
 * properties is two rows here and one *dependent type* in the aside; the de-duplication stays
 * where it was, in `summarizeUsage`.
 */

import * as React from 'react';
import Link from 'next/link';
import { GitMerge } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import {
  DataTable,
  DataTableFoot,
  DataTableToolbar,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import {
  dependentHref,
  type DependentRef,
} from '@/app/ade/dashboard/primitives/primitiveDetailModel';

import {
  EMPTY_VALUE,
  NO_DEPENDENTS_DESCRIPTION,
  NO_DEPENDENTS_TITLE,
  dependentLabel,
  dependentScope,
  dependentsFootLabel,
} from './primitiveDetailView';

export interface DependentsCardProps {
  /** The types referencing this one, one row per referencing edge. */
  dependents: readonly DependentRef[];
  /** How this type is addressed, for the table's sub-line. */
  identity: string;
}

/** One dependent, keyed for the table. */
interface DependentRow {
  key: string;
  dep: DependentRef;
  index: number;
}

/**
 * Render the card. See {@link DependentsCardProps}.
 *
 * @returns The table of dependents, or the empty sentence in its place.
 */
export default function DependentsCard({ dependents, identity }: DependentsCardProps) {
  const rows = React.useMemo<DependentRow[]>(
    () =>
      dependents.map((dep, index) => ({
        key: `${dep.id ?? dep.schema_id ?? dep.name ?? index}-${index}`,
        dep,
        index,
      })),
    [dependents]
  );

  const columns: DataTableColumn<DependentRow>[] = [
    {
      id: 'type',
      header: 'Type',
      skeletonWidth: '12rem',
      cell: ({ dep, index }) => {
        const label = dependentLabel(dep);
        const href = dependentHref(dep);
        const name = dep.name ?? label;
        if (!href) return <span className="mono">{label}</span>;
        return (
          <Link
            href={href}
            data-testid={`dependent-link-${index}`}
            title={`View details for ${name}`}
            aria-label={`View details for ${name}`}
            className="prm-ref-link mono"
          >
            {label}
          </Link>
        );
      },
    },
    {
      id: 'property',
      header: 'Property',
      skeletonWidth: '6rem',
      cell: ({ dep }) =>
        dep.property ? (
          <span className="mono">{dep.property}</span>
        ) : (
          <span className="prm-faint">{EMPTY_VALUE}</span>
        ),
    },
    {
      id: 'scope',
      header: 'Scope',
      align: 'end',
      skeletonWidth: '7rem',
      cell: ({ dep }) => {
        const scope = dependentScope(dep);
        return <Badge variant={scope.tone}>{scope.label}</Badge>;
      },
    },
  ];

  return (
    <DataTable<DependentRow>
      caption="Dependents"
      dense
      scrollX
      columns={columns}
      rows={rows}
      getRowId={(row) => row.key}
      getRowLabel={(row) => dependentLabel(row.dep)}
      data-testid="primitive-detail-dependents"
      empty={
        <EmptyState
          icon={<GitMerge aria-hidden />}
          title={NO_DEPENDENTS_TITLE}
          description={NO_DEPENDENTS_DESCRIPTION}
          variant="compact"
        />
      }
      toolbar={
        <DataTableToolbar>
          <span className="prm-panel-head">
            <GitMerge aria-hidden />
            <span className="prm-panel-head__text">
              <h2 className="prm-panel-head__title">Dependents</h2>
              <span className="prm-panel-head__sub">
                Types referencing <span className="mono">{identity}</span>
              </span>
            </span>
          </span>
        </DataTableToolbar>
      }
      footer={
        rows.length > 0 ? (
          <DataTableFoot data-testid="primitive-detail-dependents-foot">
            <span>{dependentsFootLabel(rows.length)}</span>
          </DataTableFoot>
        ) : undefined
      }
    />
  );
}
