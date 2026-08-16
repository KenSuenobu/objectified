'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../../../lib/utils';
import {
  TAB_COUNT_CLASS,
  TAB_PANEL_CLASS,
  tabListClass,
  tabTriggerRadixClass,
  type TabSize,
  type TabVariant,
} from './tabStyles';

/**
 * The app's default tabs primitive. It renders the shared strip defined in
 * {@link ./tabStyles} — the same look as `DetailTabs`, `CatalogDetailTabs`, and every hand-rolled
 * strip in the app — so a set of tabs never reads as a row of buttons.
 *
 * Re-tokened by HIVE-2.1 (#5280) against hive.css §10: ink underline, count pills, and the two
 * further shapes the mockups use — `pills` and `vertical`. Pass `variant` to `TabsList` *and* to
 * its `TabsTrigger`s; they are separate elements, so neither can infer the other's shape.
 */
const Tabs = TabsPrimitive.Root;

export interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  /** Tab shape — `underline` (default), `pills` or `vertical`. */
  variant?: TabVariant;
  /** Scroll a long strip sideways instead of wrapping it (underline strips only). */
  scroll?: boolean;
}

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant = 'underline', scroll = false, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={tabListClass(variant, { scroll, className })}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export interface TabsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  /** Tab density — `sm` for dense chrome such as panel headers (default `md`). */
  size?: TabSize;
  /** Tab shape — must match the `variant` given to the enclosing `TabsList`. */
  variant?: TabVariant;
}

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, size, variant, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={tabTriggerRadixClass({ size, variant, className })}
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

/**
 * A count beside a tab's label — "Versions 6", "Lint 2".
 *
 * A pill rather than parentheses, because the number is a *quantity of things behind this tab*
 * and has to stay legible when the label wraps (hive.css §10 `.count`).
 */
const TabsCount = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span ref={ref} className={cn(TAB_COUNT_CLASS, className)} {...props} />
));
TabsCount.displayName = 'TabsCount';

export { Tabs, TabsList, TabsTrigger, TabsContent, TabsCount };
