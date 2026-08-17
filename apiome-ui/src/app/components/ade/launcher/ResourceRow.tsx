'use client';

import { ArrowRight, ArrowUpRight } from 'lucide-react';

import { badgeVariants } from '@/app/components/ui/Badge';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { cn } from '@lib/utils';

import { launcherItemLabel, type LauncherResource } from './launcherModel';

/**
 * One row in the launcher's Resources / On the roadmap panels (HIVE-4.5, #5299).
 *
 * Authority: `docs/mockups/home/launcher.html` (`.res-row`).
 *
 * Same rule as {@link AppLaunchCard}: a row is the element it behaves like. A destination
 * that exists is a link; one that does not is a `<button disabled>`, which is
 * non-interactive natively and which `aria-label` is legal on — a role-less `<div>` carrying
 * either `aria-label` or `aria-disabled` is an axe violation, not a shortcut.
 */

/** Props for {@link ResourceRow}. */
export interface ResourceRowProps {
  /** The row to draw. */
  item: LauncherResource;
}

/**
 * A resource row's glyph, copy and trailing affordance.
 *
 * Every child is a `<span>`, because the disabled row is a `<button>` and its content model
 * is phrasing content.
 *
 * @param item The row to draw.
 * @returns The row's contents.
 */
function RowBody({ item }: ResourceRowProps) {
  const Icon = item.icon;

  return (
    <>
      <span className="launch-tile launch-tile--sm">
        <Icon aria-hidden strokeWidth={ICON_STROKE_WIDTH} />
      </span>
      <span className="launch-res__body">
        <span className="launch-res__title">{item.name}</span>
        <span className="launch-res__sub">{item.description}</span>
      </span>
      {item.enabled ? (
        <span aria-hidden="true">
          {item.external ? (
            <ArrowUpRight size={ICON_SIZE.dense} strokeWidth={ICON_STROKE_WIDTH} />
          ) : (
            <ArrowRight size={ICON_SIZE.dense} strokeWidth={ICON_STROKE_WIDTH} />
          )}
        </span>
      ) : (
        <span className={cn(badgeVariants({ variant: 'outline' }))}>{item.comingSoonLabel}</span>
      )}
    </>
  );
}

/**
 * A resource row.
 *
 * @param props The row to draw — see {@link ResourceRowProps}.
 * @returns A link when the destination exists, a disabled button when it does not.
 */
export default function ResourceRow({ item }: ResourceRowProps) {
  const shared = {
    className: 'launch-tone launch-res',
    'data-tone': item.tone,
    'data-testid': `launch-resource-${item.id}`,
  };

  if (!item.enabled) {
    return (
      <button type="button" disabled aria-label={launcherItemLabel(item.name, false)} {...shared}>
        <RowBody item={item} />
      </button>
    );
  }

  return (
    <a
      href={item.href}
      {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...shared}
    >
      <RowBody item={item} />
    </a>
  );
}
