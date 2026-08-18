'use client';

/**
 * The merge dialog's conflict list, re-skinned by HIVE-6.3 (#5314).
 *
 * Authority: `docs/mockups/build/version-dialogs.html` §Merge branches → *Merge conflicts* —
 * a warning-framed card carrying the count sentence and the Mine/Theirs legend, a toolbar with
 * the path filter, the type filter and the two bulk pairs (shown / all), then a dense table
 * whose unresolved rows are tinted and whose Resolution cell is a badge.
 *
 * Behaviour and every string are unchanged. The paint is not: the card was framed in
 * `border-amber-200 … bg-amber-50/80`, the unresolved row tinted `bg-amber-50/90`, the
 * resolution pill switched between `bg-amber-200 text-amber-950` and `bg-slate-200
 * text-slate-900`, and the type filter was a bare `<select>` with a hand-written
 * `focus-visible:ring-indigo-500/70` skin that matched nothing else in the app. All four are
 * gone: the frame and the tint are tokens, the pill is a `Badge` taking the tone
 * `MERGE_RESOLUTION_TONE` assigns, and the filter is the `Select` primitive.
 *
 * The one measured deviation from the mockup: the unresolved row is tinted with a
 * `color-mix` of `--warn` rather than `--warn-soft` outright. `--warn-soft` is a *fill for a
 * badge*, calibrated against `--warn-fg`; used as a row background under `--fg` it measures
 * 1.1:1 on Nord — the trap the HIVE-6.2 block records — so the row takes a light wash and the
 * Unresolved badge carries the meaning.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/Select';
import { Dialog, DialogContent, DialogFooter } from '../../ui/Dialog';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import {
  MERGE_RESOLUTION_LABEL,
  MERGE_RESOLUTION_TONE,
  type MergeResolution,
} from '../version-dialogs/versionDialogsModel';
import {
  filterMergeConflictRows,
  formatMergeConflictKinds,
  mergeConflictKindSignature,
  type MergeConflictResolutionChoice,
} from '../../../../../lib/version-merge';
import { cn } from '../../../../../lib/utils';

export interface VersionMergeConflictListProps {
  conflicts: Array<{ path: string; kinds: string[] }>;
  targetBranchName: string;
  sourceBranchName: string;
  resolutions: Record<string, MergeConflictResolutionChoice | null>;
  onResolve: (path: string, choice: MergeConflictResolutionChoice) => void;
  onBulkResolve: (paths: string[], choice: MergeConflictResolutionChoice) => void;
  className?: string;
}

/** The `Select` primitive cannot take the empty string; this is the "no type filter" value. */
const ALL_KINDS = 'all';

/**
 * The resolution a row currently carries.
 *
 * @param choice What the session has stored for this path, if anything.
 * @returns The resolution — `unresolved` when nothing is stored.
 */
function resolutionOf(choice: MergeConflictResolutionChoice | null | undefined): MergeResolution {
  if (choice === 'mine' || choice === 'theirs' || choice === 'manual') return choice;
  return 'unresolved';
}

