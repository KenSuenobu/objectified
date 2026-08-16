// apiome-ui/src/app/components/ade/SuiteNavMenu.tsx
'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import {
  groupNavMenuItems,
  isNavMenuItemNavigable,
  resolveExternalLinkIcon,
} from '../../../../lib/external-links';
import type { ExternalNavItem, ExternalNavMenuItem } from '../../../../lib/external-links';

/** Milliseconds of inactivity after which the typeahead buffer resets. */
const TYPEAHEAD_RESET_MS = 500;

function isExternalHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://');
}

/**
 * True when the destination matches the current route.
 *
 * External and non-navigable destinations never match, because their hrefs are
 * either on another origin or cleared by entitlement resolution.
 */
export function isNavMenuItemActive(
  menuItem: ExternalNavMenuItem,
  pathname: string | null
): boolean {
  if (!pathname) return false;
  if (!isNavMenuItemNavigable(menuItem)) return false;
  if (menuItem.external || isExternalHref(menuItem.href)) return false;
  return (
    pathname === menuItem.href ||
    (menuItem.href !== '/' && pathname.startsWith(`${menuItem.href}/`))
  );
}

export type SuiteNavMenuProps = {
  /** Nav item whose `menuItems` are rendered as grouped destinations. */
  item: ExternalNavItem;
  /** True when the trigger's product owns the current route. */
  isActive: boolean;
  /** Current route, used to mark the active destination. */
  pathname: string | null;
  /** Whether this menu is the one currently expanded. */
  open: boolean;
  /** Requests open/close; the parent keeps only one menu open at a time. */
  onOpenChange: (open: boolean) => void;
};

/**
 * The grouped suite product menu (UXE-1.1).
 *
 * Renders a nav item's destinations under labeled, non-focusable group
 * headings and implements the ARIA menu keyboard pattern: arrow keys, Home,
 * End, Escape and printable-character typeahead move a roving focus across
 * every destination — including unentitled ones, which stay focusable so
 * assistive technology can announce how to obtain access, but are not links.
 *
 * @param props - See {@link SuiteNavMenuProps}.
 * @returns The trigger button plus, when open, the grouped menu popover.
 */
