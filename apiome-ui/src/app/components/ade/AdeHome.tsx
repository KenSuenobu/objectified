'use client';

import { useRouter } from 'next/navigation';
import { BrandMark } from '../brand';
import { useAuthSession } from '@lib/auth/session-client';
import { signOutEverywhere } from '../../../../lib/auth/sign-out-client';
import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Globe,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Settings2,
  Shield,
  Sparkles,
  Store,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BROWSE_APP_URL } from '../../../../lib/app-urls';
import {
  resolveExternalLinkIcon,
  type ExternalHomeCard,
} from '../../../../lib/external-links';
import { cn } from '../../../../lib/utils';
import PreferencesDrawerHost from './preferences/PreferencesDrawerHost';
import CommandPaletteHost from '@/app/components/shell/CommandPaletteHost';
import ShortcutsHost from '@/app/components/shell/ShortcutsHost';
import { openPreferences } from './preferences/preferencesDrawerBus';
import WhatsNewDialog from './WhatsNewDialog';
// The one place the build string is derived (HIVE-3.4, #5290) — the launcher, the top bar
// and the rail's user menu must never print three different builds.
import { APP_VERSION_BADGE } from '@lib/app-version';
import { markWhatsNewSeen } from '../shell/whatsNewSeen';


type AppCardConfig = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  href: string;
  enabled: boolean;
  external?: boolean;
  icon: LucideIcon;
  accent: string;
  glow: string;
  footerLabel?: string;
};

const CORE_PRIMARY_APPS: AppCardConfig[] = [
  {
    id: 'control-panel',
    name: 'Control Panel',
    tagline: 'Governance',
    description: 'Tenants, projects, versions, repositories, and platform settings in one place.',
    href: '/ade/dashboard',
    enabled: true,
    icon: LayoutDashboard,
    accent: 'from-indigo-500 to-violet-600',
    glow: 'group-hover:shadow-indigo-500/20',
  },
  {
    id: 'browser',
    name: 'Browser',
    tagline: 'Public catalog',
    description: 'Discover and compare published specifications from every organization.',
    href: BROWSE_APP_URL,
    enabled: true,
    external: true,
    icon: Globe,
    accent: 'from-cyan-500 to-blue-600',
    glow: 'group-hover:shadow-cyan-500/20',
  },
];

function externalHomeCardToAppCard(card: ExternalHomeCard): AppCardConfig {
  return {
    id: card.id,
    name: card.name,
    tagline: card.tagline,
    description: card.description,
    href: card.href,
    enabled: card.enabled,
    external: card.external,
    icon: resolveExternalLinkIcon(card.icon),
    accent: card.accent,
    glow: card.glow,
    footerLabel: 'Commercial',
  };
}

type AdeHomeProps = {
  commercialHomeCards?: ExternalHomeCard[];
  entitledFeatureFlags?: string[];
};

type ResourceLink = {
  id: string;
  name: string;
  description: string;
  href: string;
  enabled: boolean;
  external?: boolean;
  icon: LucideIcon;
};

const RESOURCE_LINKS: ResourceLink[] = [
  {
    id: 'help',
    name: 'Help & tutorials',
    description: 'Video walkthroughs on YouTube',
    href: 'https://www.youtube.com/@apiomedev',
    enabled: true,
    external: true,
    icon: HelpCircle,
  },
  {
    id: 'community',
    name: 'Community',
    description: 'Connect with other builders',
    href: '/ade/community',
    enabled: false,
    icon: Users,
  },
  {
    id: 'marketplace',
    name: 'Marketplace',
    description: 'Templates and extensions',
    href: '/ade/marketplace',
    enabled: false,
    icon: Store,
  },
];

