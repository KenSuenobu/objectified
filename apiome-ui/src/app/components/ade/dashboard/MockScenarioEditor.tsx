'use client';

/**
 * Mock scenario override editor (#4454, SIM-4.2).
 *
 * Dialog for authoring named mock scenarios ("happy path", "quota exceeded", ...)
 * on one version. Each scenario maps operations ("METHOD /path/{template}") to
 * canned responses (status + headers + body); two or more responses on one
 * operation form a per-call sequence. Definitions persist in the version's
 * `mock_settings` and are served by apiome-mock when a consumer sends the
 * `X-Mock-Scenario: <name>` header.
 *
 * Declarative matching and templates (#4744, PMR-2.1): an operation may also
 * carry ordered match rules — request predicates over path/query/header/body
 * plus the responses they select — edited here as raw JSON (like headers and
 * bodies). Response bodies and header values may embed bounded `{{ ... }}`
 * templates (request fields, seeded randomness, fixture data); the server
 * validates predicates and templates on save and 422 errors are listed
 * verbatim under the form.
 *
 * The dialog also edits the latency/chaos knobs (#4455, SIM-4.3): a version
 * default and per-route overrides for injected delay (± jitter, capped at
 * 30s) and error rate (percent of calls answered with an injected 5xx). A
 * scenario may carry its own chaos block that replaces the version-level one
 * while that scenario is selected.
 *
 * Round-trips through `/api/versions/{id}/mock/scenarios` (GET on open, PUT on
 * save). Server-side validation failures (HTTP 422 from REST) are listed
 * verbatim under the form; a response can opt out of spec conformance with the
 * "Off-spec" flag for deliberately broken responses.
 */

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Textarea } from '../../ui/Textarea';
import { VersionDialogHead } from '../versions/VersionDialogChrome';
import { VERSION_DIALOG_COPY } from '../version-dialogs/versionDialogsModel';

/** One canned response as stored by REST (camelCase wire shape). */
export interface MockScenarioResponsePayload {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  mediaType?: string;
  offSpec?: boolean;
}

/** Latency/error-injection knobs for one scope (camelCase wire shape) (#4455, SIM-4.3). */
export interface MockChaosKnobsPayload {
  delayMs?: number;
  jitterMs?: number;
  errorRate?: number;
}

/** One chaos block: default knobs plus per-route overrides (#4455, SIM-4.3). */
export interface MockChaosPayload {
  default?: MockChaosKnobsPayload;
  operations?: Record<string, MockChaosKnobsPayload>;
}

/**
 * Request predicates gating one match rule (#4744, PMR-2.1). Sections are keyed
 * by parameter/header name (or JSON Pointer for `body`); each value is an
 * operator object like `{"equals": "42"}` — deep validation happens server-side.
 */
export interface MockScenarioWhenPayload {
  path?: Record<string, Record<string, unknown>>;
  query?: Record<string, Record<string, unknown>>;
  header?: Record<string, Record<string, unknown>>;
  body?: Record<string, Record<string, unknown>>;
}

/** One declarative match rule: predicates plus the responses they select (#4744, PMR-2.1). */
export interface MockScenarioRulePayload {
  when: MockScenarioWhenPayload;
  responses: MockScenarioResponsePayload[];
}

/** One operation override: ordered match rules and/or fallback responses. */
export interface MockScenarioOperationPayload {
  responses?: MockScenarioResponsePayload[];
  rules?: MockScenarioRulePayload[];
}

/** Scenario definitions as stored by REST, keyed by scenario name. */
export type MockScenariosPayload = Record<
  string,
  {
    description?: string;
    operations: Record<string, MockScenarioOperationPayload>;
    chaos?: MockChaosPayload;
  }
>;

/** Form state for one canned response (text fields until save). */
interface ResponseDraft {
  status: string;
  headersText: string;
  bodyText: string;
  mediaType: string;
  offSpec: boolean;
}

/** Form state for one operation override; match rules stay raw JSON until save. */
interface OperationDraft {
  key: string;
  responses: ResponseDraft[];
  rulesText: string;
}

