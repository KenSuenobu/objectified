'use client';

import { Toaster as SonnerToaster } from 'sonner';

/**
 * Toaster — the Hive toast surface (re-tokened in HIVE-2.2, #5281).
 *
 * Authority: `docs/mockups/assets/hive.css` §15 (`.toast`), `docs/mockups/DESIGN.md` §5.4
 * ("bottom-right, 360 px, icon + title + description + optional action").
 *
 * It travels with the overlay family — dialog, drawer, toast are the three things that
 * paint over the page — which is why the re-token landed with the Drawer rather than with
 * the rest of the primitives in HIVE-2.1.
 *
 * `richColors` stays off: sonner's rich palette is its own set of colours, and a success
 * toast has to be the same green as a published badge. Tone therefore comes from the tokens
 * below, and the icon inherits the `--ok` / `--danger` / `--warn` role from the type of
 * toast raised.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      expand={false}
      closeButton
      toastOptions={{
        // 360 px in `rem`, so a toast follows the font-size preference like everything
        // else. `--shadow-lg` already carries the hairline as its second layer, the way
        // every Hive surface draws one.
        className: 'w-[22.5rem] max-w-full rounded-md bg-surface text-sm text-fg shadow-[var(--shadow-lg)]',
        classNames: {
          title: 'font-semibold',
          description: 'text-xs text-fg-muted',
          actionButton: 'bg-ink text-ink-fg',
          cancelButton: 'bg-subtle text-fg',
          closeButton: 'bg-surface text-fg-muted',
          success: '[&_[data-icon]]:text-ok',
          error: '[&_[data-icon]]:text-danger',
          warning: '[&_[data-icon]]:text-warn',
          info: '[&_[data-icon]]:text-accent',
        },
      }}
    />
  );
}
