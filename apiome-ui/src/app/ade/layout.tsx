import type { Metadata } from "next";
import "../globals.css";
import "@radix-ui/themes/styles.css";
import SessionWrapper from "@/app/components/auth/SessionWrapper";
import AuthenticatedLayout from "@/app/components/auth/AuthenticatedLayout";
import FirstTenantOnboardingGuard from "@/app/components/auth/FirstTenantOnboardingGuard";
import { PushConflictBannerProvider } from '@/app/providers/PushConflictBannerProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { Theme as RadixTheme } from "@radix-ui/themes";
import * as React from 'react';

export const metadata: Metadata = {
  title: "Apiome: Studio",
  description: "Apiome ADE Platform - Studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="antialiased">
      <NextThemesProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        storageKey="theme"
      >
        {/* Hive design language (HIVE-1.1, #5274) — kept in lockstep with the
            root layout's RadixTheme so /ade and the rest of the app match. */}
        <RadixTheme
          accentColor="blue"
          grayColor="sand"
          panelBackground="solid"
          radius="large"
          scaling="100%"
        >
          <ThemeProvider>
            <SessionWrapper>
              <PushConflictBannerProvider>
                <AuthenticatedLayout>
                  {/*
                    Viewport box, and nothing else. Since HIVE-3.8 (#5294) this layout draws no
                    chrome of its own: the route does. Every `/ade/**` route but the launcher
                    fills this box with the Hive `AppShell` — a rail beside a page that scrolls
                    inside itself — and `/ade` fills it with the launcher, which has never had a
                    bar above it. What used to sit here was `ConditionalHeader`, the switch that
                    kept the pre-Hive `TopHeader` off the routes the rail had already reached;
                    with the last of those routes migrated there is nothing left to switch on.
                  */}
                  <div className="h-screen overflow-hidden">
                    {/* Post-login routing rules (OLO-3.3): tenant-less users get the
                        first-tenant onboarding prompt in place of any /ade route. */}
                    <FirstTenantOnboardingGuard>{children}</FirstTenantOnboardingGuard>
                  </div>
                </AuthenticatedLayout>
              </PushConflictBannerProvider>
            </SessionWrapper>
          </ThemeProvider>
        </RadixTheme>
      </NextThemesProvider>
    </div>
  );
}
