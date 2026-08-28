'use client';

/**
 * Live mock preview for the ADE mock editors (#5529, MSC-1.3), driven by MSC-1.2 (#5528).
 *
 * The loop the old editor lacked entirely: send a synthetic request against the **unsaved** draft
 * and see what the mock would answer, with the decision trace naming which layer produced the body
 * — a scenario (and which rule), session state, correlation (and which pointers), a declared
 * example, or schema synthesis. Nothing is written, no mock has to be enabled, and no request
 * leaves the deployment.
 *
 * The panel is deliberately unopinionated about *what* is being drafted: its owner passes a
 * `buildSettings` callback returning the settings overlay to render against, so the correlation
 * editor sends `{ correlation }` and the scenario editor sends `{ scenarios, chaos }` while the
 * request panel, the trace and the failure copy stay one implementation. That callback may also
 * report that the draft cannot be serialized at all — a half-parsed draft rendered as if it were
 * whole would be worse than no preview, so those reasons are shown instead of a response.
 */

import { useCallback, useEffect, useState } from 'react';
import { Play } from 'lucide-react';

import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Textarea } from '../../../ui/Textarea';
import {
  formatPreviewBody,
  previewRequestFromDraft,
  sampleRequestForOperation,
  traceLayerIsProblem,
  traceLayerLabel,
  type MockAuthoringOperation,
  type MockPreviewRequestDraft,
  type MockPreviewResult,
} from './mockAuthoringModel';

/** What an editor's draft resolves to when the panel asks for it. */
export interface MockPreviewSettings {
  /**
   * The unsaved settings overlay to render against, or `null` to render the version's stored
   * settings (what an editor with nothing drafted should ask for).
   */
  settings: Record<string, unknown> | null;
  /** Reasons the draft could not be serialized; when non-empty nothing is sent. */
  errors?: string[];
}

export interface MockPreviewPanelProps {
  /** Version record id (the `versions.id` UUID). */
  versionRecordId: string;
  /** Project the version belongs to. */
  projectId: string;
  /** The operations the request panel can be prefilled from. */
  operations: MockAuthoringOperation[];
  /** The operation currently selected, or `null` for a hand-written request. */
  operation: MockAuthoringOperation | null;
  /** Resolve the editor's current draft into the settings overlay to render against. */
  buildSettings: () => MockPreviewSettings;
  /** Test id for the panel root. */
  testId?: string;
}

/**
 * Render the request/response preview panel.
 *
 * @param props - see {@link MockPreviewPanelProps}
 * @returns the sample-request form, the rendered response, and the decision trace
 */
