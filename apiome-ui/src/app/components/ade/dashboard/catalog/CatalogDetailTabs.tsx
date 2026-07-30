'use client';

/**
 * CatalogDetailTabs (MFI-25.1, #4086).
 *
 * The accessible tab bar for the catalog item detail shell — the header keeps the primary Convert /
 * "View code" CTAs while this bar switches between the five detail panes (Overview / Source & Code /
 * Provenance / Lint & Score / Versions) *without a route change*. It is the foundation the rest of
 * EPIC-25 hangs its panes off, so the ARIA wiring lives here once:
 *
 *   - a `role="tablist"` of `role="tab"` buttons with `aria-selected` + `aria-controls`;
 *   - a roving `tabindex` (only the active tab is in the tab order); and
 *   - Arrow/Home/End keyboard navigation that both selects and focuses the next tab.
 *
 * Callers render one `role="tabpanel"` per tab whose `id`/`aria-labelledby` line up with the shared
 * {@link panelElementId}/{@link tabElementId} helpers, hiding the inactive panes with `hidden`.
 */

import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@lib/utils';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';

/** A single tab: its stable `id` (also used to derive element ids) and visible `label`. */
export interface DetailTab {
  id: string;
  label: string;
}

/** The DOM id of a tab button, so a panel's `aria-labelledby` can point back at it. */
export function tabElementId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

/** The DOM id of a tab panel, so a tab's `aria-controls` can point at it. */
export function panelElementId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`;
}

export interface CatalogDetailTabsProps {
  /** The ordered tabs to render. */
  tabs: readonly DetailTab[];
  /** The id of the currently selected tab. */
  active: string;
  /** Called with a tab id when the user selects it (click or keyboard). */
  onSelect: (id: string) => void;
  /** Accessible label for the tablist. */
  ariaLabel?: string;
  /** Prefix for tab/panel element ids so `aria-controls`/`aria-labelledby` line up with the panes. */
  idPrefix?: string;
  /** Extra classes for the tablist container. */
  className?: string;
}

/**
 * Render the catalog detail tab bar. Selection is controlled by the caller via `active`/`onSelect`;
 * keyboard navigation (Arrow keys wrap, Home/End jump to the ends) moves selection *and* focus, per
 * the WAI-ARIA "tabs with automatic activation" pattern.
 */
export function CatalogDetailTabs({
  tabs,
  active,
  onSelect,
  ariaLabel = 'Catalog item detail sections',
  idPrefix = 'catalog-detail',
  className = '',
}: CatalogDetailTabsProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /** Select and focus the tab at `index`, wrapping around the ends. */
  const focusTab = (index: number) => {
    const count = tabs.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    onSelect(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusTab(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusTab(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(tabs.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-testid="catalog-detail-tabs"
      className={cn(TAB_LIST_CLASS, className)}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabElementId(idPrefix, tab.id)}
            aria-selected={isActive}
            aria-controls={panelElementId(idPrefix, tab.id)}
            tabIndex={isActive ? 0 : -1}
            data-testid={`catalog-detail-tab-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={tabTriggerClass({ active: isActive })}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
