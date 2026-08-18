'use client';

/**
 * The one intake tab bar (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` §Source tab bar — an underline strip
 * listing every source the wizard offers, so switching intake never costs a trip back to the
 * card grid.
 *
 * It supersedes `ImportSourceTabBar`, which listed six hard-coded tabs with emoji glyphs and so
 * could not show Postman, MCP, *Design with AI* or any registry adapter — the four sources a
 * reader was most likely to be looking for. Tabs are derived from the same cards the grid draws
 * ({@link intakeTabsForCards}), and the glyphs are the cards' own Lucide icons, which is what
 * makes a tab and its card recognisable as the same thing.
 */

import * as React from 'react';
import { Bot, type LucideIcon } from 'lucide-react';

import { TAB_LIST_SCROLL_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { cn } from '@lib/utils';

import type { ImportSourceCard } from '../dashboard/importSourceCatalog';
import { IMPORT_WIZARD_COPY, intakeTabsForCards } from './importWizardModel';

export interface ImportIntakeTabsProps {
  /** The cards the grid drew, in the same order. */
  cards: ReadonlyArray<ImportSourceCard>;
  /** The `selectedSource` the wizard is on. */
  active: string | null;
  /** Called with the tab's panel id. */
  onSelect: (panel: string) => void;
  className?: string;
}

/**
 * The strip.
 *
 * It scrolls rather than wraps: eleven tabs at the Largest font scale would otherwise become
 * three rows and push the intake panel off the first screen. `TAB_LIST_SCROLL_CLASS` is the same
 * behaviour the editor's open-file tabs use.
 *
 * @param props See {@link ImportIntakeTabsProps}.
 * @returns The tablist.
 */
export function ImportIntakeTabs({ cards, active, onSelect, className }: ImportIntakeTabsProps) {
  const tabs = intakeTabsForCards(cards);
  const iconFor = new Map<string, LucideIcon>(cards.map((card) => [card.key, card.icon]));

  return (
    <div
      role="tablist"
      aria-label="Import source"
      className={cn(TAB_LIST_SCROLL_CLASS, className)}
    >
      {tabs.map((tab) => {
        const disabled = tab.panel === null;
        const selected = !disabled && active === tab.panel;
        const Icon = iconFor.get(tab.id) ?? Bot;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            title={disabled ? IMPORT_WIZARD_COPY.comingSoon : undefined}
            onClick={() => tab.panel && onSelect(tab.panel)}
            className={tabTriggerClass({ active: selected, disabled, size: 'sm' })}
          >
            <Icon className="size-[var(--icon-dense)]" aria-hidden />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export default ImportIntakeTabs;