/** Form state for one set of chaos knobs (text fields until save). */
interface ChaosKnobsDraft {
  delayMs: string;
  jitterMs: string;
  errorRate: string;
}

/** Form state for one per-route chaos override. */
interface ChaosOperationDraft {
  key: string;
  knobs: ChaosKnobsDraft;
}

/** Form state for one chaos block (version-level or scenario-scoped). */
interface ChaosDraft {
  default: ChaosKnobsDraft;
  operations: ChaosOperationDraft[];
}

/** Form state for one scenario. */
interface ScenarioDraft {
  name: string;
  description: string;
  operations: OperationDraft[];
  /** Scenario-scoped chaos; `null` means the version-level chaos applies. */
  chaos: ChaosDraft | null;
}

export interface MockScenarioEditorProps {
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

const EMPTY_RESPONSE: ResponseDraft = {
  status: '200',
  headersText: '',
  bodyText: '',
  mediaType: '',
  offSpec: false,
};

const EMPTY_CHAOS_KNOBS: ChaosKnobsDraft = { delayMs: '', jitterMs: '', errorRate: '' };

/** Hard cap (ms) on injected delay — mirrors the apiome-mock runtime cap. */
const MAX_CHAOS_DELAY_MS = 30_000;

/** Convert one stored knob set into editable text fields (unset knobs stay blank). */
function chaosKnobsDraftFromPayload(knobs?: MockChaosKnobsPayload): ChaosKnobsDraft {
  return {
    delayMs: knobs?.delayMs !== undefined ? String(knobs.delayMs) : '',
    jitterMs: knobs?.jitterMs !== undefined ? String(knobs.jitterMs) : '',
    errorRate: knobs?.errorRate !== undefined ? String(knobs.errorRate) : '',
  };
}

/** Convert one stored chaos block into an editable draft. */
function chaosDraftFromPayload(payload?: MockChaosPayload): ChaosDraft {
  return {
    default: chaosKnobsDraftFromPayload(payload?.default),
    operations: Object.entries(payload?.operations ?? {}).map(([key, knobs]) => ({
      key,
      knobs: chaosKnobsDraftFromPayload(knobs),
    })),
  };
}

/** True when a chaos draft has no values at all (nothing worth persisting). */
function chaosDraftIsEmpty(draft: ChaosDraft): boolean {
  const blank = (knobs: ChaosKnobsDraft) =>
    !knobs.delayMs.trim() && !knobs.jitterMs.trim() && !knobs.errorRate.trim();
  return blank(draft.default) && draft.operations.length === 0;
}

/**
 * Parse one chaos knob text field.
 *
 * @returns the numeric value, `undefined` when the field is blank (knob
 * unset), or `null` after reporting a parse/range error.
 */
function parseChaosKnob(
  raw: string,
  context: string,
  label: string,
  max: number,
  integer: boolean,
  errors: string[]
): number | undefined | null {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) {
    errors.push(
      integer
        ? `${context}: ${label} must be a whole number between 0 and ${max}.`
        : `${context}: ${label} must be a number between 0 and ${max}.`
    );
    return null;
  }
  return value;
}

/** Convert one knob draft into the wire shape, reporting range errors. */
function chaosKnobsFromDraft(
  draft: ChaosKnobsDraft,
  context: string,
  errors: string[]
): MockChaosKnobsPayload {
  const knobs: MockChaosKnobsPayload = {};
  const delayMs = parseChaosKnob(draft.delayMs, context, 'delay', MAX_CHAOS_DELAY_MS, true, errors);
  const jitterMs = parseChaosKnob(draft.jitterMs, context, 'jitter', MAX_CHAOS_DELAY_MS, true, errors);
  const errorRate = parseChaosKnob(draft.errorRate, context, 'error rate', 100, false, errors);
  if (typeof delayMs === 'number') knobs.delayMs = delayMs;
  if (typeof jitterMs === 'number') knobs.jitterMs = jitterMs;
  if (typeof errorRate === 'number') knobs.errorRate = errorRate;
  if ((knobs.delayMs ?? 0) + (knobs.jitterMs ?? 0) > MAX_CHAOS_DELAY_MS) {
    errors.push(`${context}: delay + jitter must not exceed ${MAX_CHAOS_DELAY_MS} ms (the 30s cap).`);
  }
  return knobs;
}

