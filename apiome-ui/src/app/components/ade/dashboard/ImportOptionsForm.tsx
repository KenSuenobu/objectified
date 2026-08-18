'use client';

import { Input } from '../../../components/ui/Input';
import type { ImportNamingConvention, ImportOptions } from './PreviewPanel';

/**
 * Which option groups to render.
 * - `naming`: apply-naming-convention toggle, class/property convention selects, class prefix/suffix.
 * - `flags`: generate-examples, dry-run, incremental-mode checkboxes.
 */
export type ImportOptionsSection = 'naming' | 'flags';

interface ImportOptionsFormProps {
  /** Current import options being edited. */
  options: ImportOptions;
  /** Apply a single option change. Mirrors PreviewPanel's handleOptionChange(key, value). */
  onOptionChange: <K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) => void;
  /** Option groups to render, in order. Defaults to both `naming` then `flags`. */
  sections?: ImportOptionsSection[];
  /** Hide the dry-run checkbox (e.g. when the caller drives dry-run separately). */
  showDryRun?: boolean;
  /** Hide the incremental-mode checkbox. */
  showIncrementalMode?: boolean;
}

/** The five naming conventions, in the order the selects offer them. */
const NAMING_CONVENTIONS: ReadonlyArray<{ value: ImportNamingConvention; label: string }> = [
  { value: 'PascalCase', label: 'PascalCase' },
  { value: 'camelCase', label: 'camelCase' },
  { value: 'snake_case', label: 'snake_case' },
  { value: 'kebab-case', label: 'kebab-case' },
  { value: 'none', label: 'None (keep original)' },
];

/**
 * One checkbox with its name and the sentence explaining it.
 *
 * @param props The control's id, its label, the sentence under it, and the usual checkbox pair.
 * @returns The row.
 */
function OptionCheck({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex cursor-pointer items-center gap-2">
        <input
          id={id}
          type="checkbox"
          className="imp-check"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-sm font-medium text-fg">{label}</span>
      </label>
      <p className="ps-6 text-xs text-fg-muted">{hint}</p>
    </div>
  );
}

/**
 * Shared import-options editor used by both the Projects dashboard import dialog
 * (`PreviewPanel`) and the repository file import flow (`RepositoryFileImportMapping`).
 *
 * It owns no state: the parent holds the `ImportOptions` and applies each change
 * via `onOptionChange`, keeping a single source of truth.
 *
 * Re-skinned by HIVE-6.4 (#5315). The two text fields are now the shared `Input`; the selects
 * and checkboxes stay native, because the repository flow renders this form too and both
 * surfaces' suites drive them with `displayValue` and a `change` event — replacing them with
 * the Radix primitives would have been a migration of two flows and their tests rather than a
 * restyle. Their chrome is `globals.css` §IMPORT WIZARD's `.imp-select` / `.imp-check`, so they
 * follow the theme, the density and the six font scales like every other control in the dialog.
 */
export function ImportOptionsForm({
  options,
  onOptionChange,
  sections = ['naming', 'flags'],
  showDryRun = true,
  showIncrementalMode = true,
}: ImportOptionsFormProps) {
  const applyNaming = options.applyNamingConvention ?? true;

  return (
    <>
      {sections.includes('naming') && (
        /* Naming convention enforcement (#581) */
        <div className="col-span-4 flex flex-col gap-3 pt-2">
          <OptionCheck
            id="import-apply-naming"
            label="Apply naming convention"
            hint="Convert class and property names to match your chosen conventions (e.g. PascalCase for classes, camelCase for properties)."
            checked={applyNaming}
            onChange={(next) => onOptionChange('applyNamingConvention', next)}
          />

          {applyNaming && (
            <div className="flex flex-wrap gap-4 ps-6">
              <div className="min-w-[9rem] flex-1">
                <label
                  htmlFor="import-class-convention"
                  className="imp-tile__label mb-1 block"
                >
                  Classes
                </label>
                <select
                  id="import-class-convention"
                  className="hive-control imp-select"
                  value={options.classNamingConvention ?? 'PascalCase'}
                  onChange={(e) =>
                    onOptionChange('classNamingConvention', e.target.value as ImportNamingConvention)
                  }
                >
                  {NAMING_CONVENTIONS.map((convention) => (
                    <option key={convention.value} value={convention.value}>
                      {convention.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-[9rem] flex-1">
                <label
                  htmlFor="import-property-convention"
                  className="imp-tile__label mb-1 block"
                >
                  Properties
                </label>
                <select
                  id="import-property-convention"
                  className="hive-control imp-select"
                  value={options.propertyNamingConvention ?? 'camelCase'}
                  onChange={(e) =>
                    onOptionChange('propertyNamingConvention', e.target.value as ImportNamingConvention)
                  }
                >
                  {NAMING_CONVENTIONS.map((convention) => (
                    <option key={convention.value} value={convention.value}>
                      {convention.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="mt-1 flex flex-wrap gap-4 border-t border-border ps-6 pt-3">
            <div className="min-w-[9rem] flex-1">
              <label htmlFor="import-class-prefix" className="imp-tile__label mb-1 block">
                Class name prefix
              </label>
              <Input
                id="import-class-prefix"
                type="text"
                value={options.classPrefix ?? ''}
                onChange={(e) => onOptionChange('classPrefix', e.target.value)}
                placeholder="e.g. Api"
              />
            </div>
            <div className="min-w-[9rem] flex-1">
              <label htmlFor="import-class-suffix" className="imp-tile__label mb-1 block">
                Class name suffix
              </label>
              <Input
                id="import-class-suffix"
                type="text"
                value={options.classSuffix ?? ''}
                onChange={(e) => onOptionChange('classSuffix', e.target.value)}
                placeholder="e.g. Dto"
              />
            </div>
          </div>
          <p className="ps-6 text-xs text-fg-muted">
            Prefix and suffix are applied to every imported class name (e.g. Api + User + Dto →
            ApiUserDto).
          </p>
        </div>
      )}

      {sections.includes('flags') && (
        <>
          {/* Generate examples for properties without examples (#761) */}
          <div className="col-span-4 pt-2">
            <OptionCheck
              id="import-generate-examples"
              label="Generate examples"
              hint="Auto-generate example values for properties that don't have one (string, number, date, etc.)."
              checked={options.generateExamples ?? false}
              onChange={(next) => onOptionChange('generateExamples', next)}
            />
          </div>

          {showDryRun && (
            /* Dry run: preview without committing */
            <div className="col-span-4 pt-2">
              <OptionCheck
                id="import-dry-run"
                label="Dry run (preview only)"
                hint="Simulate the import and show what would be created. No project or data is saved."
                checked={options.dryRun ?? false}
                onChange={(next) => onOptionChange('dryRun', next)}
              />
            </div>
          )}

          {showIncrementalMode && (
            /* Incremental mode: skip failures */
            <div className="col-span-4 pt-2">
              <OptionCheck
                id="import-incremental-mode"
                label="Incremental mode (skip failures)"
                hint="Import all available classes and skip any that fail. Changes are saved as each class is imported; no single transaction."
                checked={options.incrementalMode ?? false}
                onChange={(next) => onOptionChange('incrementalMode', next)}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
