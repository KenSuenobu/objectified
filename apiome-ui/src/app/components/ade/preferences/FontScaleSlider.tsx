'use client';

import React from 'react';
import {
  FONT_SCALES,
  fontScaleById,
  fontScaleIndexOf,
  type FontScaleId,
} from '../../../config/preferences';

/**
 * The font-size control in the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1 item 2).
 *
 * Six discrete stops on a native `<input type="range">`: native because a range input is
 * already keyboard-operable, already announces its value, and already honours the
 * platform's own pointer conventions — none of which a div-and-drag reimplementation gets
 * for free. The stops are the ones `config/preferences.ts` declares, so the control cannot
 * offer a size the stylesheet has no rule for.
 *
 * Setting the preference re-sizes the root element, and every dimension in the token layer
 * is `rem` — so the preview card below the slider is not a mock-up of the effect, it *is*
 * the effect, rendered in the pane the reader is looking at.
 */

export interface FontScaleSliderProps {
  /** The current stop. */
  value: FontScaleId;
  /** Select a stop. Applies immediately. */
  onChange: (value: FontScaleId) => void;
}

export default function FontScaleSlider({ value, onChange }: FontScaleSliderProps) {
  const index = fontScaleIndexOf(value);
  const scale = fontScaleById(value);

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-fg">Font size</h3>
          <p className="text-xs text-fg-muted">Scales the whole interface, not just body text.</p>
        </div>
        <span
          data-testid="preferences-font-scale-label"
          className="shrink-0 rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-fg-muted"
        >
          {scale.label} · {scale.px}px
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3">
        {/* The A/A pair is the conventional size-slider affordance and carries no
            information the label and the input's own value do not. */}
        <span aria-hidden className="text-xs text-fg-subtle">
          A
        </span>
        <input
          type="range"
          data-testid="preferences-font-scale"
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-inset accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          min={0}
          max={FONT_SCALES.length - 1}
          step={1}
          value={index}
          aria-label="Font size"
          aria-valuetext={`${scale.label}, ${scale.px} pixels`}
          onChange={(event) => onChange(FONT_SCALES[Number(event.target.value)].id)}
        />
        <span aria-hidden className="text-lg text-fg-subtle">
          A
        </span>
      </div>

      {/* Stop names, aligned under the track. Decorative: the input announces its own
          value, and repeating the six labels to a screen reader would only add noise. */}
      <div aria-hidden className="mt-1 flex justify-between px-5 text-xs text-fg-faint">
        {FONT_SCALES.map((stop) => (
          <span key={stop.id}>{stop.label}</span>
        ))}
      </div>

      <div className="mt-3 rounded-md bg-subtle p-3">
        <p className="text-sm font-semibold text-fg">Preview</p>
        <p className="text-sm text-fg-muted">
          Orders Service · v1.9.2 · 14 paths, 32 schemas · Published 3 days ago
        </p>
        <p className="mono mt-1 text-xs text-fg-muted">GET /orders/{'{orderId}'} → 200 Order</p>
      </div>
    </div>
  );
}