const COMING_SOON_AUDIT: ResourceLink[] = [
  {
    id: 'audit',
    name: 'Audit',
    description: 'Activity and compliance review',
    href: '/ade/audit',
    enabled: false,
    icon: Shield,
  },
];

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function userInitials(name: string | null | undefined): string {
  if (!name?.trim()) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

function AppLaunchCard({
  app,
  onLaunch,
}: {
  app: AppCardConfig;
  onLaunch: (app: AppCardConfig) => void;
}) {
  const Icon = app.icon;
  const LaunchArrow = app.external ? ArrowUpRight : ArrowRight;

  return (
    <button
      type="button"
      disabled={!app.enabled}
      aria-label={app.enabled ? `Open ${app.name}` : `${app.name} (coming soon)`}
      onClick={() => onLaunch(app)}
      className={cn(
        'group relative flex h-full min-h-[220px] flex-col overflow-hidden rounded-2xl border text-left transition-all duration-300',
        app.enabled
          ? cn(
              'cursor-pointer border-zinc-200/80 bg-white/75 shadow-sm backdrop-blur-md hover:-translate-y-0.5 hover:border-zinc-300/90 hover:shadow-xl dark:border-zinc-800/80 dark:bg-zinc-900/55 dark:hover:border-zinc-700/90',
              app.glow
            )
          : 'cursor-not-allowed border-zinc-200/60 bg-zinc-100/70 opacity-60 dark:border-zinc-800/50 dark:bg-zinc-900/30'
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-gradient-to-br opacity-[0.12] blur-2xl transition-opacity duration-500 group-hover:opacity-25 dark:opacity-[0.18] dark:group-hover:opacity-35',
          app.accent
        )}
      />
      <div className="relative flex flex-1 flex-col p-5">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-lg transition-transform duration-300 group-hover:scale-105',
              app.enabled ? `bg-gradient-to-br ${app.accent}` : 'bg-zinc-300 dark:bg-zinc-700'
            )}
          >
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </div>
          {app.enabled ? (
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200/80 bg-white/80 text-zinc-500 transition-all duration-300 group-hover:border-transparent group-hover:bg-zinc-900 group-hover:text-white dark:border-zinc-700/80 dark:bg-zinc-950/70 dark:text-zinc-400 dark:group-hover:bg-white dark:group-hover:text-zinc-900">
              <LaunchArrow className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </span>
          ) : (
            <span className="rounded-full border border-zinc-200/80 px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700/80 dark:text-zinc-400">
              Coming Soon
            </span>
          )}
        </div>

        <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          {app.tagline}
        </p>
        <h3 className="mt-1 text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {app.name}
        </h3>
        <p className="mt-2 flex-1 text-sm leading-relaxed text-zinc-600 line-clamp-4 dark:text-zinc-400">
          {app.description}
        </p>
        {app.external && app.enabled && (
          <p className="mt-3 text-2xs font-medium text-zinc-500 dark:text-zinc-500">
            Opens in a new tab
          </p>
        )}
      </div>
      {app.footerLabel && (
        <div
          className={cn(
            'relative border-t px-5 py-2.5',
            app.enabled
              ? 'border-zinc-200/70 bg-zinc-50/80 dark:border-zinc-800/70 dark:bg-zinc-950/40'
              : 'border-zinc-200/50 bg-zinc-100/60 dark:border-zinc-800/40 dark:bg-zinc-950/25'
          )}
        >
          <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
            {app.footerLabel}
          </span>
        </div>
      )}
    </button>
  );
}

function ResourceRow({
  item,
  onOpen,
}: {
  item: ResourceLink;
  onOpen: (item: ResourceLink) => void;
}) {
  const Icon = item.icon;

  return (
    <button
      type="button"
      disabled={!item.enabled}
      onClick={() => onOpen(item)}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
        item.enabled
          ? 'border-transparent hover:border-zinc-200/80 hover:bg-zinc-50/90 dark:hover:border-zinc-800/80 dark:hover:bg-zinc-900/70'
          : 'cursor-not-allowed opacity-50'
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.name}</span>
        <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{item.description}</span>
      </span>
      {item.enabled ? (
        item.external ? (
          <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        ) : (
          <ArrowRight className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-hover:translate-x-0.5" />
        )
      ) : (
        <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-zinc-400">Soon</span>
      )}
    </button>
  );
}

