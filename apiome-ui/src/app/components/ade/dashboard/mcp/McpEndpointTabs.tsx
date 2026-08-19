'use client';

/**
 * The MCP endpoint detail tab strip and its panels (HIVE-7.8, #5325).
 *
 * Authority: `docs/mockups/sources/mcp-endpoint.html` — the six tabs in the page header's tab
 * slot, in the mockup's order — and DESIGN.md §7 (a tab is an underline, never a pill).
 *
 * ### Why this is hand-built rather than `ui/mcp/DetailTabs`
 *
 * The same reason `CatalogItemDetailClient` and the style-guide editor record: a Radix
 * `Tabs.Root` is *one element*, and this screen's strip lives in {@link PageHeader}'s tab slot
 * while its panels live in {@link PageBody}. `.page` is a flex column whose two children are
 * exactly those, so a Root wrapping both would have to become that column itself. The strip
 * states its own roles, roving tabindex and panel association instead, on the shared classes
 * from `ui/tabStyles` — so it looks identical to every other strip in the app and stays one
 * definition away from the next restyle.
 *
 * A second consequence, and the one the ticket's fourth acceptance criterion asks for: the
 * Insight tab's own rail of fourteen views *is* a Radix `Tabs.Root`, mounted inside this
 * strip's `insight` panel. Because the outer strip is not Radix, the two cannot share a
 * roving-focus context or a `data-state` selector — nesting them is what made the mockup need
 * a script to restore its inner panels after every outer click. Here they are simply two
 * independent controls.
 */