export function MockPreviewPanel({
  versionRecordId,
  projectId,
  operations,
  operation,
  buildSettings,
  testId = 'mock-preview-panel',
}: MockPreviewPanelProps) {
  const [draft, setDraft] = useState<MockPreviewRequestDraft>(() =>
    sampleRequestForOperation(operation)
  );
  const [result, setResult] = useState<MockPreviewResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [rendering, setRendering] = useState(false);

  const operationKey = operation?.key ?? '';

  // The request panel reflects the selected operation: switching operation replaces the sample
  // rather than leaving a path that routes somewhere else entirely.
  useEffect(() => {
    const selected = operations.find((entry) => entry.key === operationKey) ?? null;
    setDraft(sampleRequestForOperation(selected));
    setResult(null);
    setErrors([]);
  }, [operationKey, operations]);

  const render = useCallback(async () => {
    if (rendering) return;
    const parsed = previewRequestFromDraft(draft);
    if (parsed.errors.length > 0 || !parsed.request) {
      setErrors(parsed.errors);
      setResult(null);
      return;
    }

    const draftSettings = buildSettings();
    if (draftSettings.errors && draftSettings.errors.length > 0) {
      setErrors(draftSettings.errors);
      setResult(null);
      return;
    }

    setRendering(true);
    setErrors([]);
    try {
      const response = await fetch(`/api/versions/${versionRecordId}/mock/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          request: parsed.request,
          ...(draftSettings.settings ? { settings: draftSettings.settings } : {}),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        const listed = Array.isArray(payload?.errors) ? (payload.errors as string[]) : [];
        setErrors(
          listed.length > 0
            ? listed
            : [payload?.error || 'The preview could not be rendered for this version.']
        );
        setResult(null);
        return;
      }
      setResult(payload.preview as MockPreviewResult);
    } catch (error) {
      console.error('Failed to render mock preview:', error);
      setErrors(['The preview could not be reached. Check the connection and try again.']);
      setResult(null);
    } finally {
      setRendering(false);
    }
  }, [buildSettings, draft, projectId, rendering, versionRecordId]);

  const trace = result?.trace;
  const problem = trace ? traceLayerIsProblem(trace.layer) : false;

  return (
    <div className="mock-prev" data-testid={testId}>
      <div className="mock-prev__request">
        <div className="mock-prev__line">
          <Input
            value={draft.method}
            onChange={(event) => setDraft({ ...draft, method: event.target.value })}
            aria-label="Preview request method"
            className="mock-prev__method vdlg-input--mono"
          />
          <Input
            value={draft.path}
            onChange={(event) => setDraft({ ...draft, path: event.target.value })}
            aria-label="Preview request path"
            placeholder="/pets/42"
            className="mock-prev__path vdlg-input--mono"
          />
          <Button
            type="button"
            onClick={() => void render()}
            disabled={rendering}
            data-testid={`${testId}-render`}
          >
            <Play aria-hidden />
            {rendering ? 'Rendering…' : 'Render'}
          </Button>
        </div>

        <div className="mock-prev__fields">
          <label className="mock-prev__field">
            <span className="vdlg-caps">Query</span>
            <Textarea
              value={draft.queryText}
              onChange={(event) => setDraft({ ...draft, queryText: event.target.value })}
              placeholder='{"limit": "10"}'
              aria-label="Preview request query"
              className="vdlg-textarea vdlg-textarea--mono mock-prev__textarea"
            />
          </label>
          <label className="mock-prev__field">
            <span className="vdlg-caps">Headers</span>
            <Textarea
              value={draft.headersText}
              onChange={(event) => setDraft({ ...draft, headersText: event.target.value })}
              placeholder='{"X-Tier": "gold"}'
              aria-label="Preview request headers"
              className="vdlg-textarea vdlg-textarea--mono mock-prev__textarea"
            />
          </label>
          <label className="mock-prev__field">
            <span className="vdlg-caps">Body</span>
            <Textarea
              value={draft.bodyText}
              onChange={(event) => setDraft({ ...draft, bodyText: event.target.value })}
              placeholder='{"name": "Rex"}'
              aria-label="Preview request body"
              className="vdlg-textarea vdlg-textarea--mono mock-prev__textarea"
            />
          </label>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="vdlg-mock__errors" data-testid={`${testId}-errors`}>
          <p className="vdlg-mock__errors-title">The preview could not run:</p>
          <ul className="vdlg-mock__errors-list">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {result && trace && (
        <div className="mock-prev__result" data-testid={`${testId}-result`}>
          <div className="mock-prev__line">
            <Badge variant={result.status < 400 ? 'ok' : 'danger'} size="lg" mono>
              {result.status}
            </Badge>
            <span className="mono mock-prev__media">{result.mediaType}</span>
            {result.operation ? (
              <span className="mono mock-prev__op">{result.operation}</span>
            ) : (
              <span className="vdlg-quiet">No operation matched</span>
            )}
            {result.draft && <Badge variant="warn">Unsaved draft</Badge>}
          </div>

          <div className="mock-prev__trace" data-testid={`${testId}-trace`}>
            <div className="mock-prev__line">
              <span className="vdlg-caps">Answered by</span>
              <Badge variant={problem ? 'warn' : 'accent'}>{traceLayerLabel(trace.layer)}</Badge>
              {trace.scenario && <Badge variant="secondary">scenario {trace.scenario}</Badge>}
              {typeof trace.ruleIndex === 'number' && (
                <Badge variant="secondary">rule {trace.ruleIndex + 1}</Badge>
              )}
              {trace.schemaValid === false && (
                <Badge variant="warn">Does not match the response schema</Badge>
              )}
            </div>
            <p className="mock-prev__detail">{trace.detail}</p>
            {trace.correlationMode && (
              <p className="mock-prev__detail">
                Correlation mode <span className="mono">{trace.correlationMode}</span>
                {trace.correlationApplied && trace.correlationApplied.length > 0 ? (
                  <>
                    {' '}
                    — bound by <span className="mono">{trace.correlationApplied.join(', ')}</span>
                  </>
                ) : (
                  ' — nothing bound for this request'
                )}
                {trace.correlationPointers && trace.correlationPointers.length > 0 && (
                  <>
                    {' '}
                    at <span className="mono">{trace.correlationPointers.join(', ')}</span>
                  </>
                )}
                .
              </p>
            )}
            {result.chaos?.suppressed && (
              <p className="mock-prev__detail">
                Chaos is configured for this operation ({result.chaos.delayMs} ms ±{' '}
                {result.chaos.jitterMs} ms, {result.chaos.errorRate}% errors) and is reported here
                rather than applied — a preview that slept or failed at random would answer a
                different question.
              </p>
            )}
          </div>

          <pre className="mock-prev__body" data-testid={`${testId}-body`}>
            {formatPreviewBody(result.body, result.bodyEncoding) || '(empty body)'}
          </pre>
        </div>
      )}
    </div>
  );
}
