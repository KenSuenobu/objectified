'use client';

import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';

/**
 * Segmented — the Hive one-of-few view switch (HIVE-2.2, #5281).
 *
 * Authority: `docs/mockups/assets/hive.css` §13 (`.segmented`), `docs/mockups/DESIGN.md`
 * §7, gallery §"Tabs, chips, segmented".
 *
 * An inset track with a raised thumb on the active option: Cards/Table, Comfortable/Compact,
 * Mine/Workspace. It is *not* a tab strip — nothing appears or disappears below it, the
 * same content is drawn a different way — so it carries radiogroup semantics rather than
 * `role="tablist"`, and a screen reader announces "Cards, selected, 1 of 2".
 *
 * Keyboard behaviour is the WAI-ARIA radio-group pattern, which is what those semantics
 * promise: one Tab stop for the whole control (roving `tabindex`), arrow keys move between
 * options **and select as they move**, `Home` / `End` jump to the ends, and disabled
 * options are skipped. Movement order comes from the DOM rather than from a registry, so a
 * caller may wrap, filter or reorder its items freely.
 *
 * ```tsx
 * <Segmented value={view} onValueChange={setView} aria-label="View">
 *   <SegmentedItem value="cards"><LayoutGrid aria-hidden /> Cards</SegmentedItem>
 *   <SegmentedItem value="table"><List aria-hidden /> Table</SegmentedItem>
 * </Segmented>
 * ```
 *
 * A group needs an accessible name: pass `aria-label`, or `aria-labelledby` pointing at the
 * field label above it. Keep the options as direct children where you can — that is how the
 * group knows which of them owns its single Tab stop before anything has been rendered.
 */

/** The sizes an option comes in — the track itself is the same well at both. */
export type SegmentedSize = 'default' | 'sm';

/**
 * The track: a tinted inset well the thumb is raised out of, 3 px around it (`p-0.75`).
 *
 * A plain constant rather than a `cva`, because `sm` changes the options and not the well.
 */
const segmentedTrackClass =
  'inline-flex items-center gap-0.5 rounded-md bg-inset p-0.75 align-middle';

/**
 * One option.
 *
 * The height is derived from `--control-h` rather than stated, so an option keeps its
 * proportion to the buttons beside it at both densities and every font scale: the track
 * inset (3 px top and bottom, plus the 1 px the design leaves) is subtracted from the
 * control metric instead of being frozen at the comfortable value.
 *
 * The radius is derived the same way — the track's `--r-md` less its own 3 px inset —
 * which is what keeps the thumb concentric with the well however the radius is themed.
 */
const segmentedItemVariants = cva(
  [
    'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5',
    'whitespace-nowrap rounded-[calc(var(--r-md)-3px)] font-medium leading-none text-fg-muted',
    'transition-[background-color,box-shadow,color] duration-[var(--dur-fast)] ease-out',
    'hover:text-fg',
    // The 3 px azure ring is the app-wide `*:focus-visible` rule in globals.css, which is
    // unlayered and so cannot be expressed here; all this has to do is drop the outline.
    'focus-visible:outline-none',
    'disabled:pointer-events-none disabled:opacity-50',
    // DESIGN.md §3.5: a glyph inside a control is 15 px, in `rem`, so it keeps its
    // proportion to the label at every font scale.
    '[&_svg]:size-[var(--icon-button)] [&_svg]:shrink-0',
    // The thumb — the surface lifted out of the well (DESIGN.md §3.3 `--shadow-raised`).
    'data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-[var(--shadow-raised)]',
  ].join(' '),
  {
    variants: {
      size: {
        /** 28 px — the 36 px control less the track's 2 × 3 px inset and a 1 px breath. */
        default: 'h-[calc(var(--control-h)-0.5rem)] px-2.75 text-sm',
        /** 24 px — the toolbar/filter size, beside a `sm` button. */
        sm: 'h-[calc(var(--control-h)-0.75rem)] px-2 text-xs',
      },
    },
    defaultVariants: { size: 'default' },
  }
);

/** What an option needs from its group. */
interface SegmentedContextValue {
  /** The selected value, or `undefined` when the group has no selection. */
  value: string | undefined;
  /** Select a value — from a click, or from an arrow key. */
  select: (value: string) => void;
  /** The option size, so an item does not have to be told twice. */
  size: SegmentedSize;
  /** The one value that owns the group's single Tab stop. */
  tabStopValue: string | undefined;
  /**
   * Whether the group could read its options from its own children.
   *
   * `false` when every item is wrapped in something (a `Tooltip`, a layout `div`), which
   * the roving `tabindex` cannot see through. The items then stay individually tabbable:
   * more Tab stops than the pattern wants, but never a control the keyboard cannot reach.
   */
  knowsItems: boolean;
}

const SegmentedContext = React.createContext<SegmentedContextValue | null>(null);

/**
 * The group context an option was rendered inside.
 *
 * @returns The context.
 * @throws If `SegmentedItem` is used outside a `Segmented`.
 */
function useSegmentedContext(): SegmentedContextValue {
  const context = React.useContext(SegmentedContext);
  if (!context) {
    throw new Error('SegmentedItem must be rendered inside a <Segmented>');
  }
  return context;
}