/** Convert one chaos block draft into the wire shape, reporting errors. */
function chaosPayloadFromDraft(
  draft: ChaosDraft,
  context: string,
  errors: string[]
): MockChaosPayload {
  const payload: MockChaosPayload = {};
  const defaults = chaosKnobsFromDraft(draft.default, `${context} defaults`, errors);
  if (Object.keys(defaults).length > 0) {
    payload.default = defaults;
  }
  const operations: Record<string, MockChaosKnobsPayload> = {};
  draft.operations.forEach((operation, index) => {
    const key = operation.key.trim();
    if (!key) {
      errors.push(`${context}: route override ${index + 1} needs a key like 'GET /pets'.`);
      return;
    }
    if (operations[key]) {
      errors.push(`${context}: duplicate route override '${key}'.`);
      return;
    }
    operations[key] = chaosKnobsFromDraft(operation.knobs, `${context}, route '${key}'`, errors);
  });
  if (Object.keys(operations).length > 0) {
    payload.operations = operations;
  }
  return payload;
}

/** Convert the stored wire shape into editable drafts. */
function draftsFromPayload(payload: MockScenariosPayload): ScenarioDraft[] {
  return Object.entries(payload).map(([name, scenario]) => ({
    name,
    description: scenario.description ?? '',
    operations: Object.entries(scenario.operations ?? {}).map(([key, override]) => ({
      key,
      responses: (override.responses ?? []).map((response) => ({
        status: String(response.status),
        headersText:
          response.headers && Object.keys(response.headers).length > 0
            ? JSON.stringify(response.headers, null, 2)
            : '',
        bodyText: 'body' in response ? JSON.stringify(response.body, null, 2) : '',
        mediaType: response.mediaType ?? '',
        offSpec: Boolean(response.offSpec),
      })),
      rulesText:
        override.rules && override.rules.length > 0 ? JSON.stringify(override.rules, null, 2) : '',
    })),
    chaos: scenario.chaos ? chaosDraftFromPayload(scenario.chaos) : null,
  }));
}

/**
 * Parse one operation's match-rules JSON text (#4744, PMR-2.1).
 *
 * Client-side checks cover the shape only (an array of `{when, responses}`
 * objects with numeric statuses); predicate operators and templates are
 * validated server-side on save.
 *
 * @returns the parsed rules, or `null` after reporting an error.
 */
function parseRulesText(
  text: string,
  context: string,
  errors: string[]
): MockScenarioRulePayload[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    errors.push(`${context}: match rules must be valid JSON.`);
    return null;
  }
  if (!Array.isArray(parsed)) {
    errors.push(`${context}: match rules must be a JSON array of {when, responses} objects.`);
    return null;
  }
  const rules: MockScenarioRulePayload[] = [];
  for (const [index, entry] of parsed.entries()) {
    const ruleContext = `${context}, rule ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${ruleContext}: each rule must be a {when, responses} object.`);
      return null;
    }
    const rule = entry as Record<string, unknown>;
    if (!rule.when || typeof rule.when !== 'object' || Array.isArray(rule.when)) {
      errors.push(`${ruleContext}: 'when' must be an object of request predicates.`);
      return null;
    }
    if (!Array.isArray(rule.responses) || rule.responses.length === 0) {
      errors.push(`${ruleContext}: 'responses' must be a non-empty array.`);
      return null;
    }
    for (const [responseIndex, response] of rule.responses.entries()) {
      const status = (response as Record<string, unknown> | null)?.status;
      if (typeof status !== 'number' || status < 100 || status > 599) {
        errors.push(
          `${ruleContext}, response ${responseIndex + 1}: status must be a number between 100 and 599.`
        );
        return null;
      }
    }
    rules.push(entry as unknown as MockScenarioRulePayload);
  }
  return rules;
}

