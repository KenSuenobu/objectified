import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Box,
  Compass,
  Globe,
  LayoutDashboard,
  Palette,
  Rocket,
  Route,
  Sparkles,
  Layers,
  PenTool,
  Workflow,
} from 'lucide-react';
import { getBuiltinCommercialProducts } from './commercial-products';
import {
  getSuiteMenuContribution,
  type SuiteHomeCard,
  type SuiteNavMenuItem,
} from './suite-contract';

/** One commercial application surfaced in nav and/or the ADE home grid. */
export type ExternalLinkEntry = {
  id: string;
  /** Label in a cross-product nav menu — today the commercial Studio's top bar. */
  navLabel: string;
  /** Primary title on the home application card. */
  name: string;
  /** Short category line on the home card. */
  tagline: string;
  description: string;
  href: string;
  /** Optional deep link base for post-import "open in editor" flows. */
  editorHref?: string;
  icon: string;
  /**
   * @deprecated Pre-Hive Tailwind gradient pair for the home card. The launcher draws a
   * tone-tinted hexagon since HIVE-4.5 (#5299) and never reads this; it is kept because a
   * commercial host still supplies it through the suite contract.
   */
  accent: string;
  /** @deprecated Pre-Hive hover-shadow class. See {@link ExternalLinkEntry.accent}. */
  glow: string;
  /**
   * Identity hue for the home card, named from the shared status vocabulary
   * (`ui/statusVocabulary`). Optional: a host that declares none gets the commercial
   * fallback, and an unrecognised value is ignored rather than trusted.
   */
  tone?: string;
  enabled?: boolean;
  external?: boolean;
  opensNewBrowser?: boolean;
  showInNav?: boolean;
  showOnHome?: boolean;
  /** Single license flag required for this entry. */
  featureFlag?: string;
  /** Entitled when the user has any of these license flags. */
  anyFeatureFlags?: string[];
  /** Dropdown destinations shown from the nav item (box menu). */
  menuItems?: ExternalNavMenuItem[];
  /** Ordered group headings for `menuItems`; items reference these by id. */
  menuGroups?: ExternalNavMenuGroup[];
};

/**
 * A labeled heading that groups destinations inside a nav dropdown.
 * Headings are announced to assistive technology but are never focusable
 * menu actions (UXE-1.1).
 */
export type ExternalNavMenuGroup = {
  id: string;
  label: string;
};

/** One destination inside a nav dropdown (box menu) — e.g. a suite product. */
export type ExternalNavMenuItem = {
  id: string;
  label: string;
  /** Short line under the label in the box menu tile. */
  description?: string;
  href: string;
  /** Lucide icon name — resolved to a component on the client. */
  icon?: string;
  external?: boolean;
  opensNewBrowser?: boolean;
  featureFlag?: string;
  anyFeatureFlags?: string[];
  /** Id of the {@link ExternalNavMenuGroup} this destination belongs to. */
  group?: string;
  /** Short status chip beside the label, e.g. `Preview` or `Coming soon`. */
  badge?: string;
  /** `false` when the destination has not shipped yet — rendered non-navigable. */
  enabled?: boolean;
  /**
   * One sentence explaining how to obtain access. Shown in place of the
   * description when the viewer is not entitled or the destination is disabled.
   */
  accessNote?: string;
  /**
   * Resolved by {@link getCommercialNavItems}: `false` when the viewer lacks
   * the required license flags. Unentitled destinations keep their label so
   * access can be explained, but their `href` is cleared so no resource URL
   * reaches the client.
   */
  entitled?: boolean;
};

/** A group heading paired with the destinations that belong to it. */
export type ResolvedNavMenuGroup = ExternalNavMenuGroup & {
  items: ExternalNavMenuItem[];
};

export type ExternalNavItem = {
  id: string;
  label: string;
  href: string;
  enabled?: boolean;
  external?: boolean;
  opensNewBrowser?: boolean;
  featureFlag?: string;
  anyFeatureFlags?: string[];
  /** When present the nav item renders as a dropdown (box menu) of these destinations. */
  menuItems?: ExternalNavMenuItem[];
  /** Ordered group headings for `menuItems`; items reference these by id. */
  menuGroups?: ExternalNavMenuGroup[];
};

