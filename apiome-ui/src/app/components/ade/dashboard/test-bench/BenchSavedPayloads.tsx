'use client';

/**
 * BenchSavedPayloads (IXH-5.3, #5115).
 *
 * The saved-payload list for the selected schema: name the current payload and save it, reload
 * a saved one into the editor, or delete it. Storage is browser-local and scoped to
 * **tenant + schema reference** (`schema-test-bench-saved-payloads.ts`), so the list changes
 * with the schema selection and never leaks across tenants. A payload saved from generated
 * content keeps its synthetic label.
 */

import { useId, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import type { SavedBenchPayload } from '@/app/utils/schema-test-bench-saved-payloads';

export interface BenchSavedPayloadsProps {
  /** Saved payloads for the selected (tenant, schema) scope, newest first. */
  payloads: SavedBenchPayload[];
  /** Whether saving is possible (a tenant, a schema, and a non-empty payload exist). */
  canSave: boolean;
  /** Saves the current editor payload under the given name. */
  onSave: (name: string) => void;
  /** Loads a saved payload into the editor. */
  onLoad: (payload: SavedBenchPayload) => void;
  /** Deletes a saved payload. */
  onDelete: (payload: SavedBenchPayload) => void;
}

/** Render the save form and the saved list. */
export function BenchSavedPayloads({
  payloads,
  canSave,
  onSave,
  onLoad,
  onDelete,
}: BenchSavedPayloadsProps) {
  const inputId = useId();
  const [name, setName] = useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName('');
  };

  return (
    <section className="space-y-3" aria-label="Saved payloads">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label
            htmlFor={inputId}
            className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
          >
            Save current payload as
          </label>
          <input
            id={inputId}
            data-testid="test-bench-save-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. golden order payload"
            className="w-56 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </div>
        <button
          type="button"
          data-testid="test-bench-save"
          onClick={submit}
          disabled={!canSave || name.trim() === ''}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <Save className="h-4 w-4 text-indigo-500" aria-hidden /> Save
        </button>
      </div>

      {payloads.length > 0 ? (
        <ul data-testid="test-bench-saved-list" className="space-y-1">
          {payloads.map((payload) => (
            <li
              key={payload.id}
              className="flex items-center gap-2 rounded-md border border-gray-100 px-2 py-1.5 dark:border-gray-800"
            >
              <button
                type="button"
                data-testid={`test-bench-saved-load-${payload.id}`}
                onClick={() => onLoad(payload)}
                className="min-w-0 flex-1 truncate text-left text-sm text-indigo-600 hover:underline dark:text-indigo-400"
                title="Load into the payload editor"
              >
                {payload.name}
              </button>
              {payload.synthetic ? (
                <span className="rounded bg-violet-100 px-1 text-2xs font-semibold uppercase tracking-wider text-violet-800 dark:bg-violet-900/50 dark:text-violet-300">
                  synthetic
                </span>
              ) : null}
              <span className="shrink-0 text-2xs tabular-nums text-gray-400 dark:text-gray-500">
                {new Date(payload.savedAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                data-testid={`test-bench-saved-delete-${payload.id}`}
                onClick={() => onDelete(payload)}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:hover:bg-rose-950/40"
                aria-label={`Delete saved payload ${payload.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          No saved payloads for this schema yet.
        </p>
      )}
    </section>
  );
}