export default function AdeHome({
  commercialHomeCards = [],
  entitledFeatureFlags: _entitledFeatureFlags = [],
}: AdeHomeProps) {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  const primaryApps: AppCardConfig[] = [
    CORE_PRIMARY_APPS[0],
    ...commercialHomeCards.map(externalHomeCardToAppCard),
    CORE_PRIMARY_APPS[1],
  ];

  const firstName = session?.user?.name?.split(' ')[0] || 'there';
  const greeting = getGreeting();

  const launchApp = (app: AppCardConfig) => {
    if (!app.enabled) return;
    if (app.external) {
      window.open(app.href, '_blank', 'noopener,noreferrer');
      return;
    }
    router.push(app.href);
  };

  const openResource = (item: ResourceLink) => {
    if (!item.enabled) return;
    if (item.external) {
      window.open(item.href, '_blank', 'noopener,noreferrer');
      return;
    }
    router.push(item.href);
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(99,102,241,0.16),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(99,102,241,0.22),transparent)]" />
        <div className="absolute -left-24 top-24 h-72 w-72 rounded-full bg-violet-400/10 blur-3xl dark:bg-violet-500/15" />
        <div className="absolute -right-16 bottom-16 h-80 w-80 rounded-full bg-cyan-400/10 blur-3xl dark:bg-cyan-500/10" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(113,113,122,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(113,113,122,0.08)_1px,transparent_1px)] bg-[size:28px_28px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)] dark:bg-[linear-gradient(to_right,rgba(161,161,170,0.07)_1px,transparent_1px),linear-gradient(to_bottom,rgba(161,161,170,0.07)_1px,transparent_1px)]" />
      </div>

      <header className="sticky top-0 z-20 border-b border-zinc-200/70 bg-white/75 backdrop-blur-xl dark:border-zinc-800/70 dark:bg-zinc-950/75">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <BrandMark variant="wordmark" size={32} priority />
            <button
              type="button"
              onClick={() => {
                // The launcher's badge and the rail's user menu (HIVE-3.4, #5290) show the
                // same notes for the same build, so reading them here has to clear the
                // rail's unread dot as well.
                markWhatsNewSeen();
                setShowWhatsNew(true);
              }}
              className="rounded-full border border-zinc-200/80 px-2.5 py-1 text-2xs font-medium tracking-wide text-zinc-500 transition-colors hover:border-indigo-300 hover:text-indigo-600 dark:border-zinc-700/80 dark:text-zinc-400 dark:hover:border-indigo-500/50 dark:hover:text-indigo-400"
            >
              {APP_VERSION_BADGE}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openPreferences()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200/80 bg-white/80 text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:text-zinc-300 dark:hover:bg-zinc-800"
              aria-label="Preferences"
              title="Preferences (⌘,)"
            >
              <Settings2 className="h-4 w-4" aria-hidden />
            </button>
            <div className="hidden items-center gap-2 rounded-full border border-zinc-200/80 bg-white/80 py-1 pl-1 pr-2 dark:border-zinc-700/80 dark:bg-zinc-900/80 sm:flex">
              {session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.user.image}
                  alt=""
                  className="h-7 w-7 rounded-full object-cover"
                />
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-2xs font-semibold text-white">
                  {userInitials(session?.user?.name)}
                </span>
              )}
              <span className="max-w-[120px] truncate text-sm font-medium text-zinc-700 dark:text-zinc-200">
                {session?.user?.name?.split(' ')[0] ?? 'Account'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => signOutEverywhere('/login')}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200/80 bg-white/80 text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:text-zinc-300 dark:hover:bg-zinc-800"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-10 pt-10 sm:px-6 sm:pt-14 lg:px-8 lg:pt-16">
        <section className="mb-10 max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-200/80 bg-white/70 px-3 py-1 text-xs font-medium text-zinc-600 shadow-xs backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-900/60 dark:text-zinc-400">
            <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
            Apiome platform
          </div>
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {greeting}, {firstName}
          </p>
          <h1 className="mt-2 text-balance text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl dark:text-zinc-50">
            Your API{' '}
            <span className="bg-gradient-to-r from-indigo-600 via-violet-600 to-cyan-600 bg-clip-text text-transparent dark:from-indigo-400 dark:via-violet-400 dark:to-cyan-400">
              specification workspace
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
            Govern projects and versions, publish to the public catalog, and manage your API
            specification workspace from one place.
          </p>
        </section>

        <section aria-label="Applications" className="mb-8">
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                Applications
              </h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Jump into the tool you need right now.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {primaryApps.map((app) => (
              <AppLaunchCard key={app.id} app={app} onLaunch={launchApp} />
            ))}
          </div>
        </section>

        <section aria-label="Resources" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="rounded-2xl border border-zinc-200/80 bg-white/70 p-5 shadow-sm backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-900/55 lg:col-span-7">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
              Resources
            </h2>
            <p className="mt-1 mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Learn, connect, and extend your workflow.
            </p>
            <div className="space-y-1">
              {RESOURCE_LINKS.map((item) => (
                <ResourceRow key={item.id} item={item} onOpen={openResource} />
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-dashed border-zinc-300/80 bg-zinc-100/50 p-5 dark:border-zinc-700/80 dark:bg-zinc-900/30 lg:col-span-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
              On the roadmap
            </h2>
            <p className="mt-1 mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Governance and compliance tooling is in development.
            </p>
            <div className="space-y-1">
              {COMING_SOON_AUDIT.map((item) => (
                <ResourceRow key={item.id} item={item} onOpen={openResource} />
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-auto shrink-0 border-t border-zinc-200/70 bg-white/60 py-4 backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-950/60">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 text-xs text-zinc-500 sm:flex-row sm:px-6 lg:px-8 dark:text-zinc-500">
          <span>{APP_VERSION_BADGE}</span>
          <span>© 2021 – 2026 NobuData LLC</span>
        </div>
      </footer>

      {/* Preferences pane (HIVE-1.4, #5277). The launcher is the one `/ade` route with no
          rail, so it is the one route `AppShell` does not host the pane for. */}
      <PreferencesDrawerHost />
      {/* And the command palette (HIVE-3.6, #5292), for the same reason: `⌘K` has to work
          on the launcher too, and this is the only chrome the route draws. */}
      <CommandPaletteHost
        currentTenantId={
          (session?.user as { current_tenant_id?: string } | undefined)?.current_tenant_id ?? null
        }
      />
      {/* And the shortcuts sheet (HIVE-3.7, #5293), for the third time and the same reason:
          `?` has to work on the launcher too. */}
      <ShortcutsHost
        currentTenantId={
          (session?.user as { current_tenant_id?: string } | undefined)?.current_tenant_id ?? null
        }
      />
      <WhatsNewDialog isOpen={showWhatsNew} onClose={() => setShowWhatsNew(false)} />
    </div>
  );
}
