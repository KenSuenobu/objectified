import type { Metadata } from "next";
import "../../globals.css";
import * as React from 'react';
import AdeAppShell from '@/app/components/shell/AdeAppShell';
import { DashboardTooltipProvider } from '@/app/components/ade/dashboard/DashboardTooltipProvider';

export const metadata: Metadata = {
  title: "Apiome: Dashboard",
  description: "Apiome Application",
};

/**
 * Every `/ade/dashboard/**` page renders inside the Hive application shell (HIVE-3.1,
 * #5287): one chrome — a collapsible rail beside the page, and nothing above it.
 *
 * The gradient canvas and the fixed 280 px `DashboardSideNav` this layout used to draw are
 * gone with the shell's arrival; `AppShell` paints the page column from `--bg-canvas`, so
 * the surface follows the theme instead of naming two greys per appearance. `TopHeader` no
 * longer renders on these routes either — `ConditionalHeader` asks
 * `components/shell/appShellRoutes`, which is the one place that knows where the shell is
 * in force.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AdeAppShell>
      <DashboardTooltipProvider>{children}</DashboardTooltipProvider>
    </AdeAppShell>
  );
}
