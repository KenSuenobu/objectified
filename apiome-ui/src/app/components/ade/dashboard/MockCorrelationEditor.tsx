'use client';

/**
 * Response correlation editor for one version (#5529, MSC-1.3).
 *
 * MSC-1.1 (#5527) gave the mock a way to answer `GET /pets/42` with an id of `42` — with no request
 * header, so a generated SDK or a browser app gets it too. Until now that setting could only be
 * reached by hand-writing JSON into the scenario editor's textarea, with a failed save as the only
 * feedback. For a per-version behaviour a version owner configures once and then trusts, that is
 * not a usable surface.
 *
 * This dialog replaces it with four things:
 *
 * - **Mode cards** (the HIVE-2.1 scoped choice-control pattern) saying what each mode does to a
 *   *response*, not what it is called.
 * - A read-only **inferred-bindings preview** under the two inference modes, listing per operation
 *   which response properties would take which request values — computed by REST with the same
 *   name-matching rules the runtime applies, so it cannot promise a binding the mock declines.
 * - A **row editor** for explicit bindings: pick the operation, point at a response property,
 *   insert a token. No raw JSON, and each row validates on its own.
 * - A **live preview** (MSC-1.2, #5528) rendering the *unsaved* draft, so changing the mode changes
 *   the answer without a save.
 *
 * Save-time failures from REST are attached to the row that caused them rather than listed under
 * the form — the detached list is the loop this editor exists to close.
 *
 * The pointer map is honoured in **every** mode except `off` and always wins, so the rows stay on
 * screen for `path-params` and `inferred` too; only `off` hides them, and saving bindings with
 * `off` is refused here exactly as REST refuses it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '../../ui/Button';
import { Dialog, DialogContent } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/Select';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import { CorrelationBindingsPreview } from './mock/CorrelationBindingsPreview';
import { MockPreviewPanel, type MockPreviewSettings } from './mock/MockPreviewPanel';
import { MockTokenPicker } from './mock/MockTokenPicker';
import {
  buildTokenGroups,
  insertToken,
  type MockAuthoringOperation,
} from './mock/mockAuthoringModel';
import {
  attachServerErrors,
  blockErrors,
  CORRELATION_MODE_COPY,
  CORRELATION_MODES,
  draftFromPayload,
  draftIsEmpty,
  errorsForRow,
  isInferenceMode,
  payloadFromDraft,
  type CorrelationDraft,
  type CorrelationPayload,
  type CorrelationRowError,
} from './mock/correlationEditorModel';

export interface MockCorrelationEditorProps {
  /** Version record id (the `versions.id` UUID, not the semver label). */
  versionRecordId: string;
  /** Project the version belongs to (forwarded to the proxy routes). */
  projectId: string;
  /** Human version label (e.g. `1.2.0`), used in the dialog title. */
  versionLabel: string;
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called when the dialog wants to open/close. */
  onOpenChange: (open: boolean) => void;
}

/** An empty binding row. */
const EMPTY_BINDING = { operationKey: '', pointer: '', expression: '' };

/**
 * Render the correlation editor dialog for one version.
 *
 * @param props - see {@link MockCorrelationEditorProps}
 * @returns the controlled dialog element
 */
