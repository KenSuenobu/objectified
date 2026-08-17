'use client';

import React, { useCallback, useRef } from 'react';
import { Rows3, Rows4 } from 'lucide-react';
import { DENSITIES, type DensityId } from '../../../config/preferences';

/**
 * The density control in the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1 item 3).
 *
 * A segmented control, and — like the theme grid — a real radiogroup: two options, one tab
 * stop, arrow keys between them, selection following focus. It is not a tab strip
 * (`tabStyles.ts` draws those as underlines) because it changes how the current pane is
 * drawn rather than naming a destination, which is exactly the distinction that file
 * makes.
 *
 * Density swaps spacing tokens only, so switching re-flows the shell without repainting
 * it; `tests/hive-preference-blocks.test.ts` holds that line in the stylesheet.
 */

/** The icon each step is illustrated with — roomier rows, then tighter ones. */
const DENSITY_ICONS: Record<DensityId, typeof Rows3> = {
  comfortable: Rows3,
  compact: Rows4,
};

export interface DensitySegmentedProps {
  /** The current step. */
  value: DensityId;
  /** Select a step. Applies immediately. */
  onChange: (value: DensityId) => void;
}

export default function DensitySegmented({ value, onChange }: DensitySegmentedProps) {
  /** The option buttons, indexed as {@link DENSITIES} is. */
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * Move between the two steps with the arrow keys, wrapping at either end.
   *
   * @param event The keydown on an option.
   * @param index The option's position in {@link DENSITIES}.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
      const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      if (!forward && !backward) return;

      event.preventDefault();
      const last = DENSITIES.length - 1;
      const next = forward ? (index === last ? 0 : index + 1) : index === 0 ? last : index - 1;

      onChange(DENSITIES[next].id);
      optionRefs.current[next]?.focus();
    },
    [onChange],
  );

  return (
    <div>
      <h3 className="text-base font-semibold text-fg">Density</h3>
      <p className="text-xs text-fg-muted">
        Compact tightens rows, controls and page padding for large screens.
      </p>

      <div
        role="radiogroup"
        aria-label="Density"
        data-testid="preferences-density-group"
        className="mt-3 inline-flex rounded-md bg-inset p-0.5"
      >
        {DENSITIES.map((density, index) => {
          const Icon = DENSITY_ICONS[density.id];
          const selected = density.id === value;

          return (
            <button
              key={density.id}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-density-option={density.id}
              onClick={() => onChange(density.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-3 py-1.5 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                selected ? 'bg-surface text-fg shadow-raised' : 'text-fg-muted hover:text-fg'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {/* On the span, not the button: Radix Themes' unlayered `button` reset
                  outranks Tailwind's type utilities. */}
              <span className="text-sm">{density.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
