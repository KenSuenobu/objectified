'use client';

/**
 * The "Test this type" card of the primitive-detail page (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Test this type.
 *
 * The schema is projected into a form (`primitiveTestForm.ts`) and the instance it describes is
 * validated **on every keystroke**. There is no Check button anywhere in this card: validation is
 * a pure function of the form state, so it is recomputed as the state changes and the verdict —
 * per field and overall — is always current.
 *
 * Shape rules:
 *  - an **object** schema renders the whole object: one row per property, nested objects expanded
 *    inline down to `MAX_FORM_DEPTH`;
 *  - a **single item** (scalar) renders one control;
 *  - either can be switched to **array** mode, which repeats the form per element with add and
 *    remove, so a type can be exercised as a list without hand-writing JSON.
 *
 * The card is **collapsed until asked for**: an object schema with many properties (or array
 * mode, which repeats the whole form per element) produces a form tall enough to bury the rest of
 * the page. The body is not mounted until first opened, so a reader who never tests pays for
 * neither the Ajv compile nor the example generation; once opened it stays mounted, so collapsing
 * does not discard what was typed into it.
 *
 * ### What HIVE-6.6 changed here, and what it did not
 *
 * The ticket's first acceptance criterion is that the **verdicts do not change**, including the
 * loose-validation caveat. So the wording moved out of the component into
 * {@link verdict} / {@link looseValidationNote} rather than being rewritten, and
 * `tests/primitive-detail-view.test.ts` pins every branch of it against the sentences the
 * pre-Hive card produced.
 *
 * What did change is the skin: three hand-built verdict panels
 * (`border-emerald-200 bg-emerald-50 …`) are one {@link Alert} in the tone's own calibrated pair,
 * the `bg-indigo-600` mode switch is a {@link Segmented}, and the findings list is a token
 * surface. The field tree lives in `./testFormFields.tsx`.
 */

import * as React from 'react';
import { AlertCircle, ChevronDown, ChevronRight, FlaskConical, RotateCcw } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/app/components/ui/Card';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { buildExampleInstance } from '@/app/ade/dashboard/primitives/primitiveDetailModel';
import {
  buildInstance,
  buildTestField,
  childPointer,
  compileTestValidator,
  findingsByPointer,
  moveStateSubtree,
  seedStateFromInstance,
  type TestField,
  type TestFormState,
} from '@/app/ade/dashboard/primitives/primitiveTestForm';

import {
  LIVE_VALIDATION_NOTE,
  collectCoercionErrors,
  looseValidationNote,
  problemCount,
  verdict as computeVerdict,
  type TestStatus,
} from './primitiveDetailView';
import { FieldNode, type FieldContext } from './testFormFields';

export interface PrimitiveTestFormProps {
  /** The primitive's JSON Schema document. */
  schema: Record<string, unknown>;
  /** The type's name, used in the root field's label. */
  name: string;
}

/** Single-value mode vs. array-of-values mode. */
type TestMode = 'single' | 'array';

/** The two modes, in the mockup's order. */
const TEST_MODES: readonly { id: TestMode; label: string }[] = [
  { id: 'single', label: 'Single' },
  { id: 'array', label: 'Array' },
];

const EMPTY_STATE: TestFormState = { values: {}, arrayLengths: {}, included: {}, extraNames: {} };

/**
 * Render the card. See {@link PrimitiveTestFormProps}.
 *
 * @returns The collapsible card; its body is built on the first open.
 */
