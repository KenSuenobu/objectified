'use client';

/**
 * The field tree of the "Test this type" card (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Test this type — the property rows with
 * their include boxes, type hints and required pills; the unresolved-`$ref` raw-JSON hint; the
 * live `pattern` line; the `additionalProperties` rows with their duplicate-name error; and the
 * array's `[i]` boxes.
 *
 * Split from `PrimitiveTestForm.tsx` because the two halves answer different questions. That
 * file owns the card: whether it is open, which mode it is in, what the verdict says. This one
 * owns one node of a recursive tree and knows nothing about any of that — which is also what
 * makes the row rhythm statable once, in `.pd-prop`, rather than per depth.
 *
 * ### What this replaces
 *
 * `text-xs font-medium text-gray-700 dark:text-gray-300` labels, `text-2xs text-gray-500`
 * hints, a `text-indigo-600 focus:ring-indigo-500` native checkbox, `bg-indigo-50 …
 * dark:bg-indigo-950/50` required pills, `border-slate-300 … dark:bg-slate-800` selects,
 * `border-gray-200 … dark:hover:bg-gray-800` add/remove buttons, and four spellings of
 * `text-red-600 dark:text-red-400` for an error sentence. Every one is a token now, and every
 * error sentence is `--fg` with a coloured glyph — `--danger-fg` measures 1.47:1 on the surface
 * in Nord, so the hue emphasises and the words carry the message.
 */

import * as React from 'react';
import { AlertCircle, Check, Plus, Trash2, X } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { Input } from '@/app/components/ui/Input';
import {
  arrayLength,
  childPointer,
  describePlaceholder,
  extraKeyIssue,
  extraNamesAt,
  isIncluded,
  itemPointer,
  patternMatches,
  type TestField,
  type TestFinding,
  type TestFormState,
} from '@/app/ade/dashboard/primitives/primitiveTestForm';

import {
  EMPTY_OBJECT_NOTE,
  NO_ITEM_SCHEMA_NOTE,
  OMITTED_NOTE,
  describeFieldType,
  extraKeyMessage,
  isScalarField,
  patternMatchAttribute,
  patternVerdictLabel,
} from './primitiveDetailView';

/** Everything one node of the tree needs that it cannot derive from its own field. */
export interface FieldContext {
  state: TestFormState;
  /** Ajv findings, grouped by the pointer they anchor to. */
  findings: Map<string, TestFinding[]>;
  /** Per-field problems that never reached Ajv, by pointer. */
  coercionErrors: Map<string, string>;
  setValue: (pointer: string, value: string) => void;
  setIncluded: (pointer: string, included: boolean) => void;
  setArrayLength: (pointer: string, length: number) => void;
  /** Append a blank dynamic entry to an `additionalProperties` object. */
  addExtra: (pointer: string) => void;
  /** Remove one dynamic entry row. */
  removeExtra: (pointer: string, index: number) => void;
  /** Rename one dynamic entry, migrating the state typed under its old name. */
  renameExtra: (pointer: string, index: number, key: string) => void;
}

/** The id a scalar's control carries, so its property name can be a real `<label for>`. */
function controlId(pointer: string): string {
  return `field-${pointer || 'root'}`;
}

/**
 * Render one node of the form tree: object fieldset, array list, or scalar input.
 *
 * @param props.field The projected field.
 * @param props.pointer Its JSON Pointer in the instance being built.
 * @param props.ctx See {@link FieldContext}.
 * @param props.depth How deep the node sits, which decides whether it draws its own box.
 * @returns The node.
 */
export function FieldNode({
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
    if (children.length === 0 && !field.additional) {
      return <p className="prm-hint">{EMPTY_OBJECT_NOTE}</p>;
    }
    return (
      <div className={depth > 0 ? 'pd-nested' : undefined}>
        <div className="pd-props">
          {children.map((child) => {
            const childPtr = childPointer(pointer, child.key);
            return (
              <PropertyRow
                key={child.key}
                field={child}
                pointer={childPtr}
                ctx={ctx}
                depth={depth}
                included={isIncluded(ctx.state, childPtr, child)}
              />
            );
          })}
        </div>
        {field.additional ? (
          <AdditionalPropertiesSection field={field} pointer={pointer} ctx={ctx} depth={depth} />
        ) : null}
      </div>
    );
  }

  if (field.kind === 'array') {
    return <ArrayNode field={field} pointer={pointer} ctx={ctx} depth={depth} />;
  }

  return <ScalarInput field={field} pointer={pointer} ctx={ctx} />;
}

