'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight, ExternalLink } from 'lucide-react';

import { cardVariants } from '@/app/components/ui/Card';
import { badgeVariants } from '@/app/components/ui/Badge';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { cn } from '@lib/utils';

import { launcherItemLabel, OPENS_IN_NEW_TAB, type LauncherApp } from './launcherModel';

/**
 * One application tile on the `/ade` launcher (HIVE-4.5, #5299).
 *
 * Authority: `docs/mockups/home/launcher.html` (`.app-card`).
 *
 * The card is drawn as whatever it actually *is*, which is the whole a11y story here:
 *
 * | State | Element | Why |
 * | --- | --- | --- |
 * | internal | `next/link` | a real link: middle-click, open-in-new-tab, and a client push |
 * | external | `<a target="_blank" rel="noopener noreferrer">` | announces its own new tab |
 * | not shipped | `<button disabled>` | genuinely non-interactive, and `aria-label` is legal on it |
 *
 * The last row is why a disabled card is not a `<div aria-label>`: `aria-label` on an
 * element with no role is an axe `aria-prohibited-attr` violation (the trap HIVE-4.4 hit),
 * and the "(coming soon)" suffix has to reach a screen reader somehow — the 60 % opacity
 * and the chip that carry it visually do not.
 *
 * The card's hue comes from `data-tone`, resolved to tokens by the `.launch-tone` rules in
 * `globals.css`, so no colour is written here and a commercial host's card follows every
 * theme without knowing this app's palette.
 */

/** Props for {@link AppLaunchCard}. */
export interface AppLaunchCardProps {
  /** The tile to draw. */
  app: LauncherApp;
}

/**
 * The card's inner content, shared by all three elements it can be rendered as.
 *
 * Every child is a `<span>`: the disabled card is a `<button>`, whose content model is
 * phrasing content, so a `<div>` in here would be invalid markup on one of the three paths.
 *
 * @param app The tile to draw.
 * @returns The tile's glyph, copy and footer strip.
 */
function CardBody({ app }: AppLaunchCardProps) {
  const Icon = app.icon;

  return (
    <>
      {app.enabled ? (
        <span className="launch-card__go" aria-hidden="true">
          {app.external ? (
            <ArrowUpRight size={ICON_SIZE.button} strokeWidth={ICON_STROKE_WIDTH} />
          ) : (
            <ArrowRight size={ICON_SIZE.button} strokeWidth={ICON_STROKE_WIDTH} />
          )}
        </span>
      ) : (
        // `badgeVariants` rather than `<Badge>`: the chip has to be phrasing content, and
        // `Badge` renders a `<div>` — invalid inside the `<button>` a disabled card is.
        <span className={cn(badgeVariants({ variant: 'outline' }), 'launch-card__soon')}>
          Coming soon
        </span>
      )}

      <span className="launch-tile">
        <Icon aria-hidden strokeWidth={ICON_STROKE_WIDTH} />
      </span>

      <span className="launch-card__tag">{app.tagline}</span>
      <span className="launch-card__name">{app.name}</span>
      <span className="launch-card__desc">{app.description}</span>

      <span className="launch-card__foot">
        <span>{app.footerLabel}</span>
        {app.external && app.enabled ? (
          <span>
            <ExternalLink size={ICON_SIZE.button} strokeWidth={ICON_STROKE_WIDTH} aria-hidden />
            {OPENS_IN_NEW_TAB}
          </span>
        ) : null}
      </span>
    </>
  );
}

/**
 * An application tile.
 *
 * @param props The tile to draw — see {@link AppLaunchCardProps}.
 * @returns A link, an external link, or a disabled button, according to the tile's state.
 */
export default function AppLaunchCard({ app }: AppLaunchCardProps) {
  const className = cn(
    cardVariants({ hover: app.enabled, link: app.enabled }),
    'launch-tone launch-card',
    !app.enabled && 'launch-card--soon'
  );
  const shared = {
    className,
    'data-tone': app.tone,
    'data-testid': `launch-app-${app.id}`,
    'aria-label': launcherItemLabel(app.name, app.enabled),
  };

  if (!app.enabled) {
    return (
      <button type="button" disabled {...shared}>
        <CardBody app={app} />
      </button>
    );
  }

  if (app.external) {
    return (
      // `noopener` is what keeps the new tab from reaching back through `window.opener`;
      // `noreferrer` keeps the launcher's URL out of the destination's referrer.
      <a href={app.href} target="_blank" rel="noopener noreferrer" {...shared}>
        <CardBody app={app} />
      </a>
    );
  }

  return (
    <Link href={app.href} {...shared}>
      <CardBody app={app} />
    </Link>
  );
}