export function PrimitiveTestForm({ schema, name }: PrimitiveTestFormProps) {
  const [open, setOpen] = React.useState(false);
  // Sticky: the body mounts on first open and stays mounted, so a collapse keeps whatever the
  // reader typed. Until then nothing below is built at all.
  const [mounted, setMounted] = React.useState(false);
  const bodyId = React.useId();
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <Card data-testid="primitive-test-form">
      <CardHeader>
        {/* The button lives *inside* the heading (the WAI-ARIA accordion shape) rather than
            wrapping it: a `button` may only contain phrasing content, so a heading nested in
            one is invalid. */}
        <h2 className="prm-panel-head__title">
          <button
            type="button"
            data-testid="primitive-test-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => {
              setOpen((previous) => !previous);
              setMounted(true);
            }}
            className="pd-toggle"
          >
            <Chevron aria-hidden />
            <FlaskConical aria-hidden />
            Test this type
          </button>
        </h2>
        <p className="prm-hint">{LIVE_VALIDATION_NOTE}</p>
      </CardHeader>

      {mounted ? (
        <CardBody id={bodyId} hidden={!open}>
          <PrimitiveTestFormBody schema={schema} name={name} />
        </CardBody>
      ) : null}
    </Card>
  );
}

/**
 * The form itself: mode, seeded state, live validation, findings.
 *
 * Split from the card shell so none of it — the Ajv compile, the example generation, the field
 * projection — runs until the reader actually opens the card.
 *
 * @param props See {@link PrimitiveTestFormProps}.
 * @returns The controls, the verdict, the field tree and the findings list.
 */
