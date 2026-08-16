'use client';

import * as React from 'react';

/**
 * The rail's menu chrome and keyboard model (HIVE-3.3, #5289).
 *
 * Authority: `docs/mockups/DESIGN.md` §5.4 ("Menu — 200–300 px, 32 px items with icons")
 * and `docs/mockups/assets/hive.css` §17 (`.menu`, `.menu__item`, `.menu__label`,
 * `.menu__sep`).
 *
 * The rail grows two popup menus in this epic — the workspace switcher here, and HIVE-3.4's
 * user menu below it — and they are the same object: a floating surface anchored to a rail
 * row, a `role="menu"` whose items are walked with the arrow keys, `Esc` back to the
 * trigger, and dismissal when a click or the focus ring leaves. Written twice, the two
 * would agree on the day they shipped and drift on the first fix; written here, a menu is
 * the {@link useRailMenu} hook plus four class constants.
 *
 * ### Why the keyboard model is DOM-driven
 *
 * The roving index is read from the document rather than tracked in state: a switcher's
 * item list changes as the reader types in its filter, and any index held in React is one
 * render behind the list it indexes. Asking the menu element which of its items has focus
 * cannot go stale — and it is also what lets a caller mix `menuitem` and `menuitemradio`
 * rows without telling this module anything about either.
 */

/**
 * Every role that counts as a menu item, as a selector.
 *
 * `menuitemradio` is what a single-choice list uses (the switcher's workspaces: exactly one
 * is current), `menuitem` is everything else. Both are legal children of `role="menu"`, and
 * both are walked by the same arrow keys, so the selector matches the prefix.
 */
const MENU_ITEM_SELECTOR = '[role^="menuitem"]';

/**
 * The floating surface a rail menu is drawn on.
 *
 * Anchored under its trigger and to the rail's left edge, so the menu lands in the same
 * place whether the rail is 264 px or 64 px — the collapsed rail changes what the *row*
 * shows, never where its menu opens (`DESIGN.md` §5.2). It is wider than the collapsed rail
 * and may be wider than the expanded one, which is why `AppShell`'s `<aside>` is
 * `overflow-visible`.
 *
 * `z-[9990]`: above every page-level layer (the tallest in the app is `z-[3000]`) and
 * deliberately *below* the dialog layer at `z-[9998]`, so a dialog opened from a menu item
 * is never drawn underneath the menu that opened it.
 */
export const RAIL_MENU_SURFACE_CLASS = [
  'absolute left-0 top-full z-[9990] mt-1 flex flex-col overflow-hidden',
  'rounded-md bg-surface p-1.5 text-fg shadow-lg',
  'animate-in fade-in-0 zoom-in-95',
].join(' ');

/**
 * Flip a rail menu so it grows *upward* from its trigger.
 *
 * Composed onto {@link RAIL_MENU_SURFACE_CLASS} by a menu anchored near the bottom of the
 * rail — the footer's user menu (HIVE-3.4, #5290), which would otherwise open off the
 * bottom of the viewport. Both the offset and the edge have to be restated: `mt-1` and
 * `mt-0` are the same Tailwind group so `tailwind-merge` resolves them, but `top` and
 * `bottom` are not, and a surface left with `top-full` as well as `bottom-full` is
 * stretched between the two.
 */
export const RAIL_MENU_ABOVE_CLASS = 'top-auto bottom-full mt-0 mb-1';

/**
 * The hairline between two runs of menu rows (`hive.css` §17 `.menu__sep`).
 *
 * Drawn on an element with `role="none"` — a `separator` role would be announced, and the
 * grouping it marks is visual: "these rows are about your account, those are about leaving
 * it". A menu that reads out three separators is noisier, not clearer.
 */
export const RAIL_MENU_SEPARATOR_CLASS = 'mx-1 my-1.5 h-px bg-border';

/**
 * One menu row: the 32 px item of `DESIGN.md` §5.4, as a full-width button or link.
 *
 * `aria-disabled` rather than `disabled` is the state a caller should reach for — see
 * {@link RAIL_MENU_ITEM_DISABLED_CLASS} — so the hover tint is suppressed from the
 * attribute here instead of from a variant the call site has to remember.
 */
