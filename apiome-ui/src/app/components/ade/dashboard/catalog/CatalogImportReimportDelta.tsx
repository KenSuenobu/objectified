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
 *
 * Bounds (IXH-3.6, #5108): a family's entry list is **windowed** above
 * {@link DELTA_LIST_VIRTUALIZE_ABOVE} (budget in `preview-budgets.ts`) — only the rows
 * near the viewport mount, a "windowed" note states the behavior, `aria-setsize` /
 * `aria-posinset` keep the list semantics truthful, and the row holding keyboard focus is
 * pinned so windowing never drops it. Nothing is truncated: every change stays reachable
 * by scrolling, and the header chips always state the full counts. Motion is `motion-safe:`
 * so `prefers-reduced-motion` is honoured.
 */

import { useMemo, useState } from 'react';
import { ChevronRight, CircleSlash, GitCompareArrows } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { computeWindowedRange } from '@/app/utils/windowed-rows';
import { DELTA_LIST_VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';
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

/** Uniform delta-row height (px) the windowing arithmetic assumes; matches the `h-7` row class. */
const DELTA_ROW_HEIGHT = 28;

/** Height (px) of a windowed family list's viewport; matches the `h-56` container class. */
const DELTA_LIST_HEIGHT = 224;

export interface CatalogImportReimportDeltaProps {
  /** The server-computed delta; null renders nothing (a first-time import). */
  delta: ImportReimportDelta | null;
  /** Abandon the import from the no-op banner ("offer to skip the commit"). */
  onSkipCommit?: () => void;
  /** Reveal an entity (by its stable canonical key) in the preview tree. */
  onRevealEntity?: (key: string) => void;
  /** Windowing threshold override; tests pass a small value. */
  listVirtualizeAbove?: number;
  /** List viewport height override; tests pass a small value to exercise real windowing
   *  (jsdom reports element heights as 0, so the height cannot be measured). */
  listViewportHeight?: number;
}

/** A change-kind chip: symbol + label (+ optional count), colour supplemental. */
function ChangeChip({ kind, count }: { kind: ReimportChangeKind; count?: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-semibold',
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
  listVirtualizeAbove = DELTA_LIST_VIRTUALIZE_ABOVE,
  listViewportHeight = DELTA_LIST_HEIGHT,
}: CatalogImportReimportDeltaProps) {
  // Families with few entries default open; state tracks explicit toggles by family key.
  const [closedFamilies, setClosedFamilies] = useState<Set<string>>(new Set());

  const groups = useMemo(() => (delta ? groupReimportEntries(delta) : []), [delta]);

  if (!delta) return null;

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
      className="space-y-3 rounded-lg border border-border p-3"
      data-testid="import-reimport-delta"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitCompareArrows className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg">
          Re-import delta
        </h4>
        <span className="text-2xs text-fg-muted">
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
          className="flex flex-wrap items-center gap-3 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-xs text-accent-fg"
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
            className="text-2xs text-fg-muted"
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
              const windowed = group.entries.length > listVirtualizeAbove;
              return (
                <div
                  key={group.family}
                  className="rounded-lg border border-border"
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
                        'h-3.5 w-3.5 shrink-0 text-fg-subtle motion-safe:transition-transform',
                        open && 'rotate-90',
                      )}
                      aria-hidden
                    />
                    <span className="font-semibold text-fg">
                      {group.label}
                    </span>
                    {windowed && (
                      <span
                        className="text-2xs font-normal text-fg-muted"
                        data-testid="import-reimport-windowed"
                      >
                        windowed
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1.5">
                      {REIMPORT_CHANGE_KINDS.filter((kind) => group.counts[kind] > 0).map(
                        (kind) => (
                          <ChangeChip key={kind} kind={kind} count={group.counts[kind]} />
                        ),
                      )}
                    </span>
                  </button>
                  {open && (
                    <FamilyEntriesList
                      family={group.family}
                      label={group.label}
                      entries={group.entries}
                      onRevealEntity={onRevealEntity}
                      windowed={windowed}
                      viewportHeight={listViewportHeight}
                    />
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

/**
 * One family's entry list. Above the windowing budget only the rows near the viewport
 * mount (spacer elements keep the scrollbar's true length), and the row holding keyboard
 * focus is pinned — rendered absolutely at its true offset — so focus never unmounts.
 */
function FamilyEntriesList({
  family,
  label,
  entries,
  onRevealEntity,
  windowed,
  viewportHeight,
}: {
  family: string;
  label: string;
  entries: ImportReimportDeltaEntry[];
  onRevealEntity?: (key: string) => void;
  windowed: boolean;
  viewportHeight: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const rowWindow = windowed
    ? computeWindowedRange({
        rowCount: entries.length,
        rowHeight: DELTA_ROW_HEIGHT,
        viewportHeight,
        scrollTop,
      })
    : { startIndex: 0, endIndex: entries.length, paddingTop: 0, paddingBottom: 0 };
  const pinnedIndex =
    windowed &&
    focusedIndex !== null &&
    focusedIndex < entries.length &&
    (focusedIndex < rowWindow.startIndex || focusedIndex >= rowWindow.endIndex)
      ? focusedIndex
      : null;

  const renderEntry = (entry: ImportReimportDeltaEntry, index: number, pinned: boolean) => (
    <DeltaEntryRow
      key={`${entry.change}:${entry.key}`}
      entry={entry}
      onRevealEntity={onRevealEntity}
      setSize={entries.length}
      posInSet={index + 1}
      onFocusRow={() => setFocusedIndex(index)}
      style={
        pinned
          ? { position: 'absolute', top: index * DELTA_ROW_HEIGHT, left: 0, right: 0 }
          : undefined
      }
    />
  );

  return (
    <div
      className={cn('border-t border-border px-2.5 py-1.5', windowed && 'overflow-y-auto')}
      style={windowed ? { height: viewportHeight } : undefined}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      tabIndex={windowed ? 0 : undefined}
      role={windowed ? 'region' : undefined}
      aria-label={windowed ? `${label} changes (${entries.length}, windowed)` : undefined}
      data-testid={`import-reimport-entries-${family}`}
    >
      <ul className="relative">
        {rowWindow.paddingTop > 0 && (
          <li aria-hidden style={{ height: rowWindow.paddingTop }} />
        )}
        {entries
          .slice(rowWindow.startIndex, rowWindow.endIndex)
          .map((entry, offset) => renderEntry(entry, rowWindow.startIndex + offset, false))}
        {rowWindow.paddingBottom > 0 && (
          <li aria-hidden style={{ height: rowWindow.paddingBottom }} />
        )}
        {pinnedIndex !== null ? renderEntry(entries[pinnedIndex], pinnedIndex, true) : null}
      </ul>
    </div>
  );
}

/** One change row: change chip, key (click-through to the tree), grade + rationale. */
function DeltaEntryRow({
  entry,
  onRevealEntity,
  setSize,
  posInSet,
  onFocusRow,
  style,
}: {
  entry: ImportReimportDeltaEntry;
  onRevealEntity?: (key: string) => void;
  setSize: number;
  posInSet: number;
  onFocusRow: () => void;
  style?: React.CSSProperties;
}) {
  const kind = entry.change as ReimportChangeKind;
  // A removed entity no longer exists in the candidate tree, so there is nothing to
  // reveal; added/changed entries drill down to their tree row.
  const revealable = Boolean(onRevealEntity) && entry.change !== 'removed' && entry.key !== '';
  return (
    <li
      className="flex h-7 items-center gap-2 whitespace-nowrap text-xs"
      data-testid="import-reimport-entry"
      aria-setsize={setSize}
      aria-posinset={posInSet}
      style={style}
    >
      <ChangeChip kind={kind} />
      {revealable ? (
        <button
          type="button"
          onClick={() => onRevealEntity?.(entry.key)}
          onFocus={onFocusRow}
          data-testid="import-reimport-reveal"
          className="max-w-72 truncate font-mono text-accent underline decoration-dotted underline-offset-2 hover:text-accent-fg"
        >
          {entry.key || '(document root)'}
        </button>
      ) : (
        <span className="max-w-72 truncate font-mono text-fg">
          {entry.key || '(document root)'}
        </span>
      )}
      {entry.severity ? (
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-2xs font-semibold',
            REIMPORT_SEVERITY_TONE[entry.severity],
          )}
          data-testid="import-reimport-severity"
        >
          {entry.severity}
        </span>
      ) : null}
      {entry.rationale ? (
        <span className="min-w-0 flex-1 truncate text-2xs text-fg-muted">
          {entry.rationale}
        </span>
      ) : null}
    </li>
  );
}

export default CatalogImportReimportDelta;
