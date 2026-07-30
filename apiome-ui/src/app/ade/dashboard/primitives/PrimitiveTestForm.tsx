'use client';

/**
 * PrimitiveTestForm — the "Test this type" card on the Primitives type-detail page.
 *
 * The schema is projected into a form (see `./primitiveTestForm.ts`) and the instance it describes
 * is validated **on every keystroke**. There is no "Check" button anywhere in this card: validation
 * is a pure function of the form state, so it is recomputed as the state changes and the verdict —
 * per field and overall — is always current.
 *
 * Shape rules:
 *  - an **object** schema renders the whole object: one row per property, nested objects expanded
 *    inline down to `MAX_FORM_DEPTH`;
 *  - a **single item** (scalar) renders one input;
 *  - either can be switched to **array** mode, which repeats the form per element with add/remove
 *    controls, so a type can be exercised as a list without hand-writing JSON.
 *
 * String fields carrying a `pattern` show the regex and a live match indicator next to the input —
 * the specific case where a click-to-check button would be pure friction.
 *
 * The card is **collapsed until asked for**: an object schema with many properties (or array mode,
 * which repeats the whole form per element) produces a form tall enough to bury the rest of the
 * detail page. The body is also not mounted until first opened, so a reader who never tests pays
 * for neither the Ajv compile nor the example generation; once opened it stays mounted, so
 * collapsing does not discard what was typed into it.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { Input } from '@/app/components/ui/Input';
import { buildExampleInstance } from './primitiveDetailModel';
import {
  arrayLength,
  buildInstance,
  buildTestField,
  childPointer,
  coerceScalar,
  compileTestValidator,
  describePlaceholder,
  findingsByPointer,
  isIncluded,
  itemPointer,
  patternMatches,
  seedStateFromInstance,
  type TestField,
  type TestFinding,
  type TestFormState,
} from './primitiveTestForm';

export interface PrimitiveTestFormProps {
  /** The primitive's JSON Schema document. */
  schema: Record<string, unknown>;
  /** The type's name, used in headings and the root field label. */
  name: string;
}

/** Single-value mode vs. array-of-values mode. */
type TestMode = 'single' | 'array';

const EMPTY_STATE: TestFormState = { values: {}, arrayLengths: {}, included: {} };

const labelClass = 'text-xs font-medium text-gray-700 dark:text-gray-300';
const hintClass = 'text-[11px] text-gray-500 dark:text-gray-400';
const monoHintClass = 'font-mono text-[11px] text-gray-500 dark:text-gray-400';

