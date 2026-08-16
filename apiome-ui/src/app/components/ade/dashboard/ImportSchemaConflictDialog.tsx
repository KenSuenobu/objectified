'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../ui/Dialog';
import { cn } from '../../../../../lib/utils';
import { Button } from '../../ui/Button';
import { RadioGroup, RadioGroupItem } from '../../ui/RadioGroup';
import {
  computeSchemaPropertyDiff,
  schemaSnippet,
  type SchemaPropertyDiffRow,
} from '../../../utils/schema-import-property-diff';

export type ImportDuplicateResolutionChoice = 'merge' | 'replace' | 'keep' | 'rename';

export interface ImportSchemaConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaName: string;
  existingSchema: unknown;
  importedSchema: unknown;
  /** When false, existing body was not available (e.g. no stored definition). */
  hasExistingBody: boolean;
  initialResolution: ImportDuplicateResolutionChoice;
  renameSuffix: string;
  onApply: (choice: ImportDuplicateResolutionChoice) => void;
}

function DiffBadge({ kind }: { kind: 'NEW' | 'MOD' | 'REM' }) {
  const cls =
    kind === 'NEW'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
      : kind === 'MOD'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200'
        : 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200';
  return (
    <span className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide ${cls}`}>
      {kind}
    </span>
  );
}

function PropertyBlock({ title, row, side }: { title: string; row: SchemaPropertyDiffRow; side: 'left' | 'right' }) {
  const showLeft = side === 'left';
  const body =
    row.status === 'added'
      ? showLeft
        ? null
        : row.imported
      : row.status === 'removed'
        ? showLeft
          ? row.existing
          : null
        : showLeft
          ? row.existing
          : row.imported;

  if (body === null || body === undefined) {
    return (
      <div className="min-h-[1.5rem] border-b border-gray-100 dark:border-gray-800 py-2 text-gray-400 dark:text-gray-600">
        —
      </div>
    );
  }

  const badge =
    row.status === 'added' && !showLeft ? (
      <DiffBadge kind="NEW" />
    ) : row.status === 'removed' && showLeft ? (
      <DiffBadge kind="REM" />
    ) : row.status === 'modified' ? (
      <DiffBadge kind="MOD" />
    ) : null;

  return (
    <div className="border-b border-gray-100 dark:border-gray-800 py-2">
      <div className="flex flex-wrap items-baseline gap-x-1">
        <span className="font-semibold text-gray-800 dark:text-gray-200">{title}</span>
        {badge}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-all text-2xs leading-snug text-gray-600 dark:text-gray-400">
        {schemaSnippet(body)}
      </pre>
    </div>
  );
}

function summarizeModified(rows: SchemaPropertyDiffRow[]): string | null {
  const first = rows.find((r) => r.status === 'modified');
  if (!first) return null;
  return first.name;
}

/**
 * Schema diff and resolution UI for duplicate-schema import conflicts (#298).
 */
export function ImportSchemaConflictDialog({
  open,
  onOpenChange,
  schemaName,
  existingSchema,
  importedSchema,
  hasExistingBody,
  initialResolution,
  renameSuffix,
  onApply,
}: ImportSchemaConflictDialogProps) {
  const [choice, setChoice] = useState<ImportDuplicateResolutionChoice>(initialResolution);

  const diff = useMemo(() => {
    if (!hasExistingBody) {
      return computeSchemaPropertyDiff({}, importedSchema);
    }
    return computeSchemaPropertyDiff(existingSchema, importedSchema);
  }, [existingSchema, importedSchema, hasExistingBody]);

  const modifiedHint = summarizeModified(diff.rows);

  const handleApply = () => {
    onApply(choice);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Uses z-[10000]/[10001] so the overlay and content sit above any parent Dialog (z-9999) */}
      <DialogPortal>
        <DialogOverlay className="z-[10000]" />
        <DialogPrimitive.Content
          ref={undefined}
          className={cn(
            'fixed left-[50%] top-[50%] z-[10001] w-full translate-x-[-50%] translate-y-[-50%]',
            'max-h-[90vh] max-w-5xl overflow-hidden flex flex-col gap-0 p-0',
            'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg rounded-xl',
          )}
          aria-describedby={undefined}
        >
        <DialogHeader className="border-b border-gray-200 dark:border-gray-700 px-6 py-4 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="text-lg font-semibold text-gray-900 dark:text-white pr-8">
              Schema Diff: {schemaName}
            </DialogTitle>
            <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!hasExistingBody && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
              The existing class definition is not available for comparison. Showing imported properties only;
              counts may not reflect removals or modifications against the live class.
            </div>
          )}

          <div className="grid grid-cols-1 gap-0 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 md:grid-cols-2">
            <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300 md:border-b-0 md:border-r">
              Current (Existing)
            </div>
            <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300">
              Imported (New)
            </div>
            <div className="max-h-[min(22rem,40vh)] overflow-y-auto border-gray-200 px-3 pb-2 dark:border-gray-700 md:border-r">
              {diff.rows.map((row) => (
                <PropertyBlock key={`l-${row.name}`} title={`${row.name}:`} row={row} side="left" />
              ))}
            </div>
            <div className="max-h-[min(22rem,40vh)] overflow-y-auto px-3 pb-2">
              {diff.rows.map((row) => (
                <PropertyBlock key={`r-${row.name}`} title={`${row.name}:`} row={row} side="right" />
              ))}
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/30">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
              Summary
            </h4>
            <ul className="space-y-1 text-sm text-gray-800 dark:text-gray-200">
              <li>
                <span className="text-emerald-600 dark:text-emerald-400">+</span>{' '}
                {diff.addedCount} propert{diff.addedCount === 1 ? 'y' : 'ies'} added
              </li>
              <li>
                <span className="text-amber-600 dark:text-amber-400">~</span>{' '}
                {diff.modifiedCount} propert{diff.modifiedCount === 1 ? 'y' : 'ies'} modified
                {modifiedHint ? ` (${modifiedHint})` : ''}
              </li>
              <li>
                <span className="text-rose-600 dark:text-rose-400">−</span>{' '}
                {diff.removedCount} propert{diff.removedCount === 1 ? 'y' : 'ies'} removed
              </li>
            </ul>
          </div>

          <div className="mt-6">
            <p className="mb-2 text-sm font-medium text-gray-800 dark:text-gray-200">Resolution</p>
            <RadioGroup value={choice} onValueChange={(v) => setChoice(v as ImportDuplicateResolutionChoice)}>
              <RadioGroupItem
                value="merge"
                name="import-conflict-resolution"
                label="Merge — add new properties and combine with existing per merge strategy"
              />
              <RadioGroupItem
                value="replace"
                name="import-conflict-resolution"
                label="Replace — imported schema replaces the existing class"
              />
              <RadioGroupItem
                value="keep"
                name="import-conflict-resolution"
                label="Keep current — do not import this conflicting class"
              />
              <RadioGroupItem
                value="rename"
                name="import-conflict-resolution"
                label={`Rename — import as a new class (suffix: ${renameSuffix.trim() || 'Imported'})`}
              />
            </RadioGroup>
          </div>
        </div>

        <DialogFooter className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 shrink-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleApply}>
            Apply
          </Button>
        </DialogFooter>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