export const RAIL_MENU_ITEM_CLASS = [
  'flex w-full items-center gap-2 rounded-sm px-2.5 text-left text-sm',
  'min-h-nav-item py-1 transition-colors duration-[var(--dur-fast)]',
  'hover:bg-subtle aria-disabled:cursor-default aria-disabled:hover:bg-transparent',
].join(' ');

/**
 * A menu row that cannot be actioned right now.
 *
 * Spelled `aria-disabled` at the call site, never `disabled`: a disabled button leaves the
 * tab and arrow order, so the reader who most needs to know *why* a row is unavailable is
 * the one who can never reach it to hear the reason. This is the same rule HIVE-3.1 applies
 * to gated rail destinations — and it is also why the ink is `--fg-muted` rather than the
 * quieter `--fg-subtle`: a row that has to be *read* to be understood has to clear AA, and
 * `--fg-subtle` measures 2.9–4.0:1 on `--bg-surface` across the nine themes. See
 * `tests/workspace-switcher.test.tsx` § "quiet text".
 */
export const RAIL_MENU_ITEM_DISABLED_CLASS = 'text-fg-muted';

/**
 * The section heading above a run of items (`hive.css` §17 `.menu__label`).
 *
 * `--fg-muted` for the reason {@link RAIL_MENU_ITEM_DISABLED_CLASS} gives: at 11 px the
 * `--fg-subtle` step DESIGN.md §3.2 nominates for section labels does not clear AA on the
 * menu surface in six of the nine themes.
 */
export const RAIL_MENU_LABEL_CLASS =
  'px-2.5 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[var(--track-caps)] text-fg-muted';

/** What {@link useRailMenu} is told. */
export interface RailMenuOptions {
  /** Whether the menu is open. */
  open: boolean;
  /**
   * Put the menu away.
   *
   * Only the open/closed flag: restoring focus to the trigger is the hook's job, because
   * the hook is what holds the trigger's ref. The callback may be a fresh closure on every
   * render — it is read through a ref, so the listeners below are not re-bound for it.
   */
  onClose: () => void;
}

/** What {@link useRailMenu} gives back. */
export interface RailMenu {
  /** Put on the element wrapping the trigger *and* the popup: dismissal is scoped to it. */
  anchorRef: React.RefObject<HTMLDivElement | null>;
  /** Put on the trigger, so focus can be restored to it. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Put on the element carrying `role="menu"`. */
  menuRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Close the menu.
   *
   * @param restoreFocus True when focus belongs back on the trigger — `Esc`, and choosing
   *   an item — and false when the reader has already said where they want to be.
   */
  closeMenu: (restoreFocus: boolean) => void;
  /** `onKeyDown` for the `role="menu"` element: the arrow keys, `Home` and `End`. */
  onMenuKeyDown: (event: React.KeyboardEvent) => void;
  /** Focus the first item — what `ArrowDown` from a filter field above the menu does. */
  focusFirstItem: () => void;
  /** Focus the last item — what `ArrowUp` from that field does. */
  focusLastItem: () => void;
  /**
   * `tabIndex` for the item at `index`: `0` for the one item in the tab order, `-1` for the
   * rest. The roving index resets to the first item every time the menu opens.
   */
  itemTabIndex: (index: number) => number;
  /** `onFocus` for every item, so pointer and keyboard agree on which one is roving. */
  onItemFocus: (index: number) => void;
}

/**
 * Wire a rail menu's keyboard and dismissal behaviour.
 *
 * Handles, in order of how often a reader meets them:
 *
 * - **Arrow keys** move between items and wrap at both ends; `Home`/`End` jump.
 * - **`Esc`** closes and returns focus to the trigger, from anywhere inside the popup —
 *   including a filter field, which is why the listener is on the anchor rather than on the
 *   menu element.
 * - **A click outside** closes without moving focus.
 * - **Focus leaving the popup** closes it, which is what makes `Tab` behave: a menu the
 *   reader has tabbed past is not a menu that should still be on screen.
 *
 * @param options See {@link RailMenuOptions}.
 * @returns The refs, handlers and roving-tabindex helpers described by {@link RailMenu}.
 */