/**
 * One object property: its include box, its name and hint, and its editor.
 *
 * Every property can be switched off — including a required one, which is what lets a reader
 * watch the `required` finding appear live rather than taking the schema's word for it.
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
  const scalar = isScalarField(field);
  const id = controlId(pointer);

  return (
    <div className="pd-prop">
      <span className="pd-prop__check">
        <Checkbox
          checked={included}
          data-testid={`primitive-test-include-${pointer}`}
          aria-label={`Include ${field.key}`}
          onCheckedChange={(next) => ctx.setIncluded(pointer, next === true)}
        />
      </span>
      <div className="pd-prop__body">
        <div className="pd-prop__head">
          {/* A container is a group of controls, so its name is a span: a `<label for>` there
              would point at an id nothing carries, which is what the pre-Hive form did. */}
          {scalar ? (
            <label htmlFor={id} className="pd-prop__name mono">
              {field.key}
            </label>
          ) : (
            <span className="pd-prop__name mono">{field.key}</span>
          )}
          <span className="pd-type-hint">{describeFieldType(field)}</span>
          {field.required ? <Badge variant="rose">required</Badge> : null}
        </div>
        {field.description ? <p className="prm-hint">{field.description}</p> : null}
        {included ? (
          <div className="pd-prop__editor">
            <FieldNode field={field} pointer={pointer} ctx={ctx} depth={depth + 1} />
          </div>
        ) : (
          <p className="prm-hint pd-prop__editor">{OMITTED_NOTE}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The dynamic entries of an `additionalProperties` object: named rows the reader adds.
 *
 * Each row is a name box plus a value editor built from the `additionalProperties` schema. The
 * value lives at the ordinary child pointer of the typed name, so an Ajv finding for
 * `/static/myKey` anchors onto the row exactly as it would for a declared property. A row whose
 * name is empty or duplicates a declared property is kept out of the instance and says so in
 * place of its editor.
 */
function AdditionalPropertiesSection({
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
  const template = field.additional as TestField;
  const names = extraNamesAt(ctx.state, pointer);
  const hasDeclared = (field.children ?? []).length > 0;

  return (
    <div className="pd-nested" data-testid={`primitive-test-extras-${pointer}`}>
      <div>
        <p className="pd-nested__title">
          Additional properties (<span className="mono">{describeFieldType(template)}</span>)
        </p>
        <p className="prm-hint">
          {hasDeclared
            ? 'Beyond the properties above, this object takes dynamic property names.'
            : 'This object takes dynamic property names, each with a value of that type.'}
        </p>
      </div>

      {names.map((name, index) => {
        const issue = extraKeyIssue(field, names, index);
        const valuePtr = childPointer(pointer, name);
        return (
          // Rows are keyed by position: the name is the value being edited, so it cannot key
          // the row without remounting (and losing focus in) the box on every keystroke.
          <div key={index} className="pd-nested">
            <div className="pd-nested__head">
              <Input
                data-testid={`primitive-test-extra-key-${pointer}/${index}`}
                aria-label="Property name"
                value={name}
                placeholder="property name"
                onChange={(event) => ctx.renameExtra(pointer, index, event.target.value)}
                className="pd-extra-key mono"
              />
              <Button
                variant="ghost"
                size="sm"
                data-testid={`primitive-test-extra-remove-${pointer}/${index}`}
                aria-label={`Remove property ${name || index}`}
                onClick={() => ctx.removeExtra(pointer, index)}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            </div>
            {issue === null ? (
              <FieldNode field={template} pointer={valuePtr} ctx={ctx} depth={depth + 1} />
            ) : (
              <p
                className="prm-caution"
                data-testid={`primitive-test-extra-issue-${pointer}/${index}`}
              >
                <AlertCircle aria-hidden />
                <span>{extraKeyMessage(issue, name)}</span>
              </p>
            )}
          </div>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        data-testid={`primitive-test-extra-add-${pointer}`}
        onClick={() => ctx.addExtra(pointer)}
        className="self-start"
      >
        <Plus aria-hidden />
        Add property
      </Button>
    </div>
  );
}

/** A repeatable list: one editor per element, with add and remove. */
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

  if (!item) return <p className="prm-hint">{NO_ITEM_SCHEMA_NOTE}</p>;

  return (
    <div className="pd-list" data-testid={`primitive-test-array-${pointer}`}>
      {Array.from({ length: count }, (_unused, index) => {
        const elementPtr = itemPointer(pointer, index);
        return (
          <div key={elementPtr} className="pd-nested">
            <div className="pd-nested__head">
              <span className="pd-type-hint">[{index}]</span>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`primitive-test-array-remove-${elementPtr}`}
                aria-label={`Remove item ${index}`}
                onClick={() => ctx.setArrayLength(pointer, count - 1)}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            </div>
            <FieldNode field={item} pointer={elementPtr} ctx={ctx} depth={depth + 1} />
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        data-testid={`primitive-test-array-add-${pointer}`}
        onClick={() => ctx.setArrayLength(pointer, count + 1)}
        className="self-start"
      >
        <Plus aria-hidden />
        Add item
      </Button>
      <FieldFindings findings={nodeFindings} pointer={pointer} />
    </div>
  );
}

/** A scalar editor plus its live regex line and its own findings. */
function ScalarInput({
  field,
  pointer,
  ctx,
}: {
  field: TestField;
  pointer: string;
  ctx: FieldContext;
}) {
  const raw = ctx.state.values[pointer] ?? '';
  const id = controlId(pointer);
  const nodeFindings = ctx.findings.get(pointer) ?? [];
  const coercionError = ctx.coercionErrors.get(pointer);
  const invalid = nodeFindings.length > 0 || coercionError !== undefined;

  // The live regex verdict — recomputed on every render, i.e. on every keystroke.
  const patternState = field.pattern !== undefined ? patternMatches(field.pattern, raw) : undefined;

  return (
    <div className="pd-stack">
      {field.kind === 'boolean' ? (
        <select
          id={id}
          data-testid={`primitive-test-input-${pointer}`}
          aria-invalid={invalid || undefined}
          value={raw === 'true' ? 'true' : 'false'}
          onChange={(event) => ctx.setValue(pointer, event.target.value)}
          className="hive-control prm-select prm-select--inline"
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : field.kind === 'enum' ? (
        <select
          id={id}
          data-testid={`primitive-test-input-${pointer}`}
          aria-invalid={invalid || undefined}
          value={raw}
          onChange={(event) => ctx.setValue(pointer, event.target.value)}
          className="hive-control prm-select prm-select--inline"
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
          id={id}
          data-testid={`primitive-test-input-${pointer}`}
          aria-invalid={invalid || undefined}
          value={raw}
          inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
          placeholder={describePlaceholder(field)}
          onChange={(event) => ctx.setValue(pointer, event.target.value)}
          className="pd-input mono"
        />
      )}

      {field.pattern !== undefined ? (
        <PatternIndicator pattern={field.pattern} matches={patternState} pointer={pointer} />
      ) : null}

      {field.unresolvedRef ? (
        <p className="prm-hint">
          References <span className="mono">{field.unresolvedRef}</span>, which is not resolved
          here — enter raw JSON and expect only local constraints to be checked.
        </p>
      ) : null}

      {coercionError ? (
        <p className="prm-caution" data-testid={`primitive-test-coercion-${pointer}`}>
          <AlertCircle aria-hidden />
          <span>{coercionError}</span>
        </p>
      ) : null}

      <FieldFindings findings={nodeFindings} pointer={pointer} />
    </div>
  );
}

/**
 * The live `pattern` verdict shown beside a regex-constrained box.
 *
 * This is the button that isn't here: the regex runs on every render, so the line flips as the
 * reader types instead of waiting on a click.
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
  return (
    <p
      className="pd-pattern"
      data-testid={`primitive-test-pattern-${pointer}`}
      data-matches={patternMatchAttribute(matches)}
    >
      {matches === null ? (
        <AlertCircle aria-hidden />
      ) : matches ? (
        <Check aria-hidden />
      ) : (
        <X aria-hidden />
      )}
      <span className="pd-pattern__regex">{pattern}</span>
      <span>{patternVerdictLabel(matches ?? null)}</span>
    </p>
  );
}

/** The Ajv findings anchored to one node. */
export function FieldFindings({
  findings,
  pointer,
}: {
  findings: readonly TestFinding[];
  pointer: string;
}) {
  if (findings.length === 0) return null;
  return (
    <ul className="pd-field-findings" data-testid={`primitive-test-field-findings-${pointer}`}>
      {findings.map((finding, index) => (
        <li key={`${finding.keyword}-${index}`} className="prm-error">
          {finding.message}
        </li>
      ))}
    </ul>
  );
}
