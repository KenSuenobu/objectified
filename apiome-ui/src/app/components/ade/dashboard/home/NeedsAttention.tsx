'use client';

/**
 * Home's "Needs attention" panel (HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/home/overview.html` §"Health / attention", whose Notes fix the three
 * feeds as "sunset timeline, lint gate failures and key expiry".
 *
 * The rows arrive already ranked and capped from `lib/db/dashboard-home.ts`; this file draws
 * them. Two rules it holds to:
 *
 * - **Hidden when empty.** The ticket asks for it, and it is the right behaviour: a panel
 *   headed "Needs attention" showing "Nothing needs attention" is a row of furniture that reads
 *   as a problem for the half-second before it is read properly. A workspace in good order
 *   simply has one fewer panel, and the column above it takes the space.
 * - **Colour is never the only signal.** The leading dot carries the tone, but the row's own
 *   text says what happened and by when — `deadlinePhrase` puts "in 3 days" or "2 days ago"
 *   into the title — so the urgency survives greyscale and a screen reader alike.
 */

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardHeader } from '@/app/components/ui/Card';
import { Skeleton } from '@/app/components/ui/Skeleton';
import type { AttentionItem } from '@lib/db/dashboard-home-model';
import { ATTENTION_ICON, PANEL } from './homeModel';

/** How many skeleton rows the loading panel draws. */
const SKELETON_ROWS = 3;

/** Props for {@link NeedsAttention}. */
export interface NeedsAttentionProps {
  /** The ranked rows. An empty list hides the panel entirely. */
  items: readonly AttentionItem[];
  /** True until the first load resolves. */
  loading: boolean;
}

/**
 * Draw the panel.
 *
 * @param props See {@link NeedsAttentionProps}.
 * @returns The card, its skeleton, or `null` when there is nothing to attend to.
 */
export function NeedsAttention({ items, loading }: NeedsAttentionProps) {
  if (loading) {
    return (
      <Card className="home-panel" aria-hidden>
        <CardHeader className="home-panel__header">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <div className="home-rows">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div className="home-row" key={index}>
              <Skeleton className="size-2 rounded-full" />
              <div className="home-row__body">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-2.5 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (items.length === 0) return null;

  const Icon = PANEL.attention.icon;

  return (
    <Card className="home-panel" role="group" aria-labelledby="home-attention-title">
      <CardHeader className="home-panel__header">
        <span className="home-panel__title">
          <Icon aria-hidden />
          <h2 id="home-attention-title">{PANEL.attention.title}</h2>
          <Badge variant="warn" className="home-panel__count">
            {items.length}
          </Badge>
        </span>
      </CardHeader>
      <ul className="home-rows">
        {items.map((item) => {
          const KindIcon = ATTENTION_ICON[item.kind];
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                className="home-row home-row--link home-tone"
                data-tone={item.tone}
                data-attention={item.kind}
              >
                <span className="home-dot" aria-hidden />
                <span className="home-row__body">
                  <span className="home-row__title">{item.title}</span>
                  <span className="home-row__sub">{item.detail}</span>
                </span>
                <KindIcon className="home-row__kind" aria-hidden />
                <ChevronRight className="home-row__go" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default NeedsAttention;
