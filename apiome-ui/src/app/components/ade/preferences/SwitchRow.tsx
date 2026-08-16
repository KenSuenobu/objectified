'use client';

import React, { useId } from 'react';

/**
 * One labelled switch in the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1 item 4).
 *
 * Four preferences are simply on or off and all four look the same, so this renders the
 * row and the pane supplies the copy from `SWITCH_PREFERENCES` — no component names a
 * preference twice.
 *
 * The control is a `<button role="switch">` rather than the shared `ui/Switch`: that
 * primitive is a hidden checkbox inside a `<label>`, which cannot carry the title/description
 * pair as its accessible name without either duplicating the text or nesting interactive
 * content in the label. A button takes `aria-labelledby`/`aria-describedby` and reads as
 * "Reduce motion, switch, off — turn off transitions and animated progress", which is the
 * whole row.
 */

export interface SwitchRowProps {
  /** Row title, and the switch's accessible name. */
  title: string;
  /** One-line explanation, and the switch's accessible description. */
  description: string;
  /** Whether the switch is on. */
  checked: boolean;
  /** Value for the row's `data-switch` hook, so a test can address one row by preference. */
  name: string;
  /** Flip the switch. Applies immediately. */
  onCheckedChange: (checked: boolean) => void;
}

export default function SwitchRow({
  title,
  description,
  checked,
  name,
  onCheckedChange,
}: SwitchRowProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0">
        <p id={titleId} className="text-sm font-medium text-fg">
          {title}
        </p>
        <p id={descriptionId} className="text-xs text-fg-muted">
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-switch={name}
        onClick={() => onCheckedChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
          checked ? 'bg-accent' : 'bg-inset'
        }`}
      >
        <span
          aria-hidden
          className={`pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-surface shadow-xs transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