/**
 * Convert drafts back into the wire shape.
 *
 * @returns the payload, or a list of client-side errors when a field cannot
 * be parsed (invalid JSON, non-numeric status, blank names).
 */
function payloadFromDrafts(
  drafts: ScenarioDraft[]
): { payload: MockScenariosPayload; errors: string[] } {
  const payload: MockScenariosPayload = {};
  const errors: string[] = [];

  drafts.forEach((scenario, scenarioIndex) => {
    const name = scenario.name.trim();
    const label = name || `scenario ${scenarioIndex + 1}`;
    if (!name) {
      errors.push(`Scenario ${scenarioIndex + 1}: name is required.`);
      return;
    }
    if (payload[name]) {
      errors.push(`Scenario '${name}': duplicate scenario name.`);
      return;
    }

    const operations: Record<string, MockScenarioOperationPayload> = {};
    scenario.operations.forEach((operation, operationIndex) => {
      const key = operation.key.trim();
      if (!key) {
        errors.push(`Scenario '${label}': operation ${operationIndex + 1} needs a key like 'GET /pets'.`);
        return;
      }
      if (operations[key]) {
        errors.push(`Scenario '${label}': duplicate operation '${key}'.`);
        return;
      }

      let rules: MockScenarioRulePayload[] | null = null;
      if (operation.rulesText.trim()) {
        rules = parseRulesText(operation.rulesText, `Scenario '${label}', operation '${key}'`, errors);
        if (rules === null) return;
      }

      const responses: MockScenarioResponsePayload[] = [];
      operation.responses.forEach((response, responseIndex) => {
        const context = `Scenario '${label}', operation '${key}', response ${responseIndex + 1}`;
        const status = Number.parseInt(response.status, 10);
        if (!Number.isFinite(status) || status < 100 || status > 599) {
          errors.push(`${context}: status must be a number between 100 and 599.`);
          return;
        }
        const entry: MockScenarioResponsePayload = { status };

        if (response.headersText.trim()) {
          try {
            const headers: unknown = JSON.parse(response.headersText);
            if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
              throw new Error('not an object');
            }
            entry.headers = Object.fromEntries(
              Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])
            );
          } catch {
            errors.push(`${context}: headers must be a JSON object of string values.`);
            return;
          }
        }

        if (response.bodyText.trim()) {
          try {
            entry.body = JSON.parse(response.bodyText);
          } catch {
            errors.push(`${context}: body must be valid JSON (leave blank for an empty body).`);
            return;
          }
        }

        if (response.mediaType.trim()) {
          entry.mediaType = response.mediaType.trim();
        }
        if (response.offSpec) {
          entry.offSpec = true;
        }
        responses.push(entry);
      });

      if (responses.length > 0 || (rules && rules.length > 0)) {
        operations[key] = {
          ...(responses.length > 0 ? { responses } : {}),
          ...(rules && rules.length > 0 ? { rules } : {}),
        };
      } else {
        errors.push(`Scenario '${label}': operation '${key}' needs at least one response or match rule.`);
      }
    });

    payload[name] = {
      ...(scenario.description.trim() ? { description: scenario.description.trim() } : {}),
      operations,
      ...(scenario.chaos
        ? { chaos: chaosPayloadFromDraft(scenario.chaos, `Scenario '${label}' chaos`, errors) }
        : {}),
    };
  });

  return { payload, errors };
}

/** Props for one editable chaos block (version-level or scenario-scoped). */
interface ChaosBlockFieldsProps {
  /** The chaos draft being edited. */
  draft: ChaosDraft;
  /** Called with the replaced draft on every edit. */
  onChange: (next: ChaosDraft) => void;
  /** Prefix for input aria-labels (e.g. "Chaos" or "Scenario 1 chaos"). */
  ariaPrefix: string;
}

