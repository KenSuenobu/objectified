/**
 * Lucide icons for the navigation model (HIVE-3.2, #5288).
 *
 * `lib/platform-nav.ts` names its icons as strings — the kebab-case Lucide ids
 * `docs/mockups/assets/hive.js` uses — rather than importing components. That
 * keeps the model plain data: it can be imported by a server module, a test or
 * a future command palette without dragging a rendering library along, and it
 * stays byte-comparable with the mockup it was transcribed from.
 *
 * This module is the one place that turns a name back into a component, in the
 * same shape `lib/external-links.ts` already uses for launcher cards:
 *
 * ```tsx
 * const Icon = resolvePlatformNavIcon(item.icon);
 * <Icon size={ICON_SIZE.rail} aria-hidden />
 * ```
 *
 * `tests/unit/platform-nav-model.test.ts` fails if the model ever names an icon
 * this map does not carry, so an unresolved glyph cannot reach the rail.
 */
import type { LucideIcon } from 'lucide-react';
import {
  BookOpenCheck,
  Box,
  Building2,
  CircleUser,
  FolderKanban,
  GitBranch,
  Globe,
  House,
  KeyRound,
  Library,
  Link,
  Network,
  PackageOpen,
  ScrollText,
  Shapes,
  Shield,
  ShieldCheck,
  Sunset,
  Users,
} from 'lucide-react';
import { DEFAULT_PLATFORM_NAV_ICON } from './platform-nav';

/** Every icon the navigation model can name, keyed by its Lucide id. */
export const PLATFORM_NAV_ICONS: Readonly<Record<string, LucideIcon>> = {
  'book-open-check': BookOpenCheck,
  box: Box,
  'building-2': Building2,
  'circle-user': CircleUser,
  'folder-kanban': FolderKanban,
  'git-branch': GitBranch,
  globe: Globe,
  house: House,
  'key-round': KeyRound,
  library: Library,
  link: Link,
  network: Network,
  'package-open': PackageOpen,
  'scroll-text': ScrollText,
  shapes: Shapes,
  shield: Shield,
  'shield-check': ShieldCheck,
  sunset: Sunset,
  users: Users,
};

/**
 * Resolve a navigation icon name to its component.
 *
 * @param name - Lucide id from {@link PlatformNavItem.icon}.
 * @returns The matching icon, or the generic box when the name is unknown —
 *   a contributed destination always renders something.
 */
export function resolvePlatformNavIcon(name: string): LucideIcon {
  return PLATFORM_NAV_ICONS[name] ?? PLATFORM_NAV_ICONS[DEFAULT_PLATFORM_NAV_ICON];
}
