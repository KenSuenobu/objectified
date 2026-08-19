'use client';

import * as React from 'react';
import { Braces, ChevronRight } from 'lucide-react';
import { cn } from '../../../../../lib/utils';

export interface DisclosureProps {
  /** Header label (e.g. "Input schema" / "View diff"). */
  label: string;
  /** Optional right-aligned meta text (e.g. "12 lines"). */
  meta?: string;
  /** Optional icon next to the label; defaults to a JSON braces glyph. */
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * `<Disclosure>` — a collapsible section for heavyweight content (monaco viewers/diffs). Its children
 * mount only after the first expand (and stay mounted afterwards, hidden while closed) so a list of
 * many sections doesn't pay the editors' cost up front.
 *
 * Promoted from `ui/mcp/McpDisclosure` to `ui/code` in MFI-28.7 (#4123); `ui/mcp` keeps a back-compat
 * re-export.
 *
 * ### Re-tokened by HIVE-7.8 (#5325)
 *
 * Authority: the `.disclosure` block of `docs/mockups/sources/mcp-endpoint.html`.
 *
 * It was `border-gray-200 bg-gray-50 text-gray-700` with a `text-gray-400` meta and an indigo
 * braces glyph, which froze it on one light palette and one dark one. The browser sweep this
 * ticket added caught the meta outright: `#99a1af` on `#f9fafb` measures **2.48:1** at 12 px, an
 * axe `color-contrast` failure on every capability card and every change row at once.
 *
 * The one deliberate departure from the mockup: the meta is `--fg-muted`, not its `--fg-subtle`,
 * which is the same call every Epic-5 to Epic-7 block records — `--fg-subtle` is about 3.1:1
 * against the canvas at this size, and "14 lines" is a figure a reader uses.
 */
export function Disclosure({
  label,
  meta,
  icon,
  defaultOpen = false,
  children,
  className,
}: DisclosureProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [everOpened, setEverOpened] = React.useState(defaultOpen);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--border)]',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev);
          setEverOpened(true);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-inset px-3 py-2 text-left text-xs font-medium text-fg-muted transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        {icon ?? <Braces className="size-3.5 shrink-0" aria-hidden />}
        {label}
        {meta ? (
          <span className="ml-auto font-normal tabular-nums">
            {meta}
          </span>
        ) : null}
      </button>
      {everOpened ? (
        <div className={open ? 'border-t border-border' : 'hidden'}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