export type ExternalHomeCard = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  href: string;
  enabled: boolean;
  external?: boolean;
  opensNewBrowser?: boolean;
  /** Lucide icon name — resolved to a component on the client. */
  icon: string;
  /** @deprecated See {@link ExternalLinkEntry.accent} — the launcher draws a tone instead. */
  accent: string;
  /** @deprecated See {@link ExternalLinkEntry.accent}. */
  glow: string;
  /** Identity hue, from the shared status vocabulary. See {@link ExternalLinkEntry.tone}. */
  tone?: string;
  featureFlag?: string;
  anyFeatureFlags?: string[];
};

const KNOWN_ICONS: Record<string, LucideIcon> = {
  BarChart3,
  Box,
  Compass,
  Globe,
  LayoutDashboard,
  Palette,
  Rocket,
  Route,
  Sparkles,
  Layers,
  PenTool,
  Workflow,
};

/** Fallback heading used for destinations that declare no group. */
const UNGROUPED_ID = '';

function normalizeEntry(entry: ExternalLinkEntry): ExternalLinkEntry {
  return {
    ...entry,
    enabled: entry.enabled !== false,
    external: entry.external !== false,
    showInNav: entry.showInNav !== false,
    showOnHome: entry.showOnHome !== false,
  };
}

/**
 * Merge a commercial suite host contribution into the built-in suite entry.
 *
 * @param entry - Built-in commercial catalog entry.
 * @returns Entry with contributed groups/items appended when `id === 'suite'`.
 */
function applySuiteContribution(entry: ExternalLinkEntry): ExternalLinkEntry {
  const contrib = getSuiteMenuContribution();
  if (!contrib || entry.id !== 'suite') return entry;

  const contributedItems = (contrib.menuItems ?? []) as SuiteNavMenuItem[];
  return {
    ...entry,
    menuGroups: [...(entry.menuGroups ?? []), ...(contrib.menuGroups ?? [])],
    menuItems: [...(entry.menuItems ?? []), ...contributedItems],
  };
}

function loadLinks(): ExternalLinkEntry[] {
  const builtins = getBuiltinCommercialProducts()
    .map(applySuiteContribution)
    .map(normalizeEntry)
    // Keep disabled catalog entries that still appear on the home grid (e.g. Coming Soon).
    .filter((link) => link.enabled !== false || link.showOnHome);

  const contrib = getSuiteMenuContribution();
  const extraCards = (contrib?.homeCards ?? []).map((card: SuiteHomeCard): ExternalLinkEntry => ({
    id: card.id,
    navLabel: card.name,
    name: card.name,
    tagline: card.tagline,
    description: card.description,
    href: card.href,
    icon: card.icon,
    accent: card.accent,
    glow: card.glow,
    tone: card.tone,
    enabled: card.enabled,
    external: card.external,
    opensNewBrowser: card.opensNewBrowser,
    featureFlag: card.featureFlag,
    anyFeatureFlags: card.anyFeatureFlags,
    showInNav: false,
    showOnHome: true,
  }));

  return [...builtins, ...extraCards.map(normalizeEntry)];
}

function isEntitledToEntry(
  entry: { featureFlag?: string; anyFeatureFlags?: string[] },
  entitledFlags: Set<string>
): boolean {
  if (entry.anyFeatureFlags?.length) {
    return entry.anyFeatureFlags.some((flag) => entitledFlags.has(flag));
  }
  if (!entry.featureFlag) return true;
  return entitledFlags.has(entry.featureFlag);
}

export function resolveExternalLinkIcon(iconName: string): LucideIcon {
  return KNOWN_ICONS[iconName] ?? Box;
}

export function getExternalLinkEntries(): ExternalLinkEntry[] {
  return loadLinks();
}

export function getExternalLinkById(id: string): ExternalLinkEntry | undefined {
  return loadLinks().find((link) => link.id === id);
}

export function getExternalNavItems(): ExternalNavItem[] {
  // Disabled entries stay in nav (rendered shaded as "coming soon") when showInNav is set.
  return loadLinks()
    .filter((link) => link.showInNav)
    .map((link) => ({
      id: link.id,
      label: link.navLabel,
      href: link.href,
      enabled: link.enabled,
      external: link.external,
      opensNewBrowser: link.opensNewBrowser,
      featureFlag: link.featureFlag,
      anyFeatureFlags: link.anyFeatureFlags,
      menuItems: link.menuItems,
      menuGroups: link.menuGroups,
    }));
}

