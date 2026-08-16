'use client';

/**
 * ProblemsPanel — the IDE-style per-file problems list under the review viewer (MFX-43.3, #4363).
 *
 * Lists the active file's located Verify problems (validation + lint, already filtered by
 * `problemsForFile`) the way an IDE's Problems view does: severity icon, `line:col`, message, and
 * the rule that fired. Every row is a button — clicking one reveals its line in the editor
 * (finding → editor), and a marker/line click in the editor selects its row here
 * (editor → finding), completing the MFX-43.3 round trip. Renders nothing when the file has no
 * located problems, so clean files keep the full viewer height.
 */

import { AlertTriangle, CircleX, Info } from 'lucide-react';
import { cn } from '@lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { LintSeverity } from '../../../../utils/version-lint-report';
import type { LocatedProblem } from './exportProblemMarkers';

export interface ProblemsPanelProps {
  /** The active file's located problems, in display order. */
  problems: LocatedProblem[];
  /** The highlighted problem's id (kept in sync with the editor selection), or null. */
  selectedId: string | null;
  /** Called when a row is clicked — the caller reveals the problem's line in the editor. */
  onSelect: (problem: LocatedProblem) => void;
  className?: string;
}

/** Per-severity row icon + tint, matching the shared rose/amber palette of the Verify surfaces. */
const SEVERITY_PRESENTATION: Record<LintSeverity, { icon: LucideIcon; className: string }> = {
  error: { icon: CircleX, className: 'text-rose-600 dark:text-rose-400' },
  warning: { icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-400' },
  info: { icon: Info, className: 'text-sky-600 dark:text-sky-400' },
};

/**
 * The per-file problems list. Renders nothing when there are no problems.
 *
 * @param props The file's problems, the selected row, and the row-click callback.
 * @returns The problems list, or null for a clean file.
 */
export function ProblemsPanel({ problems, selectedId, onSelect, className }: ProblemsPanelProps) {
  if (problems.length === 0) return null;
  return (
    <div
      data-testid="verify-problems"
      className={cn(
        'max-h-40 shrink-0 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700',
        className,
      )}
    >
      <div className="sticky top-0 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-800/90 dark:text-gray-400">
        Problems
        <span className="ml-1.5 tabular-nums" data-testid="verify-problems-count">
          {problems.length}
        </span>
      </div>
      <ul>
        {problems.map((problem) => {
          const { icon: Icon, className: tone } = SEVERITY_PRESENTATION[problem.severity];
          const selected = problem.id === selectedId;
          return (
            <li key={problem.id}>
              <button
                type="button"
                data-testid={`verify-problem-${problem.id}`}
                data-selected={selected}
                onClick={() => onSelect(problem)}
                title={problem.message}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs',
                  selected
                    ? 'bg-indigo-50 text-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100'
                    : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60',
                )}
              >
                <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', tone)} aria-hidden />
                <span className="min-w-0">
                  <span className="font-mono tabular-nums text-gray-500 dark:text-gray-400">
                    {problem.line}
                    {problem.column !== null ? `:${problem.column}` : ''}
                  </span>{' '}
                  <span>{problem.message}</span>
                  {problem.rule && (
                    <span className="ml-1.5 font-mono text-gray-400 dark:text-gray-500">
                      {problem.rule}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ProblemsPanel;
