'use client';

/**
 * Home's Quick actions panel (HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/home/overview.html` §"Quick actions", whose Notes require "routes
 * that already exist".
 *
 * Every row is a link to a route the app ships, and the three that open a form use
 * `openActions.ts` — the same `?open=` seam the ⌘K palette uses — so "Import a spec" here and
 * "Import a spec…" in the palette open one dialog with one set of validation. This panel owns
 * no form of its own; see {@link QUICK_ACTIONS}.
 *
 * The shortcut chips are decorative (`Kbd` renders them `aria-hidden`), so a chip beside a row
 * advertises the chord HIVE-3.7 binds without promising an assistive technology anything.
 */

import * as React from 'react';
import Link from 'next/link';

import { Card, CardHeader } from '@/app/components/ui/Card';
import { Kbd } from '@/app/components/ui/Kbd';
import { PANEL, quickActionsFor } from './homeModel';

/** Props for {@link QuickActions}. */
export interface QuickActionsProps {
  /**
   * Whether the session has a current workspace.
   *
   * A reader with none cannot import a spec into one, and an action that navigates only to be
   * told so is worse than an action that is not offered.
   */
  hasTenant: boolean;
}

/**
 * Draw the panel.
 *
 * @param props See {@link QuickActionsProps}.
 * @returns The card, or `null` when no action applies to this reader.
 */
export function QuickActions({ hasTenant }: QuickActionsProps) {
  const actions = quickActionsFor(hasTenant);
  if (actions.length === 0) return null;

  const Icon = PANEL.quickActions.icon;

  return (
    <Card className="home-panel" role="group" aria-labelledby="home-quick-actions-title">
      <CardHeader className="home-panel__header">
        <span className="home-panel__title">
          <Icon aria-hidden />
          <h2 id="home-quick-actions-title">{PANEL.quickActions.title}</h2>
        </span>
      </CardHeader>
      <ul className="home-menu">
        {actions.map((action) => {
          const ActionIcon = action.icon;
          return (
            <li key={action.id}>
              <Link href={action.href} className="home-menu__item" data-action={action.id}>
                <ActionIcon aria-hidden />
                <span className="home-menu__label">{action.label}</span>
                {action.kbd ? <Kbd>{action.kbd}</Kbd> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default QuickActions;
