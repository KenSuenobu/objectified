import type { Metadata } from "next";
import "../globals.css";
import "@radix-ui/themes/styles.css";
import SessionWrapper from "@/app/components/auth/SessionWrapper";
import AuthenticatedLayout from "@/app/components/auth/AuthenticatedLayout";
import FirstTenantOnboardingGuard from "@/app/components/auth/FirstTenantOnboardingGuard";
import ConditionalHeader from '@/app/components/ade/ConditionalHeader';
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
                  {/* Viewport shell: header + route content scroll independently of the document. */}
                  <div className="flex h-screen flex-col overflow-hidden">
                    <ConditionalHeader />
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {/* Post-login routing rules (OLO-3.3): tenant-less users get the
                          first-tenant onboarding prompt in place of any /ade route. */}
                      <FirstTenantOnboardingGuard>{children}</FirstTenantOnboardingGuard>
                    </div>
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