export function useRailMenu({ open, onClose }: RailMenuOptions): RailMenu {
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [rovingIndex, setRovingIndex] = React.useState(0);

  // The caller's `onClose` behind a ref, so a caller that passes an inline arrow does not
  // make every document listener below re-bind on every render.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const closeMenu = React.useCallback((restoreFocus: boolean) => {
    // Move the caret *before* the close unmounts what it is sitting on. The other order
    // leaves focus on a removed element, which browsers answer by dropping it onto `<body>`
    // — and the reader's next `Tab` starts from the top of the document.
    if (restoreFocus) triggerRef.current?.focus();
    onCloseRef.current();
  }, []);

  // A freshly opened menu always offers its first item to `Tab`, whatever the reader
  // arrowed to the last time it was open.
  React.useEffect(() => {
    if (!open) setRovingIndex(0);
  }, [open]);

  /** The menu's items, in DOM order. Empty when the menu is closed. */
  const items = React.useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []),
    []
  );

  /**
   * Focus the item at `index`, wrapping at both ends.
   *
   * @param index Any integer; negative and over-large values wrap into range.
   */
  const focusItemAt = React.useCallback(
    (index: number) => {
      const list = items();
      if (list.length === 0) return;
      const next = ((index % list.length) + list.length) % list.length;
      setRovingIndex(next);
      list[next].focus();
    },
    [items]
  );

  const focusFirstItem = React.useCallback(() => focusItemAt(0), [focusItemAt]);
  // `-1` wraps to the end, which is exactly what "up from above the menu" should mean.
  const focusLastItem = React.useCallback(() => focusItemAt(-1), [focusItemAt]);

  const onMenuKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      const list = items();
      if (list.length === 0) return;
      // Where the caret is *now*, rather than where state thinks it is: the list can have
      // been re-filtered since the last keystroke.
      const current = list.indexOf(document.activeElement as HTMLElement);

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focusItemAt(current + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusItemAt(current < 0 ? -1 : current - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusItemAt(0);
          break;
        case 'End':
          event.preventDefault();
          focusItemAt(list.length - 1);
          break;
        default:
          break;
      }
    },
    [focusItemAt, items]
  );

  // `Esc` and outside clicks. Both are document-level because both are about events that
  // happen *outside* the element that would otherwise handle them — and `Esc` is bound at
  // the capture phase so a filter field inside the popup cannot swallow it.
  React.useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!anchorRef.current?.contains(event.target as Node)) return;
      event.stopPropagation();
      closeMenu(true);
    };

    const onPointerDown = (event: Event) => {
      if (anchorRef.current?.contains(event.target as Node)) return;
      closeMenu(false);
    };

    document.addEventListener('keydown', onKeyDown, true);
    // `pointerdown`, not `click`: the menu goes away as the press starts, so it never
    // swallows the click meant for whatever is underneath it.
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, closeMenu]);

  // Focus leaving the popup closes it. `focusout` bubbles (unlike `blur`), so one listener
  // on the anchor covers the trigger, the filter field and every item.
  React.useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;

    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      // A null `relatedTarget` is focus going nowhere at all — a click on the page
      // background, a window blur. The pointer listener above owns the first, and the
      // second should not put the menu away behind the reader's back.
      if (!next || anchor.contains(next)) return;
      closeMenu(false);
    };

    anchor.addEventListener('focusout', onFocusOut);
    return () => anchor.removeEventListener('focusout', onFocusOut);
  }, [open, closeMenu]);

  const itemTabIndex = React.useCallback(
    (index: number) => (index === rovingIndex ? 0 : -1),
    [rovingIndex]
  );

  return {
    anchorRef,
    triggerRef,
    menuRef,
    closeMenu,
    onMenuKeyDown,
    focusFirstItem,
    focusLastItem,
    itemTabIndex,
    onItemFocus: setRovingIndex,
  };
}