export function VersionMergeConflictList({
  conflicts,
  targetBranchName,
  sourceBranchName,
  resolutions,
  onResolve,
  onBulkResolve,
  className = '',
}: VersionMergeConflictListProps) {
  const [manualPath, setManualPath] = useState<string | null>(null);
  const [pathFilter, setPathFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<string>(ALL_KINDS);

  const kindOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of conflicts) {
      const sig = mergeConflictKindSignature(row.kinds);
      if (!map.has(sig)) {
        map.set(sig, formatMergeConflictKinds(row.kinds));
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [conflicts]);

  useEffect(() => {
    if (kindFilter === ALL_KINDS) return;
    const valid = kindOptions.some(([sig]) => sig === kindFilter);
    if (!valid) setKindFilter(ALL_KINDS);
  }, [kindFilter, kindOptions]);

  const filteredConflicts = useMemo(
    () =>
      filterMergeConflictRows(conflicts, {
        pathContains: pathFilter,
        kindSignature: kindFilter === ALL_KINDS ? 'all' : kindFilter,
      }),
    [conflicts, pathFilter, kindFilter]
  );

  const applyBulk = (paths: string[], choice: MergeConflictResolutionChoice) => {
    if (paths.length === 0) return;
    onBulkResolve(paths, choice);
  };

  if (conflicts.length === 0) return null;

  const allPaths = conflicts.map((c) => c.path);
  const shownPaths = filteredConflicts.map((c) => c.path);

  return (
    <>
      <div className={cn('vdlg-conflicts', className)}>
        <div className="vdlg-conflicts__head">
          <span className="tnt-icon-tile" data-tone="warn" aria-hidden>
            <AlertTriangle />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="vdlg-conflicts__title">Merge conflicts</h3>
            <p className="vdlg-conflicts__lede">
              {conflicts.length} path{conflicts.length !== 1 ? 's' : ''} need a resolution before apply can succeed on
              the server. Choices are stored in this session for the upcoming merge-resolution API.
            </p>
            <p className="vdlg-quiet">
              <strong>Mine</strong> = target branch <span className="mono">{targetBranchName || '—'}</span>
              {' · '}
              <strong>Theirs</strong> = source branch <span className="mono">{sourceBranchName || '—'}</span>
            </p>
          </div>
        </div>

        <div className="vdlg-conflicts__toolbar">
          <div className="vdlg-conflicts__filters">
            <div className="vdlg-field vdlg-conflicts__filter-grow">
              <label htmlFor="merge-conflict-path-filter" className="vdlg-field__label">
                Filter paths
              </label>
              <Input
                id="merge-conflict-path-filter"
                type="search"
                placeholder="Substring match on path…"
                value={pathFilter}
                onChange={(e) => setPathFilter(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="vdlg-field vdlg-conflicts__filter-kind">
              <label htmlFor="merge-conflict-kind-filter" className="vdlg-field__label">
                Conflict type
              </label>
              <Select value={kindFilter} onValueChange={setKindFilter}>
                <SelectTrigger id="merge-conflict-kind-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_KINDS}>All types</SelectItem>
                  {kindOptions.map(([sig, label]) => (
                    <SelectItem key={sig} value={sig}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="vdlg-quiet">
            Filter matches <strong>{filteredConflicts.length}</strong> of <strong>{conflicts.length}</strong> path
            {conflicts.length !== 1 ? 's' : ''}. Bulk actions for <strong>shown</strong> use this filter.
          </p>
          <div className="vdlg-conflicts__bulk">
            <span className="vdlg-caps">Bulk (shown)</span>
            <div className="vdlg-button-row">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={shownPaths.length === 0}
                onClick={() => applyBulk(shownPaths, 'mine')}
                title={`Set Target (mine) for ${shownPaths.length} path(s) matching the filter`}
                aria-label={`Bulk mine for ${shownPaths.length} path(s) matching filter`}
              >
                Mine
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={shownPaths.length === 0}
                onClick={() => applyBulk(shownPaths, 'theirs')}
                title={`Set Source (theirs) for ${shownPaths.length} path(s) matching the filter`}
                aria-label={`Bulk theirs for ${shownPaths.length} path(s) matching filter`}
              >
                Theirs
              </Button>
            </div>
            <span className="vdlg-caps">Bulk (all)</span>
            <div className="vdlg-button-row">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => applyBulk(allPaths, 'mine')}
                title={`Set Target (mine) for all ${allPaths.length} conflict path(s)`}
                aria-label={`Bulk mine for all ${allPaths.length} conflict path(s)`}
              >
                Mine
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => applyBulk(allPaths, 'theirs')}
                title={`Set Source (theirs) for all ${allPaths.length} conflict path(s)`}
                aria-label={`Bulk theirs for all ${allPaths.length} conflict path(s)`}
              >
                Theirs
              </Button>
            </div>
          </div>
        </div>

        <div className="vdlg-conflicts__scroll">
          <table className="vdlg-table">
            <thead>
              <tr>
                <th scope="col">Path</th>
                <th scope="col">Type</th>
                <th scope="col">Resolution</th>
                <th scope="col" className="vdlg-table__actions-col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((row) => {
                const choice = resolutions[row.path] ?? null;
                const resolution = resolutionOf(choice);
                return (
                  <tr key={row.path} data-unresolved={resolution === 'unresolved' || undefined}>
                    <td className="vdlg-table__path mono">{row.path}</td>
                    <td className="vdlg-table__nowrap">{formatMergeConflictKinds(row.kinds)}</td>
                    <td>
                      <Badge variant={MERGE_RESOLUTION_TONE[resolution]}>
                        {MERGE_RESOLUTION_LABEL[resolution]}
                      </Badge>
                    </td>
                    <td>
                      <div className="vdlg-button-row">
                        <Button
                          type="button"
                          size="sm"
                          variant={choice === 'mine' ? 'default' : 'outline'}
                          onClick={() => onResolve(row.path, 'mine')}
                          title={`Keep target (${targetBranchName}) at this path`}
                        >
                          Mine
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={choice === 'theirs' ? 'default' : 'outline'}
                          onClick={() => onResolve(row.path, 'theirs')}
                          title={`Take source (${sourceBranchName}) at this path`}
                        >
                          Theirs
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={choice === 'manual' ? 'secondary' : 'outline'}
                          onClick={() => {
                            onResolve(row.path, 'manual');
                            setManualPath(row.path);
                          }}
                        >
                          Manual
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={manualPath !== null} onOpenChange={(o) => !o && setManualPath(null)}>
        <DialogContent className="vdlg-dialog vdlg-dialog--sm" aria-describedby="merge-manual-desc">
          <VersionDialogHead
            icon={<AlertTriangle aria-hidden />}
            tone="warn"
            title="Manual resolution"
            description={
              <span id="merge-manual-desc">
                Path <span className="mono">{manualPath}</span> is marked for manual merge. A future release will open a
                side-by-side diff and let you submit the merged fragment to the merge session API.
              </span>
            }
          />
          <DialogFooter>
            <Button type="button" onClick={() => setManualPath(null)}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default VersionMergeConflictList;
