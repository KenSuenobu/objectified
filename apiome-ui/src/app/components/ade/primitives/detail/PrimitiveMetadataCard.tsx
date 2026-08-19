'use client';

/**
 * The metadata aside of the primitive-detail page (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Metadata — `$id`, scope, namespace,
 * version root, owner, source, created and mutability, in that order.
 *
 * ### Three decisions
 *
 * 1. **Label above value, not beside it.** The mockup's `kv--stack`, and for a reason worth
 *    stating: four of these eight values are identifiers with no spaces in them — an `$id` URL,
 *    a namespace path — and a two-column row gives such a value half a narrow aside to break
 *    in. Stacked, it has the whole card.
 * 2. **The order lives in {@link metadataRows}, not here.** Two of the eight rows are drawn
 *    rather than printed — a badge and a lock — and a model that held only the printed six would
 *    leave this component to append those two at the end, which is not where the mockup puts
 *    Scope. Each row carries a `kind` instead, and this file only knows how to draw one.
 * 3. **The mockup's closing callout is not ported.** It reads "System types show a *System ·
 *    core* badge, an amber *immutable (core)* lock, and disabled Edit" — documentation of the
 *    other variant for the reader of the mockup. This page renders the state the type is
 *    actually in, which is the acceptance criterion; a sentence describing a state the reader
 *    cannot see is furniture.
 */

import * as React from 'react';
import { Info, Lock, Pencil } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/app/components/ui/Card';

import { metadataRows, mutability, type MetadataRow } from './primitiveDetailView';

export interface PrimitiveMetadataCardProps {
  /** Whether the type is system-core — the scope badge and the lock. */
  isSystem: boolean;
  /** The `$id` the type is addressed by. */
  schemaId?: string | null;
  /** Its effective namespace, derived from the `$id` or the stored column. */
  namespace: string | null;
  /** The version-root segment read out of the namespace or the base URI. */
  versionRoot: string | null;
  /** The owning principal — `system`, a tenant slug, or `tenant`. */
  owner: string;
  /** How the type arrived: `human`, `import`, `system`. */
  source?: string;
  /** When the row was written. */
  createdAt?: string | null;
}

/**
 * One row's `dd`, drawn the way its `kind` asks.
 *
 * @param props.row The row.
 * @param props.isSystem Whether the type is system-core, for the two drawn rows.
 * @returns The value: a printed string, a scope badge, or the mutability lock.
 */
function MetadataValue({ row, isSystem }: { row: MetadataRow; isSystem: boolean }) {
  const testId = `primitive-detail-meta-${row.id}`;

  if (row.kind === 'scope') {
    return (
      <dd>
        <Badge variant={isSystem ? 'accent' : 'ok'} data-testid={testId}>
          {row.value}
        </Badge>
      </dd>
    );
  }

  if (row.kind === 'mutability') {
    return (
      <dd>
        {/* The lock is the mark and the words are the message — `--warn` measures only 2.82:1 on
            the surface in Solarized, so the tone cannot carry this alone. */}
        <span className="prm-lock" data-testid={testId}>
          {mutability(isSystem).locked ? <Lock aria-hidden /> : <Pencil aria-hidden />}
          {row.value}
        </span>
      </dd>
    );
  }

  return (
    <dd className={row.mono ? 'mono' : undefined} data-testid={testId}>
      {row.value}
    </dd>
  );
}

/**
 * Render the aside. See {@link PrimitiveMetadataCardProps}.
 *
 * @returns The card: the eight rows, in the mockup's order.
 */
export default function PrimitiveMetadataCard({
  isSystem,
  schemaId,
  namespace,
  versionRoot,
  owner,
  source,
  createdAt,
}: PrimitiveMetadataCardProps) {
  const rows = metadataRows({ isSystem, schemaId, namespace, versionRoot, owner, source, createdAt });

  return (
    <Card data-testid="primitive-detail-metadata">
      <CardHeader className="pd-head">
        <h2 className="prm-panel-head__title">
          <Info aria-hidden />
          Metadata
        </h2>
      </CardHeader>
      <CardBody>
        <dl className="pd-kv">
          {rows.map((row) => (
            <div key={row.id}>
              <dt>{row.label}</dt>
              <MetadataValue row={row} isSystem={isSystem} />
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}
