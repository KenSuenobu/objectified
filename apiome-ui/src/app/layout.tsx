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
      <body className="antialiased">
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
      </body>
    </html>
  );
}
