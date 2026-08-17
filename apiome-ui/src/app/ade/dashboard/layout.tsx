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
 * the surface follows the theme instead of naming two greys per appearance. The 48px
 * `TopHeader` that used to sit above them both went with HIVE-3.8 (#5294), which retired the
 * pre-Hive chrome outright — there is no longer a second navigation system to arbitrate.
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