export function PrimitiveTestForm({ schema, name }: PrimitiveTestFormProps) {
  const [open, setOpen] = useState(false);
  // Sticky: the body mounts on first open and stays mounted, so a collapse keeps whatever the
  // reader typed. Until then nothing below is built at all.
  const [mounted, setMounted] = useState(false);
  const bodyId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section className={`${dashboardPanelClass} p-5`} data-testid="primitive-test-form">
      {/* The button lives *inside* the heading (the WAI-ARIA accordion shape) rather than wrapping
          it: a `button` may only contain phrasing content, so a heading nested in one is invalid. */}
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
        <button
          type="button"
          data-testid="primitive-test-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen((previous) => !previous);
            setMounted(true);
          }}
          className="-m-1 flex items-center gap-2 rounded-md p-1 text-left transition-colors hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-indigo-400"
        >
          <Chevron className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
          <FlaskConical className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
          Test this type
        </button>
      </h3>
      <p className={`mt-1 ${hintClass}`}>Validated as you type — no need to press anything.</p>

      {mounted ? (
        <div id={bodyId} hidden={!open}>
          <PrimitiveTestFormBody schema={schema} name={name} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The form itself: mode, seeded state, live validation, findings.
 *
 * Split from the card shell so none of it — the Ajv compile, the example generation, the field
 * projection — runs until the reader actually opens the card.
 */
function PrimitiveTestFormBody({ schema, name }: PrimitiveTestFormProps) {
  const [mode, setMode] = useState<TestMode>('single');
  const [state, setState] = useState<TestFormState>(EMPTY_STATE);

  const rootField = useMemo(() => buildTestField(schema, { label: name }), [schema, name]);

  /** The tree actually rendered: in array mode the root type becomes the item of a list. */
  const formField = useMemo<TestField>(
    () =>
      mode === 'array'
        ? { key: '', label: `${name}[]`, kind: 'array', required: true, schema: {}, item: rootField }
        : rootField,
    [mode, rootField, name],
  );

  // Seeding from the generated example gives the reader something to edit rather than a blank form.
  const seedState = useCallback(
    (target: TestField, forMode: TestMode): TestFormState => {
      const example = buildExampleInstance(schema);
      if (example === null || example === undefined) return EMPTY_STATE;
      return seedStateFromInstance(target, forMode === 'array' ? [example] : example);
    },
    [schema],
  );

  // Reseed whenever the schema or the mode changes — the pointers differ between the two modes.
  useEffect(() => {
    setState(seedState(formField, mode));
  }, [seedState, formField, mode]);

  const validator = useMemo(() => compileTestValidator(schema, mode === 'array'), [schema, mode]);

  const instance = useMemo(() => buildInstance(formField, state), [formField, state]);
  const result = useMemo(() => validator.validate(instance), [validator, instance]);
  const findings = useMemo(() => findingsByPointer(result.findings), [result.findings]);

  /** Local, per-field coercion problems (e.g. "abc" in a number box) that never reach Ajv. */
  const coercionErrors = useMemo(() => collectCoercionErrors(formField, state), [formField, state]);
  const hasCoercionError = coercionErrors.size > 0;

  const setValue = useCallback((pointer: string, value: string) => {
    setState((prev) => ({ ...prev, values: { ...prev.values, [pointer]: value } }));
  }, []);

  const setIncluded = useCallback((pointer: string, included: boolean) => {
    setState((prev) => ({ ...prev, included: { ...prev.included, [pointer]: included } }));
  }, []);

  const setArrayLength = useCallback((pointer: string, length: number) => {
    setState((prev) => ({ ...prev, arrayLengths: { ...prev.arrayLengths, [pointer]: Math.max(0, length) } }));
  }, []);

  const ctx: FieldContext = {
    state,
    findings,
    coercionErrors,
    setValue,
    setIncluded,
    setArrayLength,
  };

  return (
    <div className="mt-4">
      {/* Mode and Reset act on the form, so they live with it rather than on the card header —
          which keeps them out of sight (and out of reach) while the card is collapsed. */}
      <div className="mb-3 flex flex-wrap items-center justify-end gap-1.5">
        <ModeToggle mode={mode} onChange={setMode} />
        <button
          type="button"
          data-testid="primitive-test-reset"
          onClick={() => setState(seedState(formField, mode))}
          title="Reset the form to the generated example"
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset
        </button>
      </div>

      <VerdictBar result={result} hasCoercionError={hasCoercionError} unresolvedRefs={validator.unresolvedRefs} />

      <div className="mt-4 space-y-3">
        <FieldNode field={formField} pointer="" ctx={ctx} depth={0} />
      </div>

      {result.findings.length > 0 ? (
        <div className="mt-4" data-testid="primitive-test-findings">
          <h4 className={`mb-1.5 ${labelClass}`}>
            {result.findings.length} {result.findings.length === 1 ? 'problem' : 'problems'}
          </h4>
          <ul className="space-y-1">
            {result.findings.map((finding, index) => (
              <li
                key={`${finding.pointer}-${finding.keyword}-${index}`}
                className="flex gap-2 text-[11px] text-red-700 dark:text-red-300"
              >
                <span className="font-mono text-red-500 dark:text-red-400">{finding.pointer || '(root)'}</span>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Single ⇄ array switch. Both options are always offered — any type can be tested as a list. */
function ModeToggle({ mode, onChange }: { mode: TestMode; onChange: (mode: TestMode) => void }) {
  return (
    <div
      role="group"
      aria-label="Test mode"
      className="inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-600"
    >
      {(['single', 'array'] as const).map((option) => (
        <button
          key={option}
          type="button"
          data-testid={`primitive-test-mode-${option}`}
          aria-pressed={mode === option}
          onClick={() => onChange(option)}
          className={`px-2 py-1 text-xs font-medium transition-colors ${
            mode === option
              ? 'bg-indigo-600 text-white'
              : 'bg-white/95 text-gray-700 hover:bg-gray-50 dark:bg-gray-900/95 dark:text-gray-200 dark:hover:bg-gray-800'
          }`}
        >
          {option === 'single' ? 'Single' : 'Array'}
        </button>
      ))}
    </div>
  );
}

/** The always-current verdict. Coercion problems outrank Ajv — the instance is not even well-formed. */
function VerdictBar({
  result,
  hasCoercionError,
  unresolvedRefs,
}: {
  result: { status: string; findings: TestFinding[]; schemaError?: string };
  hasCoercionError: boolean;
  unresolvedRefs: string[];
}) {
  const tone =
    result.status === 'unavailable'
      ? 'amber'
      : hasCoercionError || result.status === 'invalid'
        ? 'red'
        : 'emerald';

  const message =
    result.status === 'unavailable'
      ? `Schema could not be compiled — ${result.schemaError ?? 'unknown error'}`
      : hasCoercionError
        ? 'Some inputs are not valid values yet'
        : result.status === 'invalid'
          ? `${result.findings.length} ${result.findings.length === 1 ? 'problem' : 'problems'} found`
          : 'Valid against this schema';

  const toneClass = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
    red: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
    amber: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  }[tone];

  return (
    <div>
      <div
        data-testid="primitive-test-verdict"
        data-status={hasCoercionError && result.status === 'valid' ? 'invalid' : result.status}
        role="status"
        aria-live="polite"
        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium ${toneClass}`}
      >
        {tone === 'emerald' ? <Check className="h-4 w-4" aria-hidden /> : <AlertCircle className="h-4 w-4" aria-hidden />}
        {message}
      </div>
      {unresolvedRefs.length > 0 ? (
        <p className={`mt-1.5 ${hintClass}`} data-testid="primitive-test-unresolved-refs">
          Validated loosely: {unresolvedRefs.join(', ')} could not be resolved in the browser, so those
          constraints are not checked here.
        </p>
      ) : null}
    </div>
  );
}

interface FieldContext {
  state: TestFormState;
  findings: Map<string, TestFinding[]>;
  coercionErrors: Map<string, string>;
  setValue: (pointer: string, value: string) => void;
  setIncluded: (pointer: string, included: boolean) => void;
  setArrayLength: (pointer: string, length: number) => void;
}

/** Render one node of the form tree: object fieldset, array list, or scalar input. */
function FieldNode({
  field,
  pointer,
  ctx,
  depth,
}: {
  field: TestField;
  pointer: string;
  ctx: FieldContext;
  depth: number;
}) {
  if (field.kind === 'object') {
    const children = field.children ?? [];
    if (children.length === 0) {
      return <p className={hintClass}>This object declares no properties, so there is nothing to fill in.</p>;
    }
    return (
      <div className={depth > 0 ? 'space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700' : 'space-y-3'}>
        {children.map((child) => {
          const childPtr = childPointer(pointer, child.key);
          const included = isIncluded(ctx.state, childPtr, child);
          return (
            <PropertyRow key={child.key} field={child} pointer={childPtr} ctx={ctx} depth={depth} included={included} />
          );
        })}
      </div>
    );
  }

  if (field.kind === 'array') {
    return <ArrayNode field={field} pointer={pointer} ctx={ctx} depth={depth} />;
  }

  return <ScalarInput field={field} pointer={pointer} ctx={ctx} />;
}

/**
 * One object property: its include toggle, label, and editor.
 *
 * Every property can be toggled — including required ones, which is what lets a reader watch the
 * `required` error appear live rather than taking the schema's word for it.
 */
function PropertyRow({
  field,
  pointer,
  ctx,
  depth,
  included,
}: {
  field: TestField;
  pointer: string;
  ctx: FieldContext;
  depth: number;
  included: boolean;
}) {
  const inputId = `field-${pointer || 'root'}`;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={included}
          data-testid={`primitive-test-include-${pointer}`}
          aria-label={`Include ${field.key}`}
          onChange={(event) => ctx.setIncluded(pointer, event.target.checked)}
          className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 dark:border-gray-600"
        />
        <label htmlFor={inputId} className={labelClass}>
          {field.key}
        </label>
        <span className={monoHintClass}>{describeType(field)}</span>
        {field.required ? (
          <span className="rounded bg-indigo-50 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
            required
          </span>
        ) : null}
      </div>
      {field.description ? <p className={hintClass}>{field.description}</p> : null}
      {included ? (
        <div className="pl-5">
          <FieldNode field={field} pointer={pointer} ctx={ctx} depth={depth + 1} />
        </div>
      ) : (
        <p className={`pl-5 ${hintClass}`}>Omitted from the instance.</p>
      )}
    </div>
  );
}

/** A repeatable list: one editor per element, with add/remove. */
function ArrayNode({
  field,
  pointer,
  ctx,
  depth,
}: {
  field: TestField;
  pointer: string;
  ctx: FieldContext;
  depth: number;
}) {
  const count = arrayLength(ctx.state, pointer);
  const item = field.item;
  const nodeFindings = ctx.findings.get(pointer) ?? [];

  if (!item) {
    return <p className={hintClass}>This array does not declare an item schema.</p>;
  }

  return (
    <div className="space-y-2" data-testid={`primitive-test-array-${pointer}`}>
      {Array.from({ length: count }, (_unused, index) => {
        const elementPtr = itemPointer(pointer, index);
        return (
          <div key={elementPtr} className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className={monoHintClass}>[{index}]</span>
              <button
                type="button"
                data-testid={`primitive-test-array-remove-${elementPtr}`}
                aria-label={`Remove item ${index}`}
                onClick={() => ctx.setArrayLength(pointer, count - 1)}
                className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <Trash2 className="h-3 w-3" aria-hidden />
                Remove
              </button>
            </div>
            <FieldNode field={item} pointer={elementPtr} ctx={ctx} depth={depth + 1} />
          </div>
        );
      })}
      <button
        type="button"
        data-testid={`primitive-test-array-add-${pointer}`}
        onClick={() => ctx.setArrayLength(pointer, count + 1)}
        className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add item
      </button>
      <FieldFindings findings={nodeFindings} pointer={pointer} />
    </div>
  );
}

/** A scalar editor plus its live regex indicator and per-field findings. */
function ScalarInput({ field, pointer, ctx }: { field: TestField; pointer: string; ctx: FieldContext }) {
  const raw = ctx.state.values[pointer] ?? '';
  const inputId = `field-${pointer || 'root'}`;
  const nodeFindings = ctx.findings.get(pointer) ?? [];
  const coercionError = ctx.coercionErrors.get(pointer);
  const invalid = nodeFindings.length > 0 || coercionError !== undefined;

  // The live regex verdict — recomputed on every render, i.e. on every keystroke.
  const patternState = field.pattern !== undefined ? patternMatches(field.pattern, raw) : undefined;

  const invalidClass = invalid ? 'border-red-400 dark:border-red-500' : '';

  return (
    <div className="space-y-1">
      {field.kind === 'boolean' ? (
        <select
          id={inputId}
          data-testid={`primitive-test-input-${pointer}`}
          value={raw === 'true' ? 'true' : 'false'}
          onChange={(event) => ctx.setValue(pointer, event.target.value)}
          className={`h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 ${invalidClass}`}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : field.kind === 'enum' ? (
        <select
          id={inputId}
          data-testid={`primitive-test-input-${pointer}`}
          value={raw}
          onChange={(event) => ctx.setValue(pointer, event.target.value)}
          className={`h-9 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 ${invalidClass}`}
        >
          <option value="">(none)</option>
          {(field.enumValues ?? []).map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={inputId}
          data-testid={`primitive-test-input-${pointer}`}
          aria-invalid={invalid || undefined}
          value={raw}
          inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
          placeholder={describePlaceholder(field)}
          onChange={(event) => ctx.setValue(pointer, event.target.value)}
          className={`h-9 ${invalidClass}`}
        />
      )}

      {field.pattern !== undefined ? (
        <PatternIndicator pattern={field.pattern} matches={patternState} pointer={pointer} />
      ) : null}

      {field.unresolvedRef ? (
        <p className={hintClass}>
          References <span className="font-mono">{field.unresolvedRef}</span>, which is not resolved here — enter
          raw JSON and expect only local constraints to be checked.
        </p>
      ) : null}

      {coercionError ? (
        <p className="text-[11px] text-red-600 dark:text-red-400" data-testid={`primitive-test-coercion-${pointer}`}>
          {coercionError}
        </p>
      ) : null}

      <FieldFindings findings={nodeFindings} pointer={pointer} />
    </div>
  );
}

/**
 * The live `pattern` verdict shown beside a regex-constrained input.
 *
 * This is the button that isn't here: the regex is applied on every render, so the indicator flips
 * as the reader types instead of waiting on a click.
 */
function PatternIndicator({
  pattern,
  matches,
  pointer,
}: {
  pattern: string;
  matches: boolean | null | undefined;
  pointer: string;
}) {
  const tone =
    matches === null
      ? 'text-amber-700 dark:text-amber-300'
      : matches
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-red-600 dark:text-red-400';

  return (
    <p
      className={`flex flex-wrap items-center gap-1.5 text-[11px] ${tone}`}
      data-testid={`primitive-test-pattern-${pointer}`}
      data-matches={matches === null ? 'invalid-pattern' : String(matches)}
    >
      {matches === null ? (
        <AlertCircle className="h-3 w-3" aria-hidden />
      ) : matches ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <X className="h-3 w-3" aria-hidden />
      )}
      <span className="font-mono text-gray-500 dark:text-gray-400">{pattern}</span>
      <span>
        {matches === null ? 'is not a regex this browser can run' : matches ? 'matches' : 'does not match'}
      </span>
    </p>
  );
}

/** The Ajv findings anchored to one node. */
function FieldFindings({ findings, pointer }: { findings: TestFinding[]; pointer: string }) {
  if (findings.length === 0) return null;
  return (
    <ul className="space-y-0.5" data-testid={`primitive-test-field-findings-${pointer}`}>
      {findings.map((finding, index) => (
        <li key={`${finding.keyword}-${index}`} className="text-[11px] text-red-600 dark:text-red-400">
          {finding.message}
        </li>
      ))}
    </ul>
  );
}

/** Human type hint for a property row, e.g. `string · email` or `enum`. */
function describeType(field: TestField): string {
  if (field.kind === 'enum') return 'enum';
  if (field.unresolvedRef) return `$ref ${field.unresolvedRef}`;
  return field.format ? `${field.kind} · ${field.format}` : field.kind;
}

/** Walk the included form tree collecting per-field coercion problems, keyed by pointer. */
function collectCoercionErrors(field: TestField, state: TestFormState, pointer = ''): Map<string, string> {
  const errors = new Map<string, string>();

  const walk = (node: TestField, nodePointer: string): void => {
    if (node.kind === 'object') {
      for (const child of node.children ?? []) {
        const childPtr = childPointer(nodePointer, child.key);
        if (isIncluded(state, childPtr, child)) walk(child, childPtr);
      }
      return;
    }
    if (node.kind === 'array') {
      if (!node.item) return;
      const count = arrayLength(state, nodePointer);
      for (let index = 0; index < count; index += 1) walk(node.item, itemPointer(nodePointer, index));
      return;
    }
    const { error } = coerceScalar(node, state.values[nodePointer] ?? '');
    if (error) errors.set(nodePointer, error);
  };

  walk(field, pointer);
  return errors;
}

export default PrimitiveTestForm;
