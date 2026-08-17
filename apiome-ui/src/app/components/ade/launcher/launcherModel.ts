/**
 * The launcher's data, with no React in it (HIVE-4.5, #5299).
 *
 * `/ade` is a router: a greeting, a grid of applications and a short list of resources. What
 * each of those *is* — the order the applications appear in, which of them a host injected,
 * what tone a card carries, how a summary chip is worded — is decided here so it can be unit
 * tested without rendering a page, and so `AdeHome` is left holding only the composition.
 *
 * Two rules this module exists to keep:
 *
 * 1. **No route into a separate product is written down.** The commercial slot is filled from
 *    `getCommercialAccessForSession().homeCards`, which the entitlement layer has already
 *    filtered; this module only decides *where in the order* those cards land.
 * 2. **A card's hue is an identity, not a gradient.** The pre-Hive cards each named a Tailwind
 *    gradient pair (`from-indigo-500 to-violet-600`), which froze on one palette. A card now
 *    names a tone from the shared vocabulary, so it follows all nine themes.
 */
import {
  Globe,
  HelpCircle,
  LayoutDashboard,
  MessagesSquare,
  ScrollText,
  Store,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { BROWSE_APP_URL } from '@lib/app-urls';
import { HELP_ROUTE } from '@/app/components/shell/appShellRoutes';
import { resolveExternalLinkIcon, type ExternalHomeCard } from '@lib/external-links';
import { STATUS_TONES, type StatusTone } from '@/app/components/ui/statusVocabulary';

/**
 * The hue a launcher card or resource row carries.
 *
 * These are the shared vocabulary's tones (`ui/statusVocabulary`), reused the way the avatar
 * tints reuse them (HIVE-2.2): the tone names a `-soft` fill and its matching `-fg` ink, both
 * of which every theme swaps, so a card keeps its identity without owning a colour.
 */
export type LauncherTone = StatusTone;

/**
 * The tone a commercial card falls back to when its host declares none.
 *
 * Violet is the design language's "another product" hue — the mockup draws the commercial
 * slot and the Developer Suite in it — and a host that predates the `tone` field on the suite
 * contract therefore still gets a card that reads as commercial rather than as core.
 */
export const COMMERCIAL_FALLBACK_TONE: LauncherTone = 'violet';

/**
 * Narrow a host-supplied tone name to one the design language actually paints.
 *
 * The suite contract crosses a repository boundary, so `tone` arrives as an unvalidated
 * string. Anything outside the vocabulary is discarded rather than pasted into a class name:
 * a typo in another repository must not be able to produce an unstyled card here.
 *
 * @param tone The `tone` a home card declared, if any.
 * @param fallback The tone to use when none was declared or it is not in the vocabulary.
 * @returns A tone this app can paint.
 */
export function resolveLauncherTone(
  tone: string | undefined,
  fallback: LauncherTone = COMMERCIAL_FALLBACK_TONE
): LauncherTone {
  return (STATUS_TONES as readonly string[]).includes(tone ?? '')
    ? (tone as LauncherTone)
    : fallback;
}

/** One application tile in the launcher grid. */
export interface LauncherApp {
  /** Stable id: the React key and the test handle. */
  id: string;
  /** The card's title. */
  name: string;
  /** The uppercase category line above the title. */
  tagline: string;
  /** One sentence, clamped to four lines. */
  description: string;
  /** Where the card goes. Never navigated when `enabled` is false. */
  href: string;
  /** False for a listed-but-unshipped product, which is drawn non-interactive. */
  enabled: boolean;
  /** True when the destination is another origin, which opens in a new tab. */
  external?: boolean;
  /** The card's subject glyph. */
  icon: LucideIcon;
  /** The card's identity hue. */
  tone: LauncherTone;
  /** The quiet line in the card's footer strip, e.g. `Included` or `Commercial`. */
  footerLabel: string;
}

/** One row in the Resources / On the roadmap panels. */
export interface LauncherResource {
  /** Stable id: the React key and the test handle. */
  id: string;
  /** The row's title. */
  name: string;
  /** The row's second line. */
  description: string;
  /** Where the row goes. Never navigated when `enabled` is false. */
  href: string;
  /** False for an unshipped destination, which is drawn non-interactive. */
  enabled: boolean;
  /** True when the destination is another origin, which opens in a new tab. */
  external?: boolean;
  /** The row's glyph. */
  icon: LucideIcon;
  /** The row's identity hue. */
  tone: LauncherTone;
  /** The chip on a row that cannot be opened yet. */
  comingSoonLabel?: string;
}

/** The governance app every install has. Always first in the grid. */
const CONTROL_PANEL: LauncherApp = {
  id: 'control-panel',
  name: 'Control Panel',
  tagline: 'Governance',
  description: 'Tenants, projects, versions, repositories, and platform settings in one place.',
  href: '/ade/dashboard',
  enabled: true,
  icon: LayoutDashboard,
  tone: 'accent',
  footerLabel: 'Included',
};

/** The public catalog. Always last in the grid, and always another origin. */
const BROWSER: LauncherApp = {
  id: 'browser',
  name: 'Browser',
  tagline: 'Public catalog',
  description: 'Discover and compare published specifications from every organization.',
  href: BROWSE_APP_URL,
  enabled: true,
  external: true,
  icon: Globe,
  tone: 'ok',
  footerLabel: 'Public',
};

/** What a card's footer says when the product is licensed rather than bundled. */
const COMMERCIAL_FOOTER_LABEL = 'Commercial';

/** Learn / connect / extend — the left-hand panel under the grid. */
export const LAUNCHER_RESOURCES: readonly LauncherResource[] = [
  {
    // HIVE-4.9 (#5303): this row used to be the YouTube channel, which made the launcher the
    // only place in the app that answered "where is the help?" — and answered it with videos
    // alone. The channel is now one card on `/ade/dashboard/help`, beside the written guides,
    // the shortcut reference and the support details, so the row points at the page that has
    // all of them rather than duplicating one of them here.
    id: 'help',
    name: 'Help & docs',
    description: 'Guides, shortcuts, videos and support',
    href: HELP_ROUTE,
    enabled: true,
    external: false,
    icon: HelpCircle,
    tone: 'rose',
  },
  {
    id: 'community',
    name: 'Community',
    description: 'Connect with other builders',
    href: '/ade/community',
    enabled: false,
    icon: MessagesSquare,
    tone: 'accent',
    comingSoonLabel: 'Soon',
  },
  {
    id: 'marketplace',
    name: 'Marketplace',
    description: 'Templates and extensions',
    href: '/ade/marketplace',
    enabled: false,
    icon: Store,
    tone: 'violet',
    comingSoonLabel: 'Soon',
  },
] as const;

/** The dashed panel: what is being built, stated rather than hinted at. */
export const LAUNCHER_ROADMAP: readonly LauncherResource[] = [
  {
    id: 'audit',
    name: 'Audit',
    description: 'Activity and compliance review',
    href: '/ade/audit',
    enabled: false,
    icon: ScrollText,
    tone: 'warn',
    comingSoonLabel: 'Planned',
  },
] as const;

/**
 * Turn one entitlement-filtered home card into a grid tile.
 *
 * The card arrives from `lib/external-links` already gated: an unentitled product is not in
 * the list at all. Everything visual about it — icon, tone — is resolved here, so a host that
 * declares neither still renders inside the design language.
 *
 * @param card A home card from `getCommercialAccessForSession().homeCards`.
 * @returns The tile, tinted with the card's declared tone or the commercial fallback.
 */
export function commercialCardToApp(card: ExternalHomeCard): LauncherApp {
  return {
    id: card.id,
    name: card.name,
    tagline: card.tagline,
    description: card.description,
    href: card.href,
    enabled: card.enabled,
    external: card.external,
    icon: resolveExternalLinkIcon(card.icon),
    tone: resolveLauncherTone(card.tone),
    footerLabel: COMMERCIAL_FOOTER_LABEL,
  };
}

/**
 * The application grid, in the order the launcher draws it.
 *
 * Control Panel, then whatever the host injected, then the Browser. The middle is the whole
 * commercial surface of this page: when the reader is entitled to nothing it is empty and the
 * grid is two cards wide, which is exactly what an open-source install should look like.
 *
 * @param commercialHomeCards Entitlement-filtered cards, in the entitlement layer's order.
 * @returns Every tile to render, core and commercial alike.
 */
export function launcherApps(
  commercialHomeCards: readonly ExternalHomeCard[] = []
): LauncherApp[] {
  return [CONTROL_PANEL, ...commercialHomeCards.map(commercialCardToApp), BROWSER];
}

/**
 * The accessible name of a card or row.
 *
 * A disabled tile must still say what it is and why it cannot be opened — "Developer Suite
 * (coming soon)" — because the visual cue for it is a chip and 60 % opacity, neither of which
 * reaches a screen reader.
 *
 * @param name The product or resource name.
 * @param enabled Whether the destination can be opened.
 * @returns The `aria-label` to put on the tile.
 */
export function launcherItemLabel(name: string, enabled: boolean): string {
  return enabled ? `Open ${name}` : `${name} (coming soon)`;
}

/** Boundaries of the time-of-day greeting, in hours past midnight, local time. */
const MORNING_ENDS_AT = 12;
const AFTERNOON_ENDS_AT = 17;

/**
 * The time-of-day greeting.
 *
 * @param hour Hours past local midnight. Defaults to now, which is why the greeting is
 *             computed on the client — the server's clock is not the reader's.
 * @returns `Good morning`, `Good afternoon` or `Good evening`.
 */
export function greetingFor(hour: number = new Date().getHours()): string {
  if (hour < MORNING_ENDS_AT) return 'Good morning';
  if (hour < AFTERNOON_ENDS_AT) return 'Good afternoon';
  return 'Good evening';
}

/** What the *greeting* calls a reader whose display name never arrived. */
export const ANONYMOUS_FIRST_NAME = 'there';

/**
 * What the *account chip* calls the same reader.
 *
 * Deliberately not `there`: "Good evening, there" reads as a greeting with a missing name,
 * while a chip labelled "there" reads as a bug. Both fallbacks are what the pre-Hive
 * launcher used, in the same two places.
 */
export const ANONYMOUS_ACCOUNT_NAME = 'Account';

/**
 * The reader's first name.
 *
 * @param name The session's display name, which may be absent on a credentials account.
 * @param fallback What to call them when it is — the greeting and the account chip differ.
 * @returns The first word of the display name, or `fallback`.
 */
export function firstNameOf(
  name: string | null | undefined,
  fallback: string = ANONYMOUS_FIRST_NAME
): string {
  const first = name?.trim().split(/\s+/)[0];
  return first || fallback;
}

/**
 * The account chip's accessible name.
 *
 * The chip shows one word; the whole display name belongs in the label, which is what the
 * mockup writes ("Account menu for Ada Lovelace"). A reader with no display name gets the
 * promise without the name rather than "Account menu for Account".
 *
 * @param name The session's display name, if there is one.
 * @returns The `aria-label` for the chip.
 */
export function accountMenuLabel(name: string | null | undefined): string {
  const full = name?.trim();
  return full ? `Account menu for ${full}` : 'Account menu';
}

/**
 * Pluralise a count for a summary chip.
 *
 * @param count How many.
 * @param singular The noun in its singular form.
 * @returns e.g. `1 project`, `3 projects`.
 */
export function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** What an external card promises before it is clicked. */
export const OPENS_IN_NEW_TAB = 'Opens in a new tab';
