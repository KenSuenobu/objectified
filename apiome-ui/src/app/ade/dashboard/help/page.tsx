'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Keyboard, Sparkles } from 'lucide-react';

import { useAuthSession } from '@lib/auth/session-client';
import { APP_VERSION_BADGE } from '@lib/app-version';

import { Button } from '@/app/components/ui/Button';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { openShortcutSheet } from '@/app/components/shell/shortcutSheetBus';
import { markWhatsNewSeen } from '@/app/components/shell/whatsNewSeen';
import WhatsNewDialog from '@/app/components/ade/WhatsNewDialog';
import { clearDismissed } from '@/app/components/ade/dashboard/firstRunChecklist';
import {
  DASHBOARD_HOME_ROUTE,
  HelpCards,
  HelpGuideSearch,
  ShortcutsGlance,
} from '@/app/components/ade/help';

/**
 * Help & docs — `/ade/dashboard/help` (HIVE-4.9, #5303).
 *
 * Authority: `docs/mockups/foundations/help.html`; `DESIGN.md` §5.2 region 5 (the rail
 * footer row that points here) and §5.3 (the page header).
 *
 * ### What this route is for
 *
 * The rail footer has linked to *Help & docs* since HIVE-3.4 (#5290), and until now the link
 * resolved to the not-found page. Help itself was scattered: an intro-video link on the login
 * screen, a YouTube row and two coming-soon rows on the launcher, and no path at all from
 * inside the app to the written guides in `docs/guide`. This is the small landing surface
 * that makes the rail's link true and gives the guides one door.
 *
 * It is deliberately a *landing* page rather than a documentation viewer: the guides are
 * markdown in the repository, so every guide row and two of the cards leave for GitHub. What
 * this page owns is finding them, plus the three things a reader wants from help that are
 * not documents — the shortcut reference, the release notes, and the identifiers a support
 * request needs.
 *
 * ### Where each region's behaviour lives
 *
 * Almost none of it is here. The search is {@link HelpGuideSearch} over `helpCatalog`; the
 * cards are `HELP_CARDS` drawn by {@link HelpCards}; the strip is {@link ShortcutsGlance}
 * over the live shortcut registry. This component holds the two pieces that need the
 * session and the router — the build and tenant id the support card prints, and the
 * *Get started* card's return to Home — and the header that ties them together.
 *
 * ### The two header actions
 *
 * *Keyboard shortcuts* is the page's one primary button (DESIGN.md §7) and opens the HIVE-3.7
 * sheet through the shell's bus rather than mounting a second one, so `?` and this button
 * always open the same sheet. *What's new* mounts its own {@link WhatsNewDialog} — the rail's
 * copy is inside `UserMenu`, which is a menu this page cannot reach into — and marks the
 * build's notes read on open, exactly as the menu row does.
 */

/** Where the breadcrumb's first step returns to, and where *Get started* sends the reader. */
const HOME_ROUTE = DASHBOARD_HOME_ROUTE;

/** The page's `h1`. */
export const HELP_PAGE_TITLE = 'Help & docs';

/** The line under it — DESIGN.md §5.3 asks for fourteen words or fewer. */
const HELP_PAGE_DESCRIPTION =
  'Guides, shortcuts, what’s new and where to ask. Reachable from the rail on every page.';

/**
 * The Help & docs page.
 *
 * @returns The page header and its three regions: search, cards, shortcut strip.
 */
export default function HelpPage() {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const [whatsNewOpen, setWhatsNewOpen] = React.useState(false);

  const user = session?.user as { current_tenant_id?: string } | undefined;
  const tenantId = user?.current_tenant_id ?? null;

  /**
   * Reopen the getting-started checklist on Home.
   *
   * Clearing the flag before navigating is what makes this work: `FirstRunChecklist` reads
   * the dismissal once, in a state initialiser, so a checklist that mounts after the clear
   * sees an undismissed one.
   */
  const handleGetStarted = React.useCallback(() => {
    clearDismissed();
    router.push(HOME_ROUTE);
  }, [router]);

  /** Show the release notes, and stop the rail's unread dot from claiming they are unread. */
  const handleOpenWhatsNew = React.useCallback(() => {
    markWhatsNewSeen();
    setWhatsNewOpen(true);
  }, []);

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: 'Home', href: HOME_ROUTE }, { label: 'Help' }]}
        title={HELP_PAGE_TITLE}
        description={HELP_PAGE_DESCRIPTION}
        actions={
          <>
            <Button variant="outline" onClick={handleOpenWhatsNew} data-testid="help-whats-new">
              <Sparkles aria-hidden />
              What’s new
            </Button>
            {/* `openShortcutSheet()` answers `false` when no host is mounted, which on a
                dashboard route cannot happen — `AppShell` mounts exactly one. Nothing is done
                with the answer here for that reason: there is no second sheet to fall back to. */}
            <Button kbd="?" onClick={() => openShortcutSheet()} data-testid="help-shortcuts">
              <Keyboard aria-hidden />
              Keyboard shortcuts
            </Button>
          </>
        }
      />

      <PageBody>
        <HelpGuideSearch />

        <HelpCards
          onGetStarted={handleGetStarted}
          tenantId={tenantId}
          buildLabel={APP_VERSION_BADGE}
        />

        <ShortcutsGlance onOpenSheet={() => openShortcutSheet()} />
      </PageBody>

      <WhatsNewDialog isOpen={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
    </Page>
  );
}
