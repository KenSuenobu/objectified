'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { useTheme, specThemes, SpecTheme, Theme } from './ThemeProvider';
import { DirectoryStatPills, type DirectoryStats } from './DirectoryStatPills';

export function Navbar({ stats }: { stats: DirectoryStats }) {
  const pathname = usePathname();
  const { theme, specTheme, setTheme, setSpecTheme } = useTheme();
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        window.location.href = '/search';
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const navItems = [
    { href: '/', label: 'Discover', exact: true },
    { href: '/search', label: 'Search', exact: false },
    { href: '/mcp', label: 'MCP Catalog', exact: false },
  ];

  return (
    <nav className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70 dark:border-zinc-800/80 dark:bg-zinc-950/85 dark:supports-[backdrop-filter]:bg-zinc-950/70">
      <div aria-hidden="true" className="brand-hairline h-0.5 w-full" />
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3 px-4 sm:px-6 lg:gap-4 lg:px-8">
        {/* Left: Logo + Nav */}
        <div className="flex min-w-0 shrink-0 items-center gap-6 lg:gap-8">
          <Link href="/" className="flex items-center gap-2 shrink-0" aria-label="Apiome home">
            <div className="flex h-9 items-center justify-center relative">
              <Image
                src="/Apiome-02.png"
                alt=""
                width={108}
                height={36}
                className="object-contain dark:hidden h-9 w-auto"
                priority
              />
              <Image
                src="/Apiome-05.png"
                alt=""
                width={108}
                height={36}
                className="object-contain hidden dark:block h-9 w-auto"
                priority
              />
            </div>
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => {
              const active = item.exact ? pathname === item.href : pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-[var(--brand-soft)] text-[var(--brand-soft-text)]'
                      : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-50'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>

        <DirectoryStatPills stats={stats} className="hidden min-w-0 flex-1 lg:flex" />

        {/* Right: Search trigger + Tutorials + Login + Settings */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Search trigger (cmd+k) */}
          <Link
            href="/search"
            className="hidden items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50/80 px-3 py-1.5 text-sm text-zinc-500 transition-colors hover:border-sky-300 hover:bg-sky-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-sky-800 dark:hover:bg-zinc-800 lg:flex"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="text-xs">Search specifications</span>
            <kbd className="ml-6 rounded border border-zinc-300 bg-white px-1.5 text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950">⌘K</kbd>
          </Link>

          {/* Tutorials */}
          <a
            href="https://www.youtube.com/@apiomedev/"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50 sm:flex"
            title="Watch Apiome tutorials on YouTube"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
            <span className="hidden md:inline">Tutorials</span>
          </a>

          {/* Login / Sign Up */}
          <a
            href="https://app.apiome.dev/"
            className="flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--brand-hover)] focus-visible:outline-none"
          >
            <span className="hidden sm:inline">Sign in</span>
            <span className="sm:hidden">Sign in</span>
          </a>

          {/* Separator */}
          <div className="hidden h-5 w-px bg-zinc-200 dark:bg-zinc-800 sm:block"></div>

          {/* Settings */}
          <div className="relative">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
              aria-label="Settings"
              aria-expanded={showSettings}
              aria-haspopup="true"
            >
              <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            {showSettings && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowSettings(false)}
                  aria-hidden="true"
                />
                <div className="animate-fade-in absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                    Appearance
                  </h3>

                  <div className="mb-4">
                    <label className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      App Theme
                    </label>
                    <div className="mt-2 flex gap-1">
                      {(['light', 'dark', 'system'] as Theme[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => setTheme(t)}
                          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                            theme === t
                              ? 'bg-[var(--brand)] text-white'
                              : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      Code Theme
                    </label>
                    <div className="mt-2 grid grid-cols-2 gap-1">
                      {(Object.entries(specThemes) as [SpecTheme, typeof specThemes.default][]).map(
                        ([key, value]) => (
                          <button
                            key={key}
                            onClick={() => setSpecTheme(key)}
                            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                              specTheme === key
                                ? 'bg-[var(--brand)] text-white'
                                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                            }`}
                          >
                            {value.name}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="border-t border-zinc-200/80 px-4 py-2 dark:border-zinc-800/80 lg:hidden">
        <DirectoryStatPills stats={stats} />
      </div>
    </nav>
  );
}