export default function SuiteNavMenu({
  item,
  isActive,
  pathname,
  open,
  onOpenChange,
}: SuiteNavMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const typeaheadRef = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });

  const groups = useMemo(() => groupNavMenuItems(item), [item]);
  /** Flat, render-order list of destinations — the roving-focus order. */
  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  /** Destination id → roving-focus index, so tiles can register their ref slot. */
  const indexById = useMemo(
    () => new Map(flatItems.map((menuItem, index) => [menuItem.id, index])),
    [flatItems]
  );

  const menuId = `${item.id}-menu`;

  /** Move DOM focus to a destination by its index in `flatItems`, wrapping. */
  const focusItemAt = useCallback(
    (index: number) => {
      const count = flatItems.length;
      if (count === 0) return;
      const wrapped = ((index % count) + count) % count;
      itemRefs.current[wrapped]?.focus();
    },
    [flatItems.length]
  );

  /** Index of the destination that currently holds focus, or -1. */
  const currentIndex = useCallback(
    () => itemRefs.current.findIndex((node) => node !== null && node === document.activeElement),
    []
  );

  /** Park a destination node at its roving-focus index (stable ref callback). */
  const registerItem = useCallback((index: number, node: HTMLElement | null) => {
    itemRefs.current[index] = node;
  }, []);

  const close = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [onOpenChange]
  );

  // Focus the first destination whenever the menu opens, per the ARIA menu pattern.
  useEffect(() => {
    if (!open) {
      typeaheadRef.current = { buffer: '', at: 0 };
      return;
    }
    focusItemAt(0);
  }, [open, focusItemAt]);

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        onOpenChange(true);
        return;
      }
      focusItemAt(event.key === 'ArrowDown' ? 0 : flatItems.length - 1);
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = currentIndex();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItemAt(index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusItemAt(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusItemAt(0);
        return;
      case 'End':
        event.preventDefault();
        focusItemAt(flatItems.length - 1);
        return;
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'Tab':
        // Tab leaves the menu entirely rather than cycling inside it.
        close(false);
        return;
      default:
        break;
    }

    // Typeahead: printable characters jump to the next label with that prefix.
    if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;

    const now = Date.now();
    const previous = typeaheadRef.current;
    const expired = now - previous.at > TYPEAHEAD_RESET_MS;
    // A leading space activates the focused item; it only ever extends a buffer.
    if (event.key === ' ' && (expired || previous.buffer === '')) return;
    event.preventDefault();

    const buffer = expired ? event.key : `${previous.buffer}${event.key}`;
    typeaheadRef.current = { buffer, at: now };

    const needle = buffer.toLowerCase();
    const start = index < 0 ? 0 : index;
    // Search forward from the focused item so repeated keys cycle matches.
    const offset = buffer.length === 1 ? 1 : 0;
    for (let step = 0; step < flatItems.length; step += 1) {
      const candidate = (start + offset + step) % flatItems.length;
      if (flatItems[candidate].label.toLowerCase().startsWith(needle)) {
        focusItemAt(candidate);
        return;
      }
    }
  }

  const triggerClassName = `inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-sm text-slate-700 transition-colors hover:bg-slate-100 hover:text-indigo-600 dark:text-slate-200 dark:hover:bg-slate-700 dark:hover:text-indigo-400 ${
    isActive ? 'bg-slate-200/80 font-medium text-slate-900 dark:bg-slate-700 dark:text-white' : ''
  }`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={handleTriggerKeyDown}
        className={triggerClassName}
      >
        {item.label}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`${item.label} menu`}
          onKeyDown={handleMenuKeyDown}
          className="absolute left-1/2 z-[10050] mt-2 w-[min(92vw,36rem)] -translate-x-1/2 rounded-lg bg-white p-2 text-left shadow-lg shadow-slate-900/15 dark:bg-slate-800 dark:shadow-gray-900/50"
        >
          <div className="max-h-[min(70vh,26rem)] overflow-y-auto overscroll-contain">
            {groups.map((group) => {
              const headingId = `${menuId}-${group.id || 'ungrouped'}-heading`;
              return (
                <div
                  key={group.id || 'ungrouped'}
                  role="group"
                  aria-labelledby={group.label ? headingId : undefined}
                  className="mb-1 last:mb-0"
                >
                  {group.label && (
                    <div
                      id={headingId}
                      role="presentation"
                      className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400"
                    >
                      {group.label}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {group.items.map((menuItem) => (
                      <SuiteNavMenuTile
                        key={menuItem.id}
                        menuItem={menuItem}
                        active={isNavMenuItemActive(menuItem, pathname)}
                        index={indexById.get(menuItem.id)!}
                        registerRef={registerItem}
                        onNavigate={() => onOpenChange(false)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

type SuiteNavMenuTileProps = {
  menuItem: ExternalNavMenuItem;
  active: boolean;
  /** Position of this destination in the menu's roving-focus order. */
  index: number;
  registerRef: (index: number, node: HTMLElement | null) => void;
  onNavigate: () => void;
};

/**
 * One destination tile. Navigable destinations render as a link; unentitled or
 * unreleased ones render as an `aria-disabled` menu item that states how access
 * is obtained and carries no href.
 */
function SuiteNavMenuTile({
  menuItem,
  active,
  index,
  registerRef,
  onNavigate,
}: SuiteNavMenuTileProps) {
  const setRef = (node: HTMLElement | null) => registerRef(index, node);
  const navigable = isNavMenuItemNavigable(menuItem);
  const external = menuItem.external || isExternalHref(menuItem.href);
  const detail = navigable ? menuItem.description : menuItem.accessNote ?? menuItem.description;

  const className = `flex items-start gap-2.5 rounded-md px-3 py-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
    !navigable
      ? 'cursor-not-allowed opacity-70'
      : active
        ? 'bg-indigo-50 dark:bg-indigo-950/50'
        : 'hover:bg-slate-100 dark:hover:bg-slate-700'
  }`;

  const body = (
    <>
      {menuItem.icon &&
        // createElement, not JSX: the icon component is looked up from a data
        // string, and binding it to a capitalized local reads as declaring a
        // component during render.
        React.createElement(resolveExternalLinkIcon(menuItem.icon), {
          className: `mt-0.5 h-4 w-4 shrink-0 ${
            navigable ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'
          }`,
          'aria-hidden': true,
        })}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {menuItem.label}
          </span>
          {menuItem.badge && (
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-[0.04em] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {menuItem.badge}
            </span>
          )}
        </span>
        {detail && (
          <span className="block text-xs text-slate-500 dark:text-slate-400">{detail}</span>
        )}
      </span>
    </>
  );

  if (!navigable) {
    return (
      <div
        ref={setRef}
        role="menuitem"
        aria-disabled="true"
        tabIndex={-1}
        className={className}
      >
        {body}
      </div>
    );
  }

  if (external) {
    return (
      <a
        ref={setRef}
        role="menuitem"
        tabIndex={-1}
        href={menuItem.href}
        target={menuItem.opensNewBrowser ? '_blank' : undefined}
        rel={menuItem.opensNewBrowser ? 'noopener noreferrer' : undefined}
        className={className}
        style={{ textDecoration: 'none' }}
        onClick={onNavigate}
      >
        {body}
      </a>
    );
  }

  return (
    <Link
      ref={setRef}
      role="menuitem"
      tabIndex={-1}
      href={menuItem.href}
      aria-current={active ? 'page' : undefined}
      className={className}
      style={{ textDecoration: 'none' }}
      onClick={onNavigate}
    >
      {body}
    </Link>
  );
}