/** Three knob inputs (delay / jitter / error rate) for one scope. */
function ChaosKnobsFields({
  knobs,
  onChange,
  ariaPrefix,
}: {
  knobs: ChaosKnobsDraft;
  onChange: (next: ChaosKnobsDraft) => void;
  ariaPrefix: string;
}) {
  return (
    <>
      <Input
        value={knobs.delayMs}
        onChange={(e) => onChange({ ...knobs, delayMs: e.target.value })}
        placeholder="Delay ms"
        aria-label={`${ariaPrefix} delay ms`}
        className="w-24"
        inputMode="numeric"
      />
      <Input
        value={knobs.jitterMs}
        onChange={(e) => onChange({ ...knobs, jitterMs: e.target.value })}
        placeholder="± Jitter ms"
        aria-label={`${ariaPrefix} jitter ms`}
        className="w-24"
        inputMode="numeric"
      />
      <Input
        value={knobs.errorRate}
        onChange={(e) => onChange({ ...knobs, errorRate: e.target.value })}
        placeholder="Error rate %"
        aria-label={`${ariaPrefix} error rate percent`}
        className="w-28"
        inputMode="decimal"
      />
    </>
  );
}

/** Editable chaos block: default knobs plus per-route override rows (#4455, SIM-4.3). */
function ChaosBlockFields({ draft, onChange, ariaPrefix }: ChaosBlockFieldsProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="vdlg-caps vdlg-mock__scope">Default</span>
        <ChaosKnobsFields
          knobs={draft.default}
          onChange={(next) => onChange({ ...draft, default: next })}
          ariaPrefix={`${ariaPrefix} default`}
        />
      </div>

      {draft.operations.map((operation, index) => (
        <div key={index} className="flex items-center gap-2 flex-wrap">
          <Input
            value={operation.key}
            onChange={(e) =>
              onChange({
                ...draft,
                operations: draft.operations.map((o, i) =>
                  i === index ? { ...o, key: e.target.value } : o
                ),
              })
            }
            placeholder="Operation (e.g. GET /pets/{petId})"
            aria-label={`${ariaPrefix} route ${index + 1} key`}
            className="vdlg-input--mono vdlg-mock__route"
          />
          <ChaosKnobsFields
            knobs={operation.knobs}
            onChange={(next) =>
              onChange({
                ...draft,
                operations: draft.operations.map((o, i) =>
                  i === index ? { ...o, knobs: next } : o
                ),
              })
            }
            ariaPrefix={`${ariaPrefix} route ${index + 1}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() =>
              onChange({ ...draft, operations: draft.operations.filter((_, i) => i !== index) })
            }
            aria-label={`Remove ${ariaPrefix.toLowerCase()} route override ${index + 1}`}
          >
            <Trash2 className="vdlg-icon-danger" aria-hidden />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange({
            ...draft,
            operations: [...draft.operations, { key: '', knobs: { ...EMPTY_CHAOS_KNOBS } }],
          })
        }
        className="self-start"
        aria-label={`Add ${ariaPrefix.toLowerCase()} route override`}
      >
        <Plus className="h-3.5 w-3.5" /> Add route override
      </Button>
    </div>
  );
}

/**
 * Render the scenario editor dialog for one version.
 *
 * @param props - see {@link MockScenarioEditorProps}
 * @returns the controlled dialog element
 */
export function MockScenarioEditor({
  versionRecordId,
  projectId,
  versionLabel,
  open,
  onOpenChange,
}: MockScenarioEditorProps) {
  const [drafts, setDrafts] = useState<ScenarioDraft[]>([]);
  const [chaos, setChaos] = useState<ChaosDraft>(() => chaosDraftFromPayload());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  /** Load persisted definitions every time the dialog opens. */
  const load = useCallback(async () => {
    setLoading(true);
    setErrors([]);
    try {
      const response = await fetch(
        `/api/versions/${versionRecordId}/mock/scenarios?projectId=${encodeURIComponent(projectId)}`
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        toast.error(payload?.error || `Failed to load scenarios for v${versionLabel}.`);
        return;
      }
      setDrafts(draftsFromPayload((payload.scenarios ?? {}) as MockScenariosPayload));
      setChaos(chaosDraftFromPayload((payload.chaos ?? undefined) as MockChaosPayload | undefined));
    } catch (error) {
      console.error('Failed to load mock scenarios:', error);
      toast.error(`Failed to load scenarios for v${versionLabel}.`);
    } finally {
      setLoading(false);
    }
  }, [versionRecordId, projectId, versionLabel]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /** Validate drafts client-side, then PUT the full definition set. */
  const handleSave = async () => {
    if (saving) return;
    const { payload, errors: clientErrors } = payloadFromDrafts(drafts);
    const chaosPayload = chaosDraftIsEmpty(chaos)
      ? undefined
      : chaosPayloadFromDraft(chaos, 'Latency & chaos', clientErrors);
    if (clientErrors.length > 0) {
      setErrors(clientErrors);
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      const response = await fetch(`/api/versions/${versionRecordId}/mock/scenarios`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          scenarios: payload,
          ...(chaosPayload !== undefined ? { chaos: chaosPayload } : {}),
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        if (Array.isArray(result?.errors) && result.errors.length > 0) {
          setErrors(result.errors as string[]);
        } else {
          toast.error(result?.error || `Failed to save scenarios for v${versionLabel}.`);
        }
        return;
      }
      toast.success(`Scenarios saved for v${versionLabel}.`);
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save mock scenarios:', error);
      toast.error(`Failed to save scenarios for v${versionLabel}.`);
    } finally {
      setSaving(false);
    }
  };

  const updateScenario = (index: number, patch: Partial<ScenarioDraft>) => {
    setDrafts((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const updateOperation = (scenarioIndex: number, operationIndex: number, patch: Partial<OperationDraft>) => {
    setDrafts((prev) =>
      prev.map((s, i) =>
        i === scenarioIndex
          ? {
              ...s,
              operations: s.operations.map((o, j) => (j === operationIndex ? { ...o, ...patch } : o)),
            }
          : s
      )
    );
  };

  const updateResponse = (
    scenarioIndex: number,
    operationIndex: number,
    responseIndex: number,
    patch: Partial<ResponseDraft>
  ) => {
    setDrafts((prev) =>
      prev.map((s, i) =>
        i === scenarioIndex
          ? {
              ...s,
              operations: s.operations.map((o, j) =>
                j === operationIndex
                  ? {
                      ...o,
                      responses: o.responses.map((r, k) => (k === responseIndex ? { ...r, ...patch } : r)),
                    }
                  : o
              ),
            }
          : s
      )
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="vdlg-dialog vdlg-dialog--lg"
        data-testid={`mock-scenario-editor-${versionRecordId}`}
      >
        <VersionDialogHead
          icon={<FlaskConical aria-hidden />}
          tone="accent"
          title={`Mock scenarios for v${versionLabel}`}
          description={
            <>
              Curated situations consumers select per request with the{' '}
              <span className="mono">X-Mock-Scenario</span> header. Add several responses to one
              operation to build a per-call sequence; requests without the header keep the default
              mock behavior.
            </>
          }
        />

        {loading ? (
          <p className="vdlg-quiet" data-testid="mock-scenario-loading">
            {VERSION_DIALOG_COPY.scenariosLoading}
          </p>
        ) : (
          <div className="vdlg-form">
            {drafts.length === 0 && (
              <p className="vdlg-quiet">
                No scenarios defined yet. Add one to get started — for example{' '}
                <span className="mono">quota-exceeded</span> returning HTTP 429 from a list
                operation.
              </p>
            )}

            {drafts.map((scenario, scenarioIndex) => (
              <fieldset
                key={scenarioIndex}
                className="vdlg-mock__scenario"
                data-testid={`mock-scenario-${scenarioIndex}`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 flex flex-col gap-2">
                    <Input
                      value={scenario.name}
                      onChange={(e) => updateScenario(scenarioIndex, { name: e.target.value })}
                      placeholder="scenario-name (e.g. quota-exceeded)"
                      aria-label={`Scenario ${scenarioIndex + 1} name`}
                    />
                    <Input
                      value={scenario.description}
                      onChange={(e) => updateScenario(scenarioIndex, { description: e.target.value })}
                      placeholder="Description (optional)"
                      aria-label={`Scenario ${scenarioIndex + 1} description`}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== scenarioIndex))}
                    aria-label={`Remove scenario ${scenario.name || scenarioIndex + 1}`}
                  >
                    <Trash2 className="vdlg-icon-danger" aria-hidden />
                  </Button>
                </div>

                {scenario.operations.map((operation, operationIndex) => (
                  <div
                    key={operationIndex}
                    className="vdlg-mock__override"
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        value={operation.key}
                        onChange={(e) => updateOperation(scenarioIndex, operationIndex, { key: e.target.value })}
                        placeholder="Operation (e.g. GET /pets/{petId})"
                        aria-label={`Scenario ${scenarioIndex + 1} operation ${operationIndex + 1} key`}
                        className="vdlg-input--mono"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          updateScenario(scenarioIndex, {
                            operations: scenario.operations.filter((_, j) => j !== operationIndex),
                          })
                        }
                        aria-label={`Remove operation ${operation.key || operationIndex + 1}`}
                      >
                        <Trash2 className="vdlg-icon-danger" aria-hidden />
                      </Button>
                    </div>

                    {operation.responses.map((response, responseIndex) => (
                      <div
                        key={responseIndex}
                        className="vdlg-mock__step"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="vdlg-caps">
                            {operation.responses.length > 1 ? `Call ${responseIndex + 1}` : 'Response'}
                          </span>
                          <Input
                            value={response.status}
                            onChange={(e) =>
                              updateResponse(scenarioIndex, operationIndex, responseIndex, {
                                status: e.target.value,
                              })
                            }
                            placeholder="Status"
                            aria-label={`Scenario ${scenarioIndex + 1} operation ${operationIndex + 1} response ${responseIndex + 1} status`}
                            className="w-24"
                            inputMode="numeric"
                          />
                          <Input
                            value={response.mediaType}
                            onChange={(e) =>
                              updateResponse(scenarioIndex, operationIndex, responseIndex, {
                                mediaType: e.target.value,
                              })
                            }
                            placeholder="Media type (default application/json)"
                            aria-label={`Scenario ${scenarioIndex + 1} operation ${operationIndex + 1} response ${responseIndex + 1} media type`}
                            className="vdlg-mock__route"
                          />
                          <label className="vdlg-check">
                            <input
                              type="checkbox"
                              checked={response.offSpec}
                              onChange={(e) =>
                                updateResponse(scenarioIndex, operationIndex, responseIndex, {
                                  offSpec: e.target.checked,
                                })
                              }
                              aria-label={`Scenario ${scenarioIndex + 1} operation ${operationIndex + 1} response ${responseIndex + 1} off-spec`}
                              className="vdlg-check__box"
                            />
                            Off-spec
                          </label>
                          {(operation.responses.length > 1 || operation.rulesText.trim() !== '') && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                updateOperation(scenarioIndex, operationIndex, {
                                  responses: operation.responses.filter((_, k) => k !== responseIndex),
                                })
                              }
                              aria-label={`Remove response ${responseIndex + 1}`}
                            >
                              <Trash2 className="vdlg-icon-danger" aria-hidden />
                            </Button>
                          )}
                        </div>
                        <Textarea
                          value={response.headersText}
                          onChange={(e) =>
                            updateResponse(scenarioIndex, operationIndex, responseIndex, {
                              headersText: e.target.value,
                            })
                          }
                          placeholder='Headers as JSON, e.g. {"Retry-After": "60"} (optional)'
                          aria-label={`Scenario ${scenarioIndex + 1} operation ${operationIndex + 1} response ${responseIndex + 1} headers`}
                          className="vdlg-textarea vdlg-textarea--mono"
                        />
                        <Textarea
                          value={response.bodyText}
                          onChange={(e) =>
                            updateResponse(scenarioIndex, operationIndex, responseIndex, {
                              bodyText: e.target.value,
                            })
                          }
                          placeholder={
                            'Body as JSON; leave blank for an empty response body. Supports {{templates}}, e.g. {"id": "{{request.path.petId}}"}'
                          }
                          aria-label={`Scenario ${scenarioIndex + 1} operation ${operationIndex + 1} response ${responseIndex + 1} body`}
                          className="vdlg-textarea vdlg-textarea--mono"
                        />
                      </div>
                    ))}

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        updateOperation(scenarioIndex, operationIndex, {
                          responses: [...operation.responses, { ...EMPTY_RESPONSE }],
                        })
                      }
                      className="self-start"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add sequence step
                    </Button>

                    <div className="flex flex-col gap-1">
                      <span className="vdlg-caps">
                        Match rules (advanced) — evaluated before the responses above; first match
                        wins, responses above are the fallback
                      </span>
                      <Textarea
                        value={operation.rulesText}
                        onChange={(e) =>
                          updateOperation(scenarioIndex, operationIndex, { rulesText: e.target.value })
                        }
                        placeholder={
                          'Rules as JSON, e.g. [{"when": {"query": {"limit": {"gt": 10}}}, "responses": [{"status": 429}]}] (optional)'
                        }
                        aria-label={`Scenario ${scenarioIndex + 1} operation ${operationIndex + 1} match rules`}
                        className="vdlg-textarea vdlg-textarea--mono"
                      />
                    </div>
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    updateScenario(scenarioIndex, {
                      operations: [
                        ...scenario.operations,
                        { key: '', responses: [{ ...EMPTY_RESPONSE }], rulesText: '' },
                      ],
                    })
                  }
                  className="self-start"
                >
                  <Plus className="h-3.5 w-3.5" /> Add operation override
                </Button>

                {scenario.chaos ? (
                  <div
                    className="vdlg-mock__override"
                    data-testid={`mock-scenario-${scenarioIndex}-chaos`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="vdlg-caps">
                        Scenario chaos — replaces the version-level knobs while this scenario is
                        selected
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => updateScenario(scenarioIndex, { chaos: null })}
                        aria-label={`Remove scenario ${scenarioIndex + 1} chaos`}
                      >
                        <Trash2 className="vdlg-icon-danger" aria-hidden />
                      </Button>
                    </div>
                    <ChaosBlockFields
                      draft={scenario.chaos}
                      onChange={(next) => updateScenario(scenarioIndex, { chaos: next })}
                      ariaPrefix={`Scenario ${scenarioIndex + 1} chaos`}
                    />
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      updateScenario(scenarioIndex, {
                        chaos: { default: { ...EMPTY_CHAOS_KNOBS }, operations: [] },
                      })
                    }
                    className="self-start"
                    aria-label={`Add scenario ${scenarioIndex + 1} chaos`}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add scenario chaos
                  </Button>
                )}
              </fieldset>
            ))}

            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setDrafts((prev) => [...prev, { name: '', description: '', operations: [], chaos: null }])
              }
              className="self-start"
              data-testid="mock-scenario-add"
            >
              <Plus className="h-4 w-4" /> Add scenario
            </Button>

            <fieldset
              className="vdlg-mock__scenario"
              data-testid="mock-chaos-editor"
            >
              <div>
                <p className="vdlg-section-title">
                  Latency &amp; chaos
                </p>
                <p className="vdlg-quiet">
                  Simulate a slow or flaky API: every response waits the configured delay (± jitter,
                  capped at 30s) and the error rate answers that percentage of calls with an injected
                  5xx. Route overrides win over the defaults; leave everything blank for an instant,
                  reliable mock.
                </p>
              </div>
              <ChaosBlockFields draft={chaos} onChange={setChaos} ariaPrefix="Chaos" />
            </fieldset>

            {errors.length > 0 && (
              <div
                className="vdlg-mock__errors"
                data-testid="mock-scenario-errors"
              >
                <p className="vdlg-mock__errors-title">
                  Please fix the following before saving:
                </p>
                <ul className="vdlg-mock__errors-list">
                  {errors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                data-testid="mock-scenario-save"
              >
                {saving ? 'Saving…' : 'Save scenarios'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
