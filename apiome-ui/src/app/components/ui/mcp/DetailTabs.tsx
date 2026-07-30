'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../../../../lib/utils';
import { TAB_LIST_CLASS, TAB_PANEL_CLASS, tabTriggerRadixClass } from '../tabStyles';
import type { McpDetailTab } from '../../ade/dashboard/mcp/mcpUiPrimitives';

/**
 * `<DetailTabs>` — the endpoint detail tab shell. It renders the app-wide underline strip from
 * {@link ../tabStyles} (the same look the base {@link Tabs} primitive uses); what it adds is the
 * MCP tab-set plumbing — `items`/`only` auto-render the canonical detail tabs, so a screen can show
 * the full set or any subset it has content for. Built on Radix tabs so it stays keyboard-accessible
 * and controllable. The canonical tab set lives in {@link MCP_DETAIL_TABS}.
 */
const DetailTabs = TabsPrimitive.Root;

const DetailTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} className={tabTriggerRadixClass({ className })} {...props} />
));
DetailTabsTrigger.displayName = 'DetailTabsTrigger';

export interface DetailTabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  /**
   * When provided, the strip renders one trigger per tab automatically (default
   * {@link MCP_DETAIL_TABS}). Omit `items` and pass children to compose triggers by hand.
   */
  items?: readonly McpDetailTab[];
  /** Restrict an auto-rendered strip to these tab values, preserving the canonical order. */
  only?: readonly string[];
}

const DetailTabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  DetailTabsListProps
>(({ className, items, only, children, ...props }, ref) => {
  const autoItems = items ? items.filter((tab) => !only || only.includes(tab.value)) : null;
  return (
    <TabsPrimitive.List ref={ref} className={cn(TAB_LIST_CLASS, className)} {...props}>
      {autoItems
        ? autoItems.map((tab) => (
            <DetailTabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </DetailTabsTrigger>
          ))
        : children}
    </TabsPrimitive.List>
  );
});
DetailTabsList.displayName = 'DetailTabsList';

const DetailTabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn(TAB_PANEL_CLASS, className)} {...props} />
));
DetailTabsContent.displayName = 'DetailTabsContent';

export { DetailTabs, DetailTabsList, DetailTabsTrigger, DetailTabsContent };