export function MockCorrelationEditor({
  versionRecordId,
  projectId,
  versionLabel,
  open,
  onOpenChange,
}: MockCorrelationEditorProps) {
  const [draft, setDraft] = useState<CorrelationDraft>({ mode: 'off', bindings: [] });
  const [operations, setOperations] = useState<MockAuthoringOperation[]>([]);
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [previewKey, setPreviewKey] = useState('');
  const [errors, setErrors] = useState<CorrelationRowError[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const expressionRefs = useRef<Array<HTMLInputElement | null>>([]);

  /** Load the stored block and the authoring catalogue every time the dialog opens. */
  const load = useCallback(async () => {
    setLoading(true);
    setErrors([]);
    try {
      const query = `projectId=${encodeURIComponent(projectId)}`;
      const [correlationResponse, operationsResponse] = await Promise.all([
        fetch(`/api/versions/${versionRecordId}/mock/correlation?${query}`),
        // Swallowed on purpose: the catalogue powers the pickers and the bindings preview, but the
        // stored block is still editable without it, so a failure here degrades rather than blocks.
        fetch(`/api/versions/${versionRecordId}/mock/operations?${query}`).catch(() => null),
      ]);
      const correlationPayload = await correlationResponse.json().catch(() => null);
      const operationsPayload = await operationsResponse?.json().catch(() => null);

      if (!correlationResponse.ok || !correlationPayload?.success) {
        toast.error(
          correlationPayload?.error || `Failed to load correlation for v${versionLabel}.`
        );
        return;
      }
      setDraft(draftFromPayload(correlationPayload.correlation as CorrelationPayload | null));

      if (operationsResponse?.ok && operationsPayload?.success) {
        const listed = (operationsPayload.operations ?? []) as MockAuthoringOperation[];
        setOperations(listed);
        setFixtures((operationsPayload.fixtures ?? []) as string[]);
        setPreviewKey(listed[0]?.key ?? '');
      } else {
        // The catalogue is what makes the pickers and the bindings preview possible, but the
        // stored block is still editable without it; say so rather than blocking the dialog.
        setOperations([]);
        setFixtures([]);
        toast.error(
          operationsPayload?.error || `Could not list the operations for v${versionLabel}.`
        );
      }
    } catch (error) {
      console.error('Failed to load mock correlation:', error);
      toast.error(`Failed to load correlation for v${versionLabel}.`);
    } finally {
      setLoading(false);
    }
  }, [projectId, versionLabel, versionRecordId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const operationsByKey = useMemo(
    () => new Map(operations.map((operation) => [operation.key, operation])),
    [operations]
  );
  const previewOperation = operationsByKey.get(previewKey) ?? null;
  const modeCopy = CORRELATION_MODE_COPY[draft.mode];

  /** Render the preview against what is on screen, not against what was last saved. */
  const buildSettings = useCallback((): MockPreviewSettings => {
    const { payload, errors: draftErrors } = payloadFromDraft(draft, { ignoreBlankRows: true });
    if (!payload) {
      return { settings: null, errors: draftErrors.map((error) => error.message) };
    }
    return { settings: { correlation: payload } };
  }, [draft]);

  const updateBinding = (index: number, patch: Partial<(typeof draft.bindings)[number]>) => {
    setDraft((previous) => ({
      ...previous,
      bindings: previous.bindings.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  };

  /** Insert a token at the caret of one row's expression field. */
  const insertIntoExpression = (index: number, token: string) => {
    const field = expressionRefs.current[index];
    const row = draft.bindings[index];
    const { value, caret } = insertToken(
      row?.expression ?? '',
      token,
      field?.selectionStart ?? null,
      field?.selectionEnd ?? null
    );
    updateBinding(index, { expression: value });
    // Put the caret after the inserted token so a second insert does not land at the start.
    window.requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  };

  /** Validate client-side, then PUT the whole block. */
  const handleSave = async () => {
    if (saving) return;
    const { payload, errors: clientErrors } = payloadFromDraft(draft);
    if (clientErrors.length > 0 || !payload) {
      setErrors(clientErrors);
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      const response = await fetch(`/api/versions/${versionRecordId}/mock/correlation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          correlation: draftIsEmpty(draft) ? null : payload,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        if (Array.isArray(result?.errors) && result.errors.length > 0) {
          setErrors(attachServerErrors(result.errors as string[], draft.bindings));
        } else {
          toast.error(result?.error || `Failed to save correlation for v${versionLabel}.`);
        }
        return;
      }
      toast.success(`Response correlation saved for v${versionLabel}.`);
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save mock correlation:', error);
      toast.error(`Failed to save correlation for v${versionLabel}.`);
    } finally {
      setSaving(false);
    }
  };

  const blockLevel = blockErrors(errors);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="vdlg-dialog vdlg-dialog--lg"
        data-testid={`mock-correlation-editor-${versionRecordId}`}
      >
        <VersionDialogHead
          icon={<Link2 aria-hidden />}
          tone="accent"
          title={`Response correlation for v${versionLabel}`}
          description={
            <>
              Makes the mock answer with values from the request instead of the same spec example
              every time — with no header to send, so a generated SDK or a browser app gets it too.
              Applies to the default response path; scenarios and forced statuses are unaffected.
            </>
          }
        />

        {loading ? (
          <p className="vdlg-quiet" data-testid="mock-correlation-loading">
            Loading correlation…
          </p>
        ) : (
          <div className="vdlg-form">
            <div
              role="radiogroup"
              aria-label="Correlation mode"
              className="mock-corr__modes"
              data-testid="mock-correlation-modes"
            >
              {CORRELATION_MODES.map((mode) => {
                const copy = CORRELATION_MODE_COPY[mode];
                const inputId = `mock-correlation-mode-${versionRecordId}-${mode}`;
                return (
                  /* The scoped choice control (HIVE-2.1): a `<div>`, not a `<label>`, because the
                     chosen card carries the bindings preview. Only the title labels the radio. */
                  <div key={mode} className="mock-corr__mode" data-testid={`mock-correlation-mode-${mode}`}>
                    <input
                      type="radio"
                      id={inputId}
                      name={`mock-correlation-mode-${versionRecordId}`}
                      checked={draft.mode === mode}
                      onChange={() => setDraft((previous) => ({ ...previous, mode }))}
                    />
                    <div className="mock-corr__mode-body">
                      <label htmlFor={inputId} className="mock-corr__mode-title">
                        {copy.label}
                      </label>
                      <p className="mock-corr__mode-desc">{copy.description}</p>

                      {draft.mode === mode && isInferenceMode(mode) && (
                        <CorrelationBindingsPreview
                          operations={operations}
                          mode={mode}
                          testId={`mock-correlation-inferred-${mode}`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {blockLevel.length > 0 && (
              <div className="vdlg-mock__errors" data-testid="mock-correlation-block-errors">
                <p className="vdlg-mock__errors-title">Please fix the following before saving:</p>
                <ul className="vdlg-mock__errors-list">
                  {blockLevel.map((error) => (
                    <li key={error.message}>{error.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {draft.mode !== 'off' && (
              <fieldset className="vdlg-mock__scenario" data-testid="mock-correlation-bindings">
                <div>
                  <p className="vdlg-section-title">Explicit bindings</p>
                  <p className="vdlg-quiet">
                    {modeCopy.infers
                      ? 'Applied after the automatic ones above and always winning, so a binding here overrides whatever inference decided for the same property.'
                      : 'The only bindings applied in this mode.'}
                  </p>
                </div>

                {draft.bindings.length === 0 && (
                  <p className="vdlg-quiet">
                    No explicit bindings.{' '}
                    {modeCopy.infers
                      ? 'The automatic bindings above are all that apply.'
                      : 'Nothing is correlated until you add one.'}
                  </p>
                )}

                {draft.bindings.map((row, index) => {
                  const operation = operationsByKey.get(row.operationKey) ?? null;
                  const rowErrors = errorsForRow(errors, index);
                  const pointerListId = `mock-correlation-pointers-${versionRecordId}-${index}`;
                  return (
                    <div
                      key={index}
                      className="vdlg-mock__override"
                      data-testid={`mock-correlation-binding-${index}`}
                    >
                      <div className="mock-corr__row">
                        {operations.length > 0 ? (
                          <Select
                            // `?? ''` keeps the Root *controlled* at all times: with `undefined`
                            // Radix flips to uncontrolled and keeps the previously chosen key
                            // internally, so re-picking the same operation fires no change.
                            value={row.operationKey ?? ''}
                            onValueChange={(value) => updateBinding(index, { operationKey: value })}
                          >
                            <SelectTrigger
                              aria-label={`Binding ${index + 1} operation`}
                              className="mock-corr__op"
                            >
                              <SelectValue placeholder="Choose an operation…" />
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                              {operations.map((entry) => (
                                <SelectItem key={entry.key} value={entry.key}>
                                  {entry.key}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            value={row.operationKey}
                            onChange={(event) =>
                              updateBinding(index, { operationKey: event.target.value })
                            }
                            placeholder="Operation (e.g. GET /pets/{petId})"
                            aria-label={`Binding ${index + 1} operation`}
                            className="vdlg-input--mono mock-corr__op"
                          />
                        )}

                        <Input
                          value={row.pointer}
                          onChange={(event) => updateBinding(index, { pointer: event.target.value })}
                          placeholder="/id"
                          aria-label={`Binding ${index + 1} response pointer`}
                          className="vdlg-input--mono mock-corr__pointer"
                          list={operation ? pointerListId : undefined}
                        />
                        {operation && (
                          <datalist id={pointerListId}>
                            {operation.responsePointers.map((pointer) => (
                              <option key={pointer.pointer} value={pointer.pointer}>
                                {pointer.type ?? ''}
                              </option>
                            ))}
                          </datalist>
                        )}

                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setDraft((previous) => ({
                              ...previous,
                              bindings: previous.bindings.filter((_, i) => i !== index),
                            }))
                          }
                          aria-label={`Remove binding ${index + 1}`}
                        >
                          <Trash2 className="vdlg-icon-danger" aria-hidden />
                        </Button>
                      </div>

                      <div className="mock-corr__row">
                        <Input
                          ref={(element) => {
                            expressionRefs.current[index] = element;
                          }}
                          value={row.expression}
                          onChange={(event) =>
                            updateBinding(index, { expression: event.target.value })
                          }
                          placeholder="{{request.path.petId}}"
                          aria-label={`Binding ${index + 1} expression`}
                          className="vdlg-input--mono mock-corr__expression"
                        />
                      </div>
                      <MockTokenPicker
                        groups={buildTokenGroups(operation, fixtures)}
                        onInsert={(token) => insertIntoExpression(index, token)}
                        fieldLabel={`binding ${index + 1}`}
                        testId={`mock-correlation-binding-${index}-tokens`}
                      />

                      {rowErrors.length > 0 && (
                        <ul
                          className="mock-corr__row-errors"
                          data-testid={`mock-correlation-binding-${index}-errors`}
                        >
                          {rowErrors.map((error) => (
                            <li key={error.message}>{error.message}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setDraft((previous) => ({
                      ...previous,
                      bindings: [...previous.bindings, { ...EMPTY_BINDING }],
                    }))
                  }
                  className="self-start"
                  data-testid="mock-correlation-add-binding"
                >
                  <Plus className="h-3.5 w-3.5" /> Add binding
                </Button>
              </fieldset>
            )}

            <fieldset className="vdlg-mock__scenario" data-testid="mock-correlation-preview">
              <div>
                <p className="vdlg-section-title">Try it</p>
                <p className="vdlg-quiet">
                  Renders a request against the settings on screen — no save, no mock to enable,
                  nothing sent anywhere. The trace says which layer produced each value.
                </p>
              </div>
              {operations.length > 0 && (
                <Select value={previewKey} onValueChange={setPreviewKey}>
                  <SelectTrigger aria-label="Preview operation" className="mock-corr__op">
                    <SelectValue placeholder="Choose an operation…" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {operations.map((entry) => (
                      <SelectItem key={entry.key} value={entry.key}>
                        {entry.key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <MockPreviewPanel
                versionRecordId={versionRecordId}
                projectId={projectId}
                operations={operations}
                operation={previewOperation}
                buildSettings={buildSettings}
                testId="mock-correlation-preview-panel"
              />
            </fieldset>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                data-testid="mock-correlation-save"
              >
                {saving ? 'Saving…' : 'Save correlation'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