function PrimitiveTestFormBody({ schema, name }: PrimitiveTestFormProps) {
  const [mode, setMode] = React.useState<TestMode>('single');
  const [state, setState] = React.useState<TestFormState>(EMPTY_STATE);

  const rootField = React.useMemo(() => buildTestField(schema, { label: name }), [schema, name]);

  /** The tree actually rendered: in array mode the root type becomes the item of a list. */
  const formField = React.useMemo<TestField>(
    () =>
      mode === 'array'
        ? { key: '', label: `${name}[]`, kind: 'array', required: true, schema: {}, item: rootField }
        : rootField,
    [mode, rootField, name]
  );

  // Seeding from the generated example gives the reader something to edit rather than a blank form.
  const seedState = React.useCallback(
    (target: TestField, forMode: TestMode): TestFormState => {
      const example = buildExampleInstance(schema);
      if (example === null || example === undefined) return EMPTY_STATE;
      return seedStateFromInstance(target, forMode === 'array' ? [example] : example);
    },
    [schema]
  );

  // Reseed whenever the schema or the mode changes — the pointers differ between the two modes.
  React.useEffect(() => {
    setState(seedState(formField, mode));
  }, [seedState, formField, mode]);

  const validator = React.useMemo(
    () => compileTestValidator(schema, mode === 'array'),
    [schema, mode]
  );

  const instance = React.useMemo(() => buildInstance(formField, state), [formField, state]);
  const result = React.useMemo(() => validator.validate(instance), [validator, instance]);
  const findings = React.useMemo(() => findingsByPointer(result.findings), [result.findings]);

  /** Local, per-field coercion problems (e.g. `abc` in a number box) that never reach Ajv. */
  const coercionErrors = React.useMemo(
    () => collectCoercionErrors(formField, state),
    [formField, state]
  );

  const setValue = React.useCallback((pointer: string, value: string) => {
    setState((prev) => ({ ...prev, values: { ...prev.values, [pointer]: value } }));
  }, []);

  const setIncluded = React.useCallback((pointer: string, included: boolean) => {
    setState((prev) => ({ ...prev, included: { ...prev.included, [pointer]: included } }));
  }, []);

  const setArrayLength = React.useCallback((pointer: string, length: number) => {
    setState((prev) => ({
      ...prev,
      arrayLengths: { ...prev.arrayLengths, [pointer]: Math.max(0, length) },
    }));
  }, []);

  const addExtra = React.useCallback((pointer: string) => {
    setState((prev) => ({
      ...prev,
      extraNames: {
        ...(prev.extraNames ?? {}),
        [pointer]: [...(prev.extraNames?.[pointer] ?? []), ''],
      },
    }));
  }, []);

  const removeExtra = React.useCallback((pointer: string, index: number) => {
    setState((prev) => ({
      ...prev,
      extraNames: {
        ...(prev.extraNames ?? {}),
        [pointer]: (prev.extraNames?.[pointer] ?? []).filter((_unused, i) => i !== index),
      },
    }));
  }, []);

  // Renaming an entry moves what was typed under it: values are keyed by the entry's name, so
  // the subtree is re-keyed from the old name's pointer to the new one's.
  const renameExtra = React.useCallback((pointer: string, index: number, nextKey: string) => {
    setState((prev) => {
      const names = [...(prev.extraNames?.[pointer] ?? [])];
      const prevKey = names[index] ?? '';
      names[index] = nextKey;
      const moved =
        prevKey !== '' && nextKey !== '' && prevKey !== nextKey
          ? moveStateSubtree(prev, childPointer(pointer, prevKey), childPointer(pointer, nextKey))
          : prev;
      return { ...moved, extraNames: { ...(moved.extraNames ?? {}), [pointer]: names } };
    });
  }, []);

  const ctx: FieldContext = {
    state,
    findings,
    coercionErrors,
    setValue,
    setIncluded,
    setArrayLength,
    addExtra,
    removeExtra,
    renameExtra,
  };

  return (
    <div className="pd-test">
      {/* Mode and Reset act on the form, so they live with it rather than on the card header —
          which keeps them out of sight (and out of reach) while the card is collapsed. */}
      <div className="pd-test__bar">
        <Segmented
          size="sm"
          value={mode}
          onValueChange={(next) => setMode(next as TestMode)}
          aria-label="Test mode"
        >
          {TEST_MODES.map((option) => (
            <SegmentedItem
              key={option.id}
              value={option.id}
              data-testid={`primitive-test-mode-${option.id}`}
            >
              {option.label}
            </SegmentedItem>
          ))}
        </Segmented>
        <Button
          variant="ghost"
          size="sm"
          data-testid="primitive-test-reset"
          title="Reset the form to the generated example"
          onClick={() => setState(seedState(formField, mode))}
        >
          <RotateCcw aria-hidden />
          Reset
        </Button>
      </div>

      <VerdictBar
        status={result.status}
        findingCount={result.findings.length}
        schemaError={result.schemaError}
        hasCoercionError={coercionErrors.size > 0}
        unresolvedRefs={validator.unresolvedRefs}
      />

      <FieldNode field={formField} pointer="" ctx={ctx} depth={0} />

      {result.findings.length > 0 ? (
        <div className="pd-findings" data-testid="primitive-test-findings">
          <p className="pd-findings__title">
            <AlertCircle aria-hidden />
            {problemCount(result.findings.length)}
          </p>
          <ul className="pd-findings__list">
            {result.findings.map((finding, index) => (
              <li key={`${finding.pointer}-${finding.keyword}-${index}`} className="pd-finding">
                <span className="pd-finding__pointer">{finding.pointer || '(document root)'}</span>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The always-current verdict, and the caveat under it.
 *
 * @param props.status What the validator concluded.
 * @param props.findingCount How many findings it produced.
 * @param props.schemaError Why the schema would not compile, when it would not.
 * @param props.hasCoercionError Whether a box holds a value that cannot be read at all.
 * @param props.unresolvedRefs The `$ref` values the compile could not resolve.
 * @returns The bar, plus the loose-validation note when there is one.
 */
function VerdictBar({
  status,
  findingCount,
  schemaError,
  hasCoercionError,
  unresolvedRefs,
}: {
  status: TestStatus;
  findingCount: number;
  schemaError?: string;
  hasCoercionError: boolean;
  unresolvedRefs: readonly string[];
}) {
  const bar = computeVerdict({ status, findingCount, schemaError }, hasCoercionError);
  const note = looseValidationNote(unresolvedRefs);

  return (
    <div className="pd-stack">
      <Alert
        variant={bar.tone}
        role="status"
        aria-live="polite"
        data-testid="primitive-test-verdict"
        data-status={bar.status}
      >
        {bar.message}
      </Alert>
      {note ? (
        <Alert
          variant="neutral"
          className="pd-note"
          data-testid="primitive-test-unresolved-refs"
        >
          {note}
        </Alert>
      ) : null}
    </div>
  );
}

export default PrimitiveTestForm;
