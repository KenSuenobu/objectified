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
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
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
    <section className="vdlg-stack" aria-label="Saved payloads">
      <div className="vdlg-bench__row vdlg-bench__row--end">
        <div className="vdlg-field">
          <label htmlFor={inputId} className="vdlg-caps">
            Save current payload as
          </label>
          <Input
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
            className="vdlg-bench__name-input"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="test-bench-save"
          onClick={submit}
          disabled={!canSave || name.trim() === ''}
        >
          <Save aria-hidden /> Save
        </Button>
      </div>

      {payloads.length > 0 ? (
        <ul data-testid="test-bench-saved-list" className="vdlg-bench__list">
          {payloads.map((payload) => (
            <li key={payload.id} className="vdlg-bench__list-row">
              <button
                type="button"
                data-testid={`test-bench-saved-load-${payload.id}`}
                onClick={() => onLoad(payload)}
                className="vdlg-link vdlg-bench__list-name"
                title="Load into the payload editor"
              >
                {payload.name}
              </button>
              {payload.synthetic ? <Badge variant="violet">synthetic</Badge> : null}
              <span className="vdlg-bench__list-date">
                {new Date(payload.savedAt).toLocaleDateString()}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid={`test-bench-saved-delete-${payload.id}`}
                onClick={() => onDelete(payload)}
                aria-label={`Delete saved payload ${payload.name}`}
              >
                <Trash2 className="vdlg-icon-danger" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vdlg-quiet">No saved payloads for this schema yet.</p>
      )}
    </section>
  );
}