export function getExternalHomeCards(): ExternalHomeCard[] {
  return loadLinks()
    .filter((link) => link.showOnHome)
    .map((link) => ({
      id: link.id,
      name: link.name,
      tagline: link.tagline,
      description: link.description,
      href: link.href,
      enabled: link.enabled ?? true,
      external: link.external,
      opensNewBrowser: link.opensNewBrowser,
      icon: link.icon,
      accent: link.accent,
      glow: link.glow,
      tone: link.tone,
      featureFlag: link.featureFlag,
      anyFeatureFlags: link.anyFeatureFlags,
    }));
}

/** Home cards limited to flags the user is entitled to via license/admin overrides. */
export function getCommercialHomeCards(entitledFlags: Set<string>): ExternalHomeCard[] {
  return getExternalHomeCards().filter((card) => isEntitledToEntry(card, entitledFlags));
}

/**
 * Nav items limited to flags the user is entitled to via license/admin overrides.
 *
 * Top-level products the viewer cannot reach are removed outright. Dropdown
 * destinations are *kept* but annotated (UXE-1.1): the menu explains how to get
 * access rather than silently hiding the product, while the `href` is cleared so
 * no unentitled resource URL is serialized to the client.
 *
 * @param entitledFlags - License flags granted to the current session.
 * @returns Nav items whose `menuItems` each carry a resolved `entitled` flag.
 */
export function getCommercialNavItems(entitledFlags: Set<string>): ExternalNavItem[] {
  return getExternalNavItems()
    .filter((item) => isEntitledToEntry(item, entitledFlags))
    .map((item) =>
      item.menuItems
        ? {
            ...item,
            menuItems: item.menuItems.map((menuItem) => {
              const entitled = isEntitledToEntry(menuItem, entitledFlags);
              return entitled ? { ...menuItem, entitled } : { ...menuItem, entitled, href: '' };
            }),
          }
        : item
    );
}

/**
 * Split a nav item's destinations into its declared group order.
 *
 * Destinations with no `group` (or one that matches no declared heading) fall
 * into a single leading group with an empty label, so legacy flat menus keep
 * rendering unchanged. Groups that end up with no destinations are dropped.
 *
 * @param item - Nav item whose dropdown should be grouped.
 * @returns Ordered groups, each with at least one destination.
 */
export function groupNavMenuItems(item: ExternalNavItem): ResolvedNavMenuGroup[] {
  const menuItems = item.menuItems ?? [];
  const declared = item.menuGroups ?? [];
  const declaredIds = new Set(declared.map((group) => group.id));

  const ordered: ResolvedNavMenuGroup[] = [
    { id: UNGROUPED_ID, label: '', items: [] },
    ...declared.map((group) => ({ ...group, items: [] as ExternalNavMenuItem[] })),
  ];
  const byId = new Map(ordered.map((group) => [group.id, group]));

  for (const menuItem of menuItems) {
    const groupId = menuItem.group && declaredIds.has(menuItem.group) ? menuItem.group : UNGROUPED_ID;
    byId.get(groupId)!.items.push(menuItem);
  }

  return ordered.filter((group) => group.items.length > 0);
}

/** True when a destination can be navigated to (shipped and entitled). */
export function isNavMenuItemNavigable(menuItem: ExternalNavMenuItem): boolean {
  return menuItem.enabled !== false && menuItem.entitled !== false && menuItem.href !== '';
}

function hasSuiteEntitlement(entitledFlags?: Set<string>): boolean {
  if (!entitledFlags) return true;
  return entitledFlags.has('designer') || entitledFlags.has('paths');
}

/** Home/checklist entry for the designer suite when the user has suite access. */
export function getDesignerHomeHref(entitledFlags?: Set<string>): string | null {
  if (!hasSuiteEntitlement(entitledFlags)) {
    return null;
  }
  const suite = getExternalLinkById('suite');
  if (suite?.href) return suite.href;
  return null;
}

/** Deep link into a commercial studio editor after import completes. */
export function buildDesignerEditorHref(
  projectId: string,
  versionId: string,
  entitledFlags?: Set<string>
): string | null {
  if (!hasSuiteEntitlement(entitledFlags)) {
    return null;
  }
  const suite = getExternalLinkById('suite');
  const base = suite?.editorHref ?? suite?.href ?? null;
  if (!base) {
    return null;
  }
  try {
    const url = base.startsWith('http://') || base.startsWith('https://')
      ? new URL(base)
      : new URL(base, 'http://local.invalid');
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('versionId', versionId);
    return base.startsWith('http://') || base.startsWith('https://')
      ? url.toString()
      : `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
