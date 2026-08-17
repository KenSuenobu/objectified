/**
 * What the Help & docs page is made of, decided outside React (HIVE-4.9, #5303).
 *
 * Authority: `docs/mockups/foundations/help.html` — six cards, a shortcut strip and a
 * support card that prints the tenant id and the build.
 *
 * The page itself is markup: every decision that can be made without a DOM is made here so a
 * unit test can ask about it directly. That is the same split `launcherModel` uses for the
 * launcher, and for the same reason — the interesting parts of a landing page are *which
 * destinations it offers* and *what it says about the reader's install*, neither of which
 * needs a render to check.
 */

import {
  BookOpen,
  LifeBuoy,
  MessagesSquare,
  Rocket,
  Terminal,
  Youtube,
  type LucideIcon,
} from 'lucide-react';

import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import { buildDocsHref } from '@/app/utils/docsLinks';
import { groupShortcutsByScope, type ShortcutBinding } from '@lib/shortcuts';

/**
 * How a card behaves when it is chosen.
 *
 * The distinction matters to the markup, not only to the model: a destination is an anchor,
 * something that happens in this tab is a button, and a card with nothing behind it yet is a
 * disabled button rather than a `div` wearing a label (HIVE-4.5 made the same call for the
 * launcher's rows, because a role-less element carrying `aria-disabled` is an axe finding).
 */
export type HelpCardKind =
  /** Leaves the app: opens in a new tab. */
  | 'external'
  /** Runs something here — the page passes the handler. */
  | 'action'
  /** Not shipped yet: drawn non-interactive, with a chip that says so. */
  | 'soon'
  /** The support card, which carries the tenant id, the build, and two affordances. */
  | 'support';

/** One card in the help grid. */
export interface HelpCard {
  /** Stable id: the React key and the test handle. */
  id: string;
  /** The card's title. */
  title: string;
  /** The card's body — one sentence about what is behind it. */
  description: string;
  /** How choosing it behaves. */
  kind: HelpCardKind;
  /** Where it goes. Absent for `action`, `soon` and `support`. */
  href?: string;
  /** The card's glyph. */
  icon: LucideIcon;
  /** The card's identity hue, from the shared status vocabulary. */
  tone: StatusTone;
  /** The chip beside the title of a card that cannot be opened yet. */
  badge?: string;
}

/** The screencast channel — the launcher's old *Help & tutorials* destination. */
export const VIDEO_WALKTHROUGHS_URL = 'https://www.youtube.com/@apiomedev';

/** Where a support conversation starts: the repository's issue tracker. */
export const SUPPORT_ISSUE_URL = 'https://github.com/apiome/apiome/issues/new';

/** The Home route the *Get started* card returns to, where the checklist lives. */
export const DASHBOARD_HOME_ROUTE = '/ade/dashboard';

/**
 * The six cards, in the order the mockup draws them.
 *
 * *Get started* is first and honey because it is the one card that does something for a
 * reader who has not done anything yet; *Contact support* is last because it is where a
 * reader lands when the other five did not answer them.
 */
export const HELP_CARDS: readonly HelpCard[] = [
  {
    id: 'get-started',
    title: 'Get started',
    description:
      'First project → first version → publish → browse. Reopens the getting-started checklist on Home.',
    kind: 'action',
    icon: Rocket,
    tone: 'honey',
  },
  {
    id: 'user-guide',
    title: 'User guide',
    description:
      'Import a spec, edit classes & paths, cut a version, lint & quality, export fidelity, MCP quick-start.',
    kind: 'external',
    href: buildDocsHref('docs/guide/README.md'),
    icon: BookOpen,
    tone: 'accent',
  },
  {
    id: 'api-cli',
    title: 'API & CLI reference',
    description: 'REST API, the apiome CLI, and CI diff-gate recipes for GitHub, GitLab and Bitbucket.',
    kind: 'external',
    href: buildDocsHref('docs/guide/api-reference.md'),
    icon: Terminal,
    tone: 'ok',
  },
  {
    id: 'video',
    title: 'Video walkthroughs',
    description: 'Short screencasts on YouTube.',
    kind: 'external',
    href: VIDEO_WALKTHROUGHS_URL,
    icon: Youtube,
    tone: 'violet',
  },
  {
    id: 'community',
    title: 'Community',
    description: 'Connect with other builders.',
    kind: 'soon',
    icon: MessagesSquare,
    tone: 'neutral',
    badge: 'Soon',
  },
  {
    id: 'support',
    title: 'Contact support',
    description:
      'Open an issue with the details below — a tenant id and a build turn a report into something reproducible.',
    kind: 'support',
    icon: LifeBuoy,
    tone: 'rose',
  },
] as const;

/** What the support card prints when the session carries no workspace. */
export const NO_TENANT_LABEL = 'No workspace selected';

/**
 * The block a reader pastes into a support request.
 *
 * One string rather than two copy buttons: a report needs both identifiers, and the pair
 * copied together cannot arrive half-quoted. A session with no current workspace still
 * produces a usable block — the build alone is what most questions turn on, and the tenant
 * line states its own absence rather than being silently dropped.
 *
 * @param tenantId `current_tenant_id` from the session, if any.
 * @param buildLabel The build badge, e.g. `v0.241.0 RC`.
 * @returns Two labelled lines, newline-separated.
 */
export function supportDetails(tenantId: string | null | undefined, buildLabel: string): string {
  return `Tenant id: ${tenantId || NO_TENANT_LABEL}\nBuild: ${buildLabel}`;
}

/** How many rows the *Shortcuts at a glance* strip prints before deferring to the sheet. */
export const SHORTCUT_GLANCE_LIMIT = 8;

/**
 * The shortcuts the glance strip prints.
 *
 * Taken from the live registry rather than written down, which is the rule HIVE-3.7 (#5293)
 * set for the sheet: a strip listing `G P` on a screen where nothing is bound to it is a
 * promise the keyboard does not keep. {@link groupShortcutsByScope} already does the two
 * things this needs — one row per id even when two hosts are mounted, and the sheet's
 * reading order — so the strip and the sheet agree about what comes first.
 *
 * A gated binding is left out. The sheet keeps it and states the reason underneath, which a
 * one-line row has no room for; printing it here without the reason would be the one thing
 * worse than omitting it.
 *
 * @param bindings The registry snapshot, oldest registration first.
 * @param limit How many rows to keep. Defaults to {@link SHORTCUT_GLANCE_LIMIT}.
 * @returns The first `limit` usable bindings, in the sheet's own order.
 */
export function glanceShortcuts(
  bindings: readonly ShortcutBinding[],
  limit: number = SHORTCUT_GLANCE_LIMIT
): readonly ShortcutBinding[] {
  return groupShortcutsByScope(bindings)
    .flatMap((section) => section.shortcuts)
    .filter((shortcut) => !shortcut.disabledReason)
    .slice(0, limit);
}
