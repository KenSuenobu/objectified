'use client';

import { Segmented, SegmentedItem } from '../../../ui/Segmented';
import type { OptionField } from './exportTargetCatalog';

export interface ExportOptionsFormProps {
  /** The selected target's key, used to namespace input ids/names. */
  targetKey: string;
  /** The rendered option fields from `optionFieldsFromSchema`. */
  fields: OptionField[];
  /** Current values keyed by option key. */
  values: Record<string, unknown>;
  /** Per-field validation errors keyed by option key (from `validateExportOptions`), if any. */
  errors?: Record<string, string>;
  /** Update one option's value. */
  onChange: (key: string, value: unknown) => void;
}

/**
 * ExportOptionsForm — the generated per-emitter options form (MFX-1.4), shared by the
 * ExportDialog (MFX-6.1, #3855) and the Export Studio (MFX-41.1, #4348).
 *
 * Renders one control per primitive option field the target's JSON Schema exposes: a checkbox
 * for booleans, a segmented button row for string enums, and a text input for free strings.
 * Complex option types never reach here — `optionFieldsFromSchema` already filters them out, so
 * the emit request leaves them at their server-side defaults. A field's validation error (from
 * `validateExportOptions`) renders inline beneath its control.
 */
export function ExportOptionsForm({
  targetKey,
  fields,
  values,
  errors,
  onChange,
}: ExportOptionsFormProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => (
        <ExportOptionControl
          key={field.key}
          targetKey={targetKey}
          field={field}
          value={values[field.key]}
          error={errors?.[field.key]}
          onChange={(value) => onChange(field.key, value)}
        />
      ))}
    </div>
  );
}

interface ExportOptionControlProps {
  /** The selected target's key, used to namespace input ids/names. */
  targetKey: string;
  field: OptionField;
  value: unknown;
  /** The field's validation error message, when the value is invalid. */
  error?: string;
  onChange: (value: unknown) => void;
}

/**
 * One per-target option control (MFX-1.4): a checkbox for booleans, a segmented button row for
 * string enums, and a text input for free strings. Complex option types never reach here —
 * `optionFieldsFromSchema` already filters them out.
 */
export function ExportOptionControl({ targetKey, field, value, error, onChange }: ExportOptionControlProps) {
  const inputId = `export-option-${targetKey}-${field.key}`;
  const errorId = `${inputId}-error`;
  const errorNote = error ? (
    <p id={errorId} className="xstd-field__error">
      {error}
    </p>
  ) : null;

  if (field.kind === 'boolean') {
    return (
      <div>
        <label className="xstd-field__label xstd-check" htmlFor={inputId}>
          <input
            id={inputId}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="mt-0.5"
          />
          <span>
            <span className="xstd-field__name block">{field.label}</span>
            {field.description && (
              <span className="xstd-field__desc">{field.description}</span>
            )}
          </span>
        </label>
        {errorNote}
      </div>
    );
  }

  if (field.kind === 'enum') {
    return (
      <div className="text-sm">
        <div id={`${inputId}-label`} className="xstd-field__name">
          {field.label}
        </div>
        {field.description && <div className="xstd-field__desc mt-0.5">{field.description}</div>}
        {/* The mockup's "enum segmented": the shared primitive, which brings the roving
            tab stop and the arrow keys the hand-built button row never had. */}
        <Segmented
          className="mt-2"
          size="sm"
          value={typeof value === 'string' ? value : undefined}
          onValueChange={onChange}
          aria-labelledby={`${inputId}-label`}
        >
          {field.enumValues.map((option) => (
            <SegmentedItem key={option} value={option}>
              {option}
            </SegmentedItem>
          ))}
        </Segmented>
        {errorNote}
      </div>
    );
  }

  return (
    <div className="text-sm">
      <label className="xstd-field__name" htmlFor={inputId}>
        {field.label}
      </label>
      {field.description && <div className="xstd-field__desc mt-0.5">{field.description}</div>}
      <input
        id={inputId}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        placeholder={field.required ? 'required' : 'server default'}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="input mt-2 w-full"
      />
      {errorNote}
    </div>
  );
}

export default ExportOptionsForm;
