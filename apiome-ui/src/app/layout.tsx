import type { Metadata } from "next";
import { interSans, jetbrainsMono } from "./fonts";
import "./globals.css";
import "@radix-ui/themes/styles.css";
import SessionWrapper from "@/app/components/auth/SessionWrapper";
import ThemeRegistry from "@/app/components/theme/ThemeRegistry";
import { DialogProvider } from "@/app/components/providers/DialogProvider";
import { Toaster } from "@/app/components/ui/Toaster";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { Theme as RadixTheme } from "@radix-ui/themes";
import PreferencesScript from "@/app/providers/PreferencesScript";
import { PreferencesProvider } from "@/app/providers/PreferencesProvider";

export const metadata: Metadata = {
  title: "Apiome",
  description: "Apiome ADE Platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Font variables sit on <html>, not <body>: globals.css declares
  // --app-font-sans at :root, and var() substitution inside a custom property
  // happens where that property is computed (the html element) — variables
  // mounted on <body> would be invisible to it.
  return (
    <html
      lang="en"
      className={`${interSans.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Device preferences (HIVE-1.3, #5276). Blocking, and first in <head>, so the
            stored theme and root font size are on <html> before the first paint —
            otherwise the page paints the defaults and corrects itself after hydration,
            which is the flash this removes. */}
        <PreferencesScript />
      </head>
      <body className="antialiased">
        <PreferencesProvider>
          <NextThemesProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            storageKey="theme"
          >
            {/* Hive design language (HIVE-1.1, #5274): azure accent, warm "sand" grey
                and the 14 px card radius, so Radix primitives sit on the same
                palette and geometry as the token layer in globals.css. */}
            <RadixTheme
              accentColor="blue"
              grayColor="sand"
              panelBackground="solid"
              radius="large"
              scaling="100%"
            >
              <ThemeRegistry>
                <SessionWrapper>
                  <DialogProvider>
                    {children}
                    <Toaster />
                  </DialogProvider>
                </SessionWrapper>
              </ThemeRegistry>
            </RadixTheme>
          </NextThemesProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