import * as React from 'react';
import {
  ChartSpline,
  History,
  Settings2,
  ShieldCheck,
  ShieldHalf,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/app/components/ui/Badge';
import {
  TAB_COUNT_CLASS,
  TAB_GLYPH_CLASS,
  TAB_LIST_CLASS,
  tabTriggerClass,
} from '@/app/components/ui/tabStyles';

/** One tab of the endpoint detail strip. */
export interface McpEndpointTab {
  /** Stable value — the panel key, and half of both generated DOM ids. */
  value: string;
  /** What the reader sees. */
  label: string;
  /** The leading glyph. */
  icon: LucideIcon;
  /**
   * A tab that is a *proposal* rather than shipped behaviour: it wears a honey "Proposed"
   * marker and says so in its tooltip. The mockup adds exactly one — `trust` — so the gap
   * between a component that exists (`McpTrustPosturePanel`) and a screen that mounts it is
   * visible on the screen rather than buried in a roadmap.
   */
  proposed?: boolean;
  /** The tooltip, for a tab whose name does not explain itself. */
  title?: string;
}

/** The value of the tab the screen opens on. */
export const MCP_ENDPOINT_DEFAULT_TAB = 'capabilities';

/** The marker a proposed tab wears, spelled once so the test and the strip agree. */
export const MCP_ENDPOINT_PROPOSED_LABEL = 'Proposed';

/**
 * The strip, in the mockup's order: the surface, then what we know about it, then how it got
 * that way, then its score, then its settings — and the proposal last.
 */
export const MCP_ENDPOINT_TABS: readonly McpEndpointTab[] = [
  { value: 'capabilities', label: 'Capabilities', icon: Wrench },
  { value: 'insight', label: 'Insight', icon: ChartSpline },
  { value: 'versions', label: 'Versions', icon: History },
  { value: 'lint', label: 'Lint & score', icon: ShieldCheck },
  { value: 'settings', label: 'Settings', icon: Settings2 },
  {
    value: 'trust',
    label: 'Trust posture',
    icon: ShieldHalf,
    proposed: true,
    title:
      'McpTrustPosturePanel exists but is not mounted anywhere else today — this tab is a proposal.',
  },
];

/** The `id` of a tab's trigger, so its panel can point back at it. */
export function mcpEndpointTabId(value: string): string {
  return `mcp-endpoint-tab-${value}`;
}

/** The `id` of a tab's panel, so its trigger can point at it. */
export function mcpEndpointPanelId(value: string): string {
  return `mcp-endpoint-panel-${value}`;
}

export interface McpEndpointTabListProps {
  /** The selected tab's value. */
  value: string;
  /** Called with the newly selected tab's value. */
  onValueChange: (value: string) => void;
  /** Counts shown beside a tab's label, keyed by tab value. A missing key draws no count. */
  counts?: Readonly<Record<string, number | null | undefined>>;
  /** The tabs to draw (default {@link MCP_ENDPOINT_TABS}). */
  tabs?: readonly McpEndpointTab[];
}

/**
 * The tab strip.
 *
 * Keyboard behaviour follows the WAI-ARIA tabs pattern: one tab stop for the whole strip, and
 * the arrow keys move both focus *and* selection, which is what makes a tab row navigable
 * without a second Enter press. `Home`/`End` jump to the ends.
 *
 * @param props See {@link McpEndpointTabListProps}.
 * @returns The `role="tablist"` strip.
 */
export function McpEndpointTabList({
  value,
  onValueChange,
  counts,
  tabs = MCP_ENDPOINT_TABS,
}: McpEndpointTabListProps): React.ReactElement {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  /** Move focus *and* selection to `index`, wrapping at both ends. */
  const focusTab = React.useCallback(
    (index: number) => {
      const wrapped = (index + tabs.length) % tabs.length;
      const tab = tabs[wrapped];
      if (!tab) return;
      onValueChange(tab.value);
      refs.current[wrapped]?.focus();
    },
    [onValueChange, tabs],
  );

  return (
    <div
      role="tablist"
      aria-label="MCP endpoint sections"
      data-testid="mcp-endpoint-tabs"
      className={TAB_LIST_CLASS}
    >
      {tabs.map((tab, index) => {
        const Glyph = tab.icon;
        const isActive = tab.value === value;
        const count = counts?.[tab.value];
        return (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={mcpEndpointTabId(tab.value)}
            aria-selected={isActive}
            aria-controls={mcpEndpointPanelId(tab.value)}
            tabIndex={isActive ? 0 : -1}
            title={tab.title}
            data-testid={`mcp-endpoint-tab-${tab.value}`}
            className={tabTriggerClass({ active: isActive })}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(event) => {
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
            }}
          >
            <Glyph aria-hidden className={TAB_GLYPH_CLASS} />
            {tab.label}
            {typeof count === 'number' ? (
              <span className={TAB_COUNT_CLASS}>{count}</span>
            ) : null}
            {tab.proposed ? (
              <Badge variant="honey" className="ml-1">
                {MCP_ENDPOINT_PROPOSED_LABEL}
              </Badge>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface McpEndpointTabPanelProps {
  /** Which tab this panel belongs to. */
  value: string;
  /** The selected tab's value. */
  active: string;
  /** The panel's content. Mounted only while the panel is the selected one. */
  children: React.ReactNode;
}

/**
 * One panel.
 *
 * Unselected panels are **unmounted**, not hidden. Every one of the five real panels fetches on
 * mount — the insight tab alone runs eight reads — so rendering them all would turn one visit
 * into a dozen requests for data nobody asked to see. It is also what makes each panel's
 * deep-link arrive on a fresh mount, which is how the version history applies a churn-timeline
 * request as its *initial* selection instead of flashing the default diff first.
 *
 * @param props See {@link McpEndpointTabPanelProps}.
 * @returns The `role="tabpanel"` region, or `null` when another tab is selected.
 */
export function McpEndpointTabPanel({
  value,
  active,
  children,
}: McpEndpointTabPanelProps): React.ReactElement | null {
  if (value !== active) return null;
  return (
    <div
      role="tabpanel"
      id={mcpEndpointPanelId(value)}
      aria-labelledby={mcpEndpointTabId(value)}
      tabIndex={0}
      data-testid={`mcp-endpoint-panel-${value}`}
      className="mcp-ep-panel focus-visible:outline-none"
    >
      {children}
    </div>
  );
}
