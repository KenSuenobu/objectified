'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../../../lib/utils';
import {
  TAB_LIST_CLASS,
  TAB_PANEL_CLASS,
  tabTriggerRadixClass,
  type TabSize,
} from './tabStyles';

/**
 * The app's default tabs primitive. It renders the shared underline strip defined in
 * {@link ./tabStyles} — the same look as `DetailTabs`, `CatalogDetailTabs`, and every hand-rolled
 * strip in the app — so a set of tabs never reads as a row of buttons.
 */
const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn(TAB_LIST_CLASS, className)} {...props} />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export interface TabsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  /** Tab density — `sm` for dense chrome such as panel headers (default `md`). */
  size?: TabSize;
}

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, size, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={tabTriggerRadixClass({ size, className })}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn(TAB_PANEL_CLASS, className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };

