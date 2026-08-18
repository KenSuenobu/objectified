'use client';

import * as React from 'react';
import { PencilLine, Save } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Spinner } from '@/app/components/ui/Spinner';

/**
 * The sticky unsaved bar — HIVE-5.7 (#5310).
 *
 * Authority: `docs/mockups/govern/style-guide-detail.html` `.save-bar`, on both the rule
 * catalog and the custom-rules tab.
 *
 * ### Why it is a component rather than markup in each tab
 *
 * The two tabs' bars said different things in the screen this replaces — one was a
 * full-bleed strip pinned to the bottom of the page, the other a strip inside the panel,
 * and only one of them routed Discard through a confirm. They are the same object: *you
 * have changed something and not saved it*. Written once, a reader learns the shape once,
 * and the third tab can adopt it without a fourth spelling appearing.
 *
 * The bar is `position: sticky` at the bottom of its own panel rather than `fixed`: it has
 * to sit above the panel it belongs to and disappear with it when the tab changes, which a
 * fixed element cannot do without knowing which tab is showing.
 *
 * `role="status"` with `aria-live="polite"` is what makes the count reach a screen reader
 * at all — the bar appears without focus moving, so nothing else would announce it.
 */

/** Props for {@link GuideSaveBar}. */
export interface GuideSaveBarProps {
  /** What is unsaved — "2 unsaved rule changes", "Unsaved custom rules". */
  label: string;
  /** Whether a save is in flight; both buttons wait for it. */
  saving?: boolean;
  /** Whether saving is possible at all — false for a viewer who may only preview. */
  canSave?: boolean;
  /** The Save button's text. The mockup says "Save changes" on the catalog, "Save" here. */
  saveLabel?: string;
  /** Throw the draft away. Routed through the discard confirm by the page. */
  onDiscard: () => void;
  /** Persist it. */
  onSave: () => void;
  /** Distinguishes the two bars in tests. */
  'data-testid'?: string;
}

/**
 * The unsaved-changes bar.
 *
 * @param props See {@link GuideSaveBarProps}.
 * @returns The bar.
 */
export default function GuideSaveBar({
  label,
  saving = false,
  canSave = true,
  saveLabel = 'Save changes',
  onDiscard,
  onSave,
  'data-testid': testId = 'guide-save-bar',
}: GuideSaveBarProps) {
  return (
    <div className="gd-save-bar" role="status" aria-live="polite" data-testid={testId}>
      <PencilLine aria-hidden className="gd-save-bar__glyph" />
      <span className="gd-save-bar__label">{label}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={saving}
        onClick={onDiscard}
        data-testid={`${testId}-discard`}
      >
        Discard
      </Button>
      {canSave && (
        <Button size="sm" disabled={saving} onClick={onSave} data-testid={`${testId}-save`}>
          {saving ? <Spinner size="sm" aria-hidden /> : <Save aria-hidden />}
          {saving ? 'Saving…' : saveLabel}
        </Button>
      )}
    </div>
  );
}
