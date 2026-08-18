'use client';

/**
 * The parts the five version dialogs share (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Overlays — every dialog opens with a tinted
 * icon tile beside its title and description (`hive.css` §12 `.icon-tile`, §16
 * `.dialog__header`), and three of them carry the same *Lifecycle* select and the same
 * *Successor revision* picker.
 *
 * Written once here so the New, Edit, Sunset, Publish and Spec dialogs cannot drift apart on
 * the shape of their head or the words in their shared fields.
 */

import * as React from 'react';

import { DialogDescription, DialogHeader, DialogTitle } from '@/app/components/ui/Dialog';
import { FormField } from '@/app/components/ui/FormField';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { cn } from '@lib/utils';

import {
  VERSION_LIFECYCLES,
  VERSION_LIFECYCLE_LABEL,
  type Version,
  type VersionLifecycle,
} from './versionsModel';

/** The tones the icon tile offers — the shared vocabulary's, as `.tnt-icon-tile` paints them. */
export type VersionDialogTone = 'accent' | 'ok' | 'warn' | 'danger' | 'violet' | 'honey';

export interface VersionDialogHeadProps {
  /** The glyph in the tile. */
  icon: React.ReactNode;
  /** The tile's tone. */
  tone: VersionDialogTone;
  /** The title. */
  title: React.ReactNode;
  /** One or two sentences under it. */
  description?: React.ReactNode;
}

/**
 * A dialog's head: the tile, the title and the description on one row.
 *
 * @param props See {@link VersionDialogHeadProps}.
 * @returns The header.
 */
export function VersionDialogHead({ icon, tone, title, description }: VersionDialogHeadProps) {
  return (
    <DialogHeader className="ver-dialog__head">
      <span className="tnt-icon-tile" data-tone={tone} aria-hidden>
        {icon}
      </span>
      <div className="ver-dialog__heading">
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </div>
    </DialogHeader>
  );
}

/** Radix `Select` cannot use the empty string as a value; this stands in for "no successor". */
export const SUCCESSOR_SELECT_NONE = '__none__';

export interface LifecycleSelectProps {
  /** The `id` of the trigger. */
  id: string;
  /** The value. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** The label. */
  label?: string;
  /** The line under the control. */
  helperText?: string;
}

/**
 * The lifecycle select — the four `#739` values.
 *
 * @param props See {@link LifecycleSelectProps}.
 * @returns The field.
 */
export function LifecycleSelect({
  id,
  value,
  onChange,
  disabled = false,
  label = 'Lifecycle',
  helperText,
}: LifecycleSelectProps) {
  return (
    <FormField label={label} htmlFor={id} helperText={helperText}>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} data-testid={`${id}-trigger`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VERSION_LIFECYCLES.map((lifecycle: VersionLifecycle) => (
            <SelectItem key={lifecycle} value={lifecycle}>
              {VERSION_LIFECYCLE_LABEL[lifecycle]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

export interface SuccessorRevisionFieldProps {
  /** The `id` of the trigger. */
  id: string;
  /** The stored successor revision id, `''` for none. */
  value: string;
  onChange: (next: string) => void;
  /** The other revisions of the same project, newest label first. */
  candidates: readonly Version[];
  disabled?: boolean;
  /** Extra classes on the field. */
  className?: string;
}

/**
 * The successor picker — labels are version ids, values are revision UUIDs.
 *
 * A stored successor that is not in the candidate list (a revision since deleted, or one the
 * lifecycle filter has hidden) is still offered as *Other revision (…)* so saving the form
 * does not silently clear it.
 *
 * @param props See {@link SuccessorRevisionFieldProps}.
 * @returns The field.
 */
export function SuccessorRevisionField({
  id,
  value,
  onChange,
  candidates,
  disabled = false,
  className,
}: SuccessorRevisionFieldProps) {
  const trimmed = value.trim();
  const orphan = trimmed && !candidates.some((candidate) => candidate.id === trimmed) ? trimmed : null;
  return (
    <FormField
      label="Successor revision"
      htmlFor={id}
      helperText="Optional. Pick the replacement by version label (stored as the successor revision id), or leave as end of life with no successor."
      className={cn(className)}
    >
      <Select
        value={trimmed || SUCCESSOR_SELECT_NONE}
        onValueChange={(next) => onChange(next === SUCCESSOR_SELECT_NONE ? '' : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id} data-testid={`${id}-trigger`}>
          <SelectValue placeholder="Choose a revision" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SUCCESSOR_SELECT_NONE}>No successor (end of life)</SelectItem>
          {orphan ? <SelectItem value={orphan}>Other revision ({orphan.slice(0, 8)}…)</SelectItem> : null}
          {candidates.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              v{candidate.version_id}
              {candidate.published ? ' · published' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}
