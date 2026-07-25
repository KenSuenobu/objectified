'use client';

/**
 * CatalogImportReimportDelta (IXH-3.4, #5106) — what a re-import would change.
 *
 * Re-importing an updated document into an existing catalog item creates a new revision
 * whose diff was previously only inspectable *afterwards*. This section renders the
 * server-computed re-import delta the preview manifest carries (canonical models diffed
 * by stable key — never raw text) while cancelling is still free:
 *
 *  - an explicit **no-op banner** when the fingerprints match — importing again would
 *    create an empty revision — with a "Skip this import" exit;
 *  - the target item, and added / removed / changed **counts** (symbol + label + number,
 *    never colour alone);
 *  - the **classifier line**: which breaking-change classifier graded the diff (with a
 *    "structural baseline" note when it is not a format-specific pack) — or an explicit
 *    statement that changes are NOT graded, so absence of annotation never reads as
 *    safety;
 *  - entries **grouped by entity family** (Services / Operations / Channels / Types /
 *    Document) as disclosures, each entry with its change chip, severity badge and
 *    rationale when graded, and a click-through that reveals the entity in the IXH-3.2
 *    tree (`onRevealEntity`).
 *
 * Renders nothing at all for a first-time import (`delta` null) — the clean-skip AC.
 */

import { useState } from 'react';
import { ChevronRight, CircleSlash, GitCompareArrows } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import {
  groupReimportEntries,
  REIMPORT_CHANGE_KINDS,
  REIMPORT_CHANGE_SYMBOL,
  REIMPORT_CHANGE_TONE,
  REIMPORT_SEVERITY_TONE,
  type ImportReimportDelta,
  type ImportReimportDeltaEntry,
  type ReimportChangeKind,
} from '@/app/utils/import-preview-manifest';

export interface CatalogImportReimportDeltaProps {
  /** The server-computed delta; null renders nothing (a first-time import). */
  delta: ImportReimportDelta | null;
  /** Abandon the import from the no-op banner ("offer to skip the commit"). */
  onSkipCommit?: () => void;
  /** Reveal an entity (by its stable canonical key) in the preview tree. */
  onRevealEntity?: (key: string) => void;
}

/** A change-kind chip: symbol + label (+ optional count), colour supplemental. */
function ChangeChip({ kind, count }: { kind: ReimportChangeKind; count?: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
        REIMPORT_CHANGE_TONE[kind],
      )}
    >
      <span aria-hidden>{REIMPORT_CHANGE_SYMBOL[kind]}</span>
      {kind}
      {typeof count === 'number' ? <span className="tabular-nums">{count}</span> : null}
    </span>
  );
}

export function CatalogImportReimportDelta({
  delta,
  onSkipCommit,
  onRevealEntity,
}: CatalogImportReimportDeltaProps) {
  // Families with few entries default open; state tracks explicit toggles by family key.
  const [closedFamilies, setClosedFamilies] = useState<Set<string>>(new Set());

  if (!delta) return null;

  const groups = groupReimportEntries(delta);
  const graded = Boolean(delta.classifier);
  const targetLabel = delta.target_item_name || delta.target_item_slug;

  const toggleFamily = (family: string) => {
    setClosedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  };

  return (
    <section
      className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
      data-testid="import-reimport-delta"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitCompareArrows className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          Re-import delta
        </h4>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          against <span className="font-medium">{targetLabel}</span>
          {delta.current_version_record_id ? ' (current revision)' : ''}
        </span>
        {!delta.noop && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5" data-testid="import-reimport-counts">
            {REIMPORT_CHANGE_KINDS.map((kind) => (
              <ChangeChip key={kind} kind={kind} count={delta.counts[kind] ?? 0} />
            ))}
          </span>
        )}
      </div>

      {delta.noop ? (
        <div
          role="status"
          data-testid="import-reimport-noop"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-700 dark:bg-sky-950/30 dark:text-sky-200"
        >
          <CircleSlash className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            This document is identical to the current revision (fingerprint{' '}
            <span className="font-mono">{delta.candidate_fingerprint.slice(0, 12)}…</span>) —
            importing again would create an empty revision.
          </span>
          {onSkipCommit && (
            <Button variant="outline" onClick={onSkipCommit} data-testid="import-reimport-skip">
              Skip this import
            </Button>
          )}
        </div>
      ) : (
        <>
          <p
            className="text-[11px] text-gray-500 dark:text-gray-400"
            data-testid="import-reimport-classifier"
          >
            {graded ? (
              <>
                Graded by <span className="font-mono">{delta.classifier}</span>
                {!delta.classifier_format_pack && ' (structural baseline, not a format-specific ruleset)'}
                {delta.overall_severity ? (
                  <>
                    {' — worst change: '}
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 font-semibold',
                        REIMPORT_SEVERITY_TONE[delta.overall_severity],
                      )}
                    >
                      {delta.overall_severity}
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <>
                Changes are <strong>not</strong> graded for breaking risk — no classifier verdict
                is available for this format. Review each change yourself before importing.
              </>
            )}
          </p>

          <div className="space-y-2">
            {groups.map((group) => {
              const open = !closedFamilies.has(group.family);
              return (
                <div
                  key={group.family}
                  className="rounded-lg border border-gray-100 dark:border-gray-800"
                  data-testid={`import-reimport-family-${group.family}`}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleFamily(group.family)}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
                  >
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform',
                        open && 'rotate-90',
                      )}
                      aria-hidden
                    />
                    <span className="font-semibold text-gray-800 dark:text-gray-100">
                      {group.label}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {REIMPORT_CHANGE_KINDS.filter((kind) => group.counts[kind] > 0).map(
                        (kind) => (
                          <ChangeChip key={kind} kind={kind} count={group.counts[kind]} />
                        ),
                      )}
                    </span>
                  </button>
                  {open && (
                    <ul className="border-t border-gray-100 px-2.5 py-1.5 dark:border-gray-800">
                      {group.entries.map((entry) => (
                        <DeltaEntryRow
                          key={`${entry.change}:${entry.key}`}
                          entry={entry}
                          onRevealEntity={onRevealEntity}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** One change row: change chip, key (click-through to the tree), grade + rationale. */
function DeltaEntryRow({
  entry,
  onRevealEntity,
}: {
  entry: ImportReimportDeltaEntry;
  onRevealEntity?: (key: string) => void;
}) {
  const kind = entry.change as ReimportChangeKind;
  // A removed entity no longer exists in the candidate tree, so there is nothing to
  // reveal; added/changed entries drill down to their tree row.
  const revealable = Boolean(onRevealEntity) && entry.change !== 'removed' && entry.key !== '';
  return (
    <li
      className="flex flex-wrap items-center gap-2 py-1 text-xs"
      data-testid="import-reimport-entry"
    >
      <ChangeChip kind={kind} />
      {revealable ? (
        <button
          type="button"
          onClick={() => onRevealEntity?.(entry.key)}
          data-testid="import-reimport-reveal"
          className="font-mono text-indigo-600 underline decoration-dotted underline-offset-2 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          {entry.key || '(document root)'}
        </button>
      ) : (
        <span className="font-mono text-gray-700 dark:text-gray-200">
          {entry.key || '(document root)'}
        </span>
      )}
      {entry.severity ? (
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-semibold',
            REIMPORT_SEVERITY_TONE[entry.severity],
          )}
          data-testid="import-reimport-severity"
        >
          {entry.severity}
        </span>
      ) : null}
      {entry.rationale ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500 dark:text-gray-400">
          {entry.rationale}
        </span>
      ) : null}
    </li>
  );
}

export default CatalogImportReimportDelta;
