'use client';

/**
 * The read-only inferred-bindings preview (#5529, MSC-1.3).
 *
 * What makes an inference mode trustworthy: before anything is saved, it lists per operation which
 * response properties would take which request values. The projection is REST's
 * (`GET .../mock/operations`), computed with the same name-matching rules the runtime applies, so
 * this component only decides which of them the chosen mode actually runs and how to say it.
 */

import type { CorrelationInferenceMode } from './correlationEditorModel';
import type { MockAuthoringOperation } from './mockAuthoringModel';

export interface CorrelationBindingsPreviewProps {
  /** The version's operations, with the bindings each inference pass would make. */
  operations: MockAuthoringOperation[];
  /**
   * The mode being previewed. `path-params` runs only the name-matching pass; `inferred` also
   * echoes request-body fields back on writes.
   */
  mode: CorrelationInferenceMode;
  /** Test id for the panel root. */
  testId?: string;
}

/**
 * Render the per-operation binding list for one inference mode.
 *
 * @param props - see {@link CorrelationBindingsPreviewProps}
 * @returns the list, or the sentence explaining why there is nothing to list
 */
export function CorrelationBindingsPreview({
  operations,
  mode,
  testId,
}: CorrelationBindingsPreviewProps) {
  const shown = operations
    .map((operation) => ({
      operation,
      // `path-params` runs one pass; `inferred` runs both, in that order.
      bindings: operation.bindings.filter(
        (binding) => binding.pass === 'path-params' || mode === 'inferred'
      ),
    }))
    .filter((entry) => entry.bindings.length > 0);

  return (
    <div className="mock-corr__inferred" data-testid={testId}>
      <p className="vdlg-caps">What this binds, per operation — before you save</p>

      {operations.length === 0 ? (
        <p className="vdlg-quiet">
          This version’s operations could not be listed, so there is nothing to project. The mode
          still saves.
        </p>
      ) : shown.length === 0 ? (
        <p className="vdlg-quiet">
          Nothing would be bound automatically on this version — no response property matches a path
          parameter{mode === 'inferred' ? ' or a request-body field' : ''}. Add an explicit binding
          below to correlate anyway.
        </p>
      ) : (
        <ul className="mock-corr__inferred-list">
          {shown.map(({ operation, bindings }) => (
            <li key={operation.key} className="mock-corr__inferred-op">
              <span className="mono mock-corr__inferred-key">{operation.key}</span>
              <ul className="mock-corr__inferred-rows">
                {bindings.map((binding) => (
                  <li key={`${binding.pointer}-${binding.source}`}>
                    <span className="mono">{binding.pointer}</span>
                    <span aria-hidden> ← </span>
                    <span className="sr-only">takes</span>
                    <span className="mono">{binding.source}</span>
                    {binding.repeated && (
                      <span className="mock-corr__inferred-note"> (every array member)</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