export interface SegmentedProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /** The selected option, for a controlled group. */
  value?: string;
  /** The initially selected option, for an uncontrolled group. */
  defaultValue?: string;
  /** Called with the option chosen by a click or an arrow key. */
  onValueChange?: (value: string) => void;
  /** Option size (default `default`). */
  size?: SegmentedSize;
}

/**
 * The values of the group's own options, and which of them are selectable.
 *
 * Read from the element tree rather than from the DOM so the very first render already
 * places the Tab stop correctly. Nested arrays and fragments are walked, because a caller
 * that maps over its options produces one.
 *
 * @param children The group's children.
 * @returns Every option value in order, and the first one that is not disabled.
 */
function readItemValues(children: React.ReactNode): {
  values: string[];
  firstEnabled: string | undefined;
} {
  const values: string[] = [];
  let firstEnabled: string | undefined;

  const walk = (nodes: React.ReactNode) => {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return;
      if (child.type === React.Fragment) {
        walk((child.props as { children?: React.ReactNode }).children);
        return;
      }
      const props = child.props as Partial<SegmentedItemProps>;
      if (typeof props.value !== 'string') return;
      values.push(props.value);
      if (firstEnabled === undefined && !props.disabled) firstEnabled = props.value;
    });
  };

  walk(children);
  return { values, firstEnabled };
}

/**
 * The group's options in DOM order, minus the disabled ones.
 *
 * @param root The track element.
 * @returns The options arrow keys may move to.
 */
function enabledItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(
    (item) => !item.disabled
  );
}

const Segmented = React.forwardRef<HTMLDivElement, SegmentedProps>(
  (
    { className, size = 'default', value, defaultValue, onValueChange, children, onKeyDown, ...props },
    forwardedRef
  ) => {
    const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(defaultValue);
    const isControlled = value !== undefined;
    const current = isControlled ? value : uncontrolled;
    const rootRef = React.useRef<HTMLDivElement | null>(null);

    React.useImperativeHandle(forwardedRef, () => rootRef.current as HTMLDivElement);

    const select = React.useCallback(
      (next: string) => {
        if (!isControlled) setUncontrolled(next);
        onValueChange?.(next);
      },
      [isControlled, onValueChange]
    );

    const { values, firstEnabled } = React.useMemo(() => readItemValues(children), [children]);

    /**
     * A radiogroup has exactly one tabbable option: the selected one, or — with nothing
     * selected, or a value no option answers to — the first enabled option. Without the
     * second case a group whose `value` does not match anything would have no Tab stop at
     * all, and the keyboard would step straight over it.
     */
    const tabStopValue =
      current !== undefined && values.includes(current) ? current : firstEnabled;

    /** Arrow / Home / End movement, selecting as it moves (WAI-ARIA radio group). */
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;

      const items = enabledItems(rootRef.current);
      if (items.length === 0) return;

      // `-1` when the key came from something else inside the group rather than from an
      // option; the walk then starts at the end it is moving away from, not one past it.
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: HTMLButtonElement | undefined;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = index === -1 ? items[0] : items[(index + 1) % items.length];
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next =
            index === -1
              ? items[items.length - 1]
              : items[(index - 1 + items.length) % items.length];
          break;
        case 'Home':
          next = items[0];
          break;
        case 'End':
          next = items[items.length - 1];
          break;
        default:
          return;
      }

      event.preventDefault();
      next?.focus();
      const nextValue = next?.dataset.value;
      if (nextValue !== undefined) select(nextValue);
    };

    const context = React.useMemo<SegmentedContextValue>(
      () => ({ value: current, select, size, tabStopValue, knowsItems: values.length > 0 }),
      [current, select, size, tabStopValue, values.length]
    );

    return (
      <SegmentedContext.Provider value={context}>
        <div
          ref={rootRef}
          role="radiogroup"
          className={cn(segmentedTrackClass, className)}
          onKeyDown={handleKeyDown}
          {...props}
        >
          {children}
        </div>
      </SegmentedContext.Provider>
    );
  }
);
Segmented.displayName = 'Segmented';

export interface SegmentedItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'type'> {
  /** The value this option selects. Size comes from the group, not from the option. */
  value: string;
}

const SegmentedItem = React.forwardRef<HTMLButtonElement, SegmentedItemProps>(
  ({ className, value, disabled, onClick, children, ...props }, ref) => {
    const { value: selected, select, size, tabStopValue, knowsItems } = useSegmentedContext();
    const isSelected = selected === value;
    // The roving Tab stop, unless the group could not see its own options through whatever
    // they were wrapped in — in which case every option keeps its own.
    const tabbable = !disabled && (!knowsItems || tabStopValue === value);

    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={isSelected}
        data-state={isSelected ? 'on' : 'off'}
        data-value={value}
        disabled={disabled}
        tabIndex={tabbable ? 0 : -1}
        className={cn(segmentedItemVariants({ size }), className)}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          select(value);
        }}
        {...props}
      >
        {children}
      </button>
    );
  }
);
SegmentedItem.displayName = 'SegmentedItem';

export { Segmented, SegmentedItem, segmentedTrackClass, segmentedItemVariants };
