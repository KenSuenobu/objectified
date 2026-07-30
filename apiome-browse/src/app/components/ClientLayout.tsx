'use client';

import { Navbar } from './Navbar';
import { ThemeProvider } from './ThemeProvider';
import type { DirectoryStats } from './DirectoryStatPills';

export function ClientLayout({
  children,
  stats,
}: {
  children: React.ReactNode;
  stats: DirectoryStats;
}) {
  return (
    <ThemeProvider>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="flex min-h-screen flex-col bg-[var(--background)] text-[var(--foreground)]">
        <Navbar stats={stats} />
        <main id="main" className="flex-1">
          {children}
        </main>
        <footer className="border-t border-zinc-200/80 bg-white/60 py-8 dark:border-zinc-800/80 dark:bg-zinc-950/60">
          <div className="mx-auto flex max-w-[1480px] flex-col items-start justify-between gap-6 px-4 sm:px-6 lg:px-8 lg:flex-row lg:items-center">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Apiome Browse
              </span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Public API specification directory &middot; OpenAPI &middot; Arazzo &middot; JSON Schema
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
              <a
                href="https://www.youtube.com/@objectifieddev/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 transition-colors hover:text-zinc-900 dark:hover:text-zinc-50"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
                Tutorials
              </a>
              <a
                href="https://app.apiome.dev/"
                className="transition-colors hover:text-zinc-900 dark:hover:text-zinc-50"
              >
                Sign in
              </a>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                &copy; 2021&ndash;2026 NobuData LLC
              </span>
            </div>
          </div>
        </footer>
      </div>
    </ThemeProvider>
  );
}
