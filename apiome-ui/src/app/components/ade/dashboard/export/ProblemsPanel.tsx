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

/** Per-severity row glyph. The tint is the icon's `data-severity`, painted by HIVE-8.3's block. */
const SEVERITY_ICON: Record<LintSeverity, LucideIcon> = {
  error: CircleX,
  warning: AlertTriangle,
  info: Info,
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
      className={cn('xstd-problems', className)}
    >
      <div className="xstd-problems__head">
        Problems
        <span className="ml-1.5 tabular-nums" data-testid="verify-problems-count">
          {problems.length}
        </span>
      </div>
      <ul>
        {problems.map((problem) => {
          const Icon = SEVERITY_ICON[problem.severity];
          const selected = problem.id === selectedId;
          return (
            <li key={problem.id}>
              <button
                type="button"
                data-testid={`verify-problem-${problem.id}`}
                data-selected={selected}
                onClick={() => onSelect(problem)}
                title={problem.message}
                className="xstd-problems__row"
              >
                <Icon
                  className="xstd-problems__icon"
                  data-severity={problem.severity}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="xstd-problems__at">
                    {problem.line}
                    {problem.column !== null ? `:${problem.column}` : ''}
                  </span>{' '}
                  <span>{problem.message}</span>
                  {problem.rule && (
                    <span className="xstd-problems__at ml-1.5">
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
