'use client';

import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Bell, CircleUser, Keyboard, Palette, X } from 'lucide-react';
import { TAB_LIST_CLASS } from '../ui/tabStyles';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs';
import { usePreferences } from '../../providers/PreferencesProvider';
import { useTheme } from '../../providers/ThemeProvider';
import AccountTab from './preferences/AccountTab';
import AppearanceTab from './preferences/AppearanceTab';
import NotificationsTab from './preferences/NotificationsTab';
import ShortcutsTab from './preferences/ShortcutsTab';

/**
 * The preferences pane (HIVE-1.4, #5277) — replaces the "Select Theme" dialog.
 *
 * A right-hand drawer rather than a modal grid, for the reason the design document gives:
 * preferences are glanceable and personal, and keeping the current screen in view is what
 * makes the effect of a theme, font-size or density change visible as it is made. Every
 * control applies immediately and persists on write, so the footer says "Saved
 * automatically" and there is no Save button to disagree with.
 *
 * Built on Radix's Dialog, which supplies the behaviours the ticket asks for and which are
 * genuinely hard to get right by hand: the focus trap while open, `Esc` and backdrop
 * dismissal, and focus restored to whatever opened it. It is styled as a side sheet rather
 * than a centred box — the primitive is about behaviour, not geometry, which is why this
 * uses `@radix-ui/react-dialog` directly instead of `ui/Dialog` (that wrapper hard-codes
 * the centred, `max-w-lg` box).
 *
 * The pane owns no state of its own. Theme comes from `ThemeProvider`, everything else
 * from `PreferencesProvider`, and both write through to `localStorage` — so what the pane
 * shows is what the shell is rendering from, on this route and the next one.
 *
 * @see `docs/mockups/foundations/settings-pane.html` for the reference behaviour.
 * @see `docs/mockups/DESIGN.md` §4.1 for the anatomy and the persistence contract.
 */

/** The tabs, in the order `DESIGN.md` §4.1 lists them. */
const TABS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'account', label: 'Account', icon: CircleUser },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
] as const;

/**
 * Tab ink in the theme accent rather than the app-wide indigo.
 *
 * The geometry — the underline strip every tab in the app shares — still comes from
 * `tabStyles`; only the colour is restated, because a pane whose whole job is to preview
 * nine palettes cannot ink its own chrome in a tenth.
 */
const TAB_ACCENT_CLASS =
  'data-[state=active]:border-accent data-[state=active]:text-accent ' +
  'dark:data-[state=active]:border-accent dark:data-[state=active]:text-accent';

export interface PreferencesDrawerProps {
  /** Whether the pane is showing. */
  open: boolean;
  /** Called with the next open state — on Done, `Esc`, the backdrop and the close button. */
  onOpenChange: (open: boolean) => void;
}

export default function PreferencesDrawer({ open, onOpenChange }: PreferencesDrawerProps) {
  const { currentTheme, resolvedTheme, setTheme, availableThemes, isSystemTheme } = useTheme();
  const { preferences, setPreference } = usePreferences();
  const [tab, setTab] = useState<string>(TABS[0].id);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9998] bg-overlay" />
        <Dialog.Content
          data-testid="preferences-drawer"
          aria-describedby="preferences-drawer-description"
          className="fixed inset-y-0 right-0 z-[9999] flex h-full w-full max-w-[520px] flex-col bg-surface shadow-lg focus:outline-none"
        >
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-fg">Preferences</Dialog.Title>
              <Dialog.Description
                id="preferences-drawer-description"
                className="text-xs text-fg-muted"
              >
                Personal to you · applies to every workspace on this device
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="shrink-0 cursor-pointer rounded-sm p-1 text-fg-muted transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Close preferences"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </header>

          <Tabs
            value={tab}
            onValueChange={setTab}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <TabsList className={`${TAB_LIST_CLASS} shrink-0 border-border px-5`}>
              {TABS.map(({ id, label, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  size="sm"
                  className={TAB_ACCENT_CLASS}
                  data-preferences-tab={id}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {/* The type scale is on the span, not the trigger: Radix Themes' reset
                      sets `font-size` on `button` from an unlayered rule, which outranks
                      Tailwind's utility layer — so a size class on the button is ignored,
                      and four full-size tabs wrap onto a second row at 520 px. */}
                  <span className="text-xs">{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            {/* One scroll container for every tab, so a long panel scrolls and the header
                and footer stay put. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              <TabsContent value="appearance">
                <AppearanceTab
                  themes={availableThemes}
                  themeChoice={currentTheme.id}
                  // Only while the OS is in charge: otherwise `resolvedTheme` is the
                  // theme the user picked, which the `system` card must not claim.
                  systemResolvedName={isSystemTheme ? resolvedTheme.name : undefined}
                  onSelectTheme={setTheme}
                  preferences={preferences}
                  onSetPreference={setPreference}
                />
              </TabsContent>
              <TabsContent value="account">
                <AccountTab onNavigate={() => onOpenChange(false)} />
              </TabsContent>
              <TabsContent value="notifications">
                <NotificationsTab />
              </TabsContent>
              <TabsContent value="shortcuts">
                <ShortcutsTab />
              </TabsContent>
            </div>
          </Tabs>

          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
            <span className="text-xs text-fg-subtle">Saved automatically</span>
            <Dialog.Close className="cursor-pointer rounded-md bg-ink px-3 py-1.5 font-medium text-ink-fg transition-colors hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
              <span className="text-sm">Done</span>
            </Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
