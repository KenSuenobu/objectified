'use client';

import * as React from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { cardVariants } from '@/app/components/ui/Card';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { cn } from '@lib/utils';
import { NO_TENANT_LABEL, SUPPORT_ISSUE_URL, supportDetails, type HelpCard } from './helpModel';

/**
 * The support card (HIVE-4.9, #5303).
 *
 * Authority: `docs/mockups/foundations/help.html` — *"Include your tenant id `ten_01HJ7…F8H`
 * and the build `v0.241.0`"*. The ticket's acceptance criterion is that the card **shows**
 * both, which is why they are printed rather than only copied: a reader quoting them into
 * someone else's ticket system needs to see what they are quoting.
 *
 * ### Why this card is not a link card
 *
 * The other five cards are one destination each, so each is one anchor. This one carries two
 * affordances — copy the details, open an issue — and a card that is itself a link cannot
 * contain either without nesting interactive content inside a link.
 *
 * ### The copy button
 *
 * One button for both identifiers, not one each: a support report needs the pair, and copying
 * them together is what stops half of it arriving. The confirmation swaps the glyph **and**
 * the accessible name (`Copy support details` → `Copied support details`), so it is never
 * colour-and-shape alone — the same treatment the profile page's id tiles use.
 */

/** Props for {@link HelpSupportCard}. */
export interface HelpSupportCardProps {
  /** The card's copy and glyph, from `HELP_CARDS`. */
  card: HelpCard;
  /** `current_tenant_id` from the session, when there is a workspace. */
  tenantId?: string | null;
  /** The build badge — `APP_VERSION_BADGE`. */
  buildLabel: string;
}

/** How long the copy confirmation stays up, in milliseconds. */
const COPIED_RESET_MS = 2000;

/**
 * The support card.
 *
 * @param props See {@link HelpSupportCardProps}.
 * @returns A card with the tenant id, the build, a copy button and a link to the tracker.
 */
export default function HelpSupportCard({ card, tenantId, buildLabel }: HelpSupportCardProps) {
  const Icon = card.icon;
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount matters here: the page is one click from the rail, and a timer that
  // fires into an unmounted tree is a React warning in every test that leaves early.
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(supportDetails(tenantId, buildLabel));
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // A denied clipboard is not an error the reader can act on — both values are on screen
      // and can be selected by hand, which is the fallback this card already provides.
    }
  }, [tenantId, buildLabel]);

  return (
    <div
      className={cn(cardVariants(), 'help-card help-card--static')}
      data-tone={card.tone}
      data-testid="help-card-support"
    >
      <span className="help-tile" aria-hidden>
        <Icon size={ICON_SIZE.rail} strokeWidth={ICON_STROKE_WIDTH} />
      </span>

      {/* A `<p>` and not an `<h3>`: the six cards are peers, the other five title themselves
          with a `<span>` inside their own link, and a lone `h3` under the page's `h1` with no
          `h2` between them is an axe `heading-order` violation rather than structure. */}
      <p className="help-card__title">{card.title}</p>
      <p className="help-card__desc">{card.description}</p>

      <dl className="help-support" data-testid="help-support-details">
        <div className="help-support__row">
          <dt className="help-support__label">Tenant id</dt>
          <dd className="help-support__value" data-testid="help-support-tenant">
            {tenantId || NO_TENANT_LABEL}
          </dd>
        </div>
        <div className="help-support__row">
          <dt className="help-support__label">Build</dt>
          <dd className="help-support__value" data-testid="help-support-build">
            {buildLabel}
          </dd>
        </div>
      </dl>

      <div className="help-card__actions">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          aria-label={copied ? 'Copied support details' : 'Copy support details'}
          data-testid="help-support-copy"
        >
          {copied ? <Check className="text-ok" aria-hidden /> : <Copy aria-hidden />}
          {copied ? 'Copied' : 'Copy details'}
        </Button>

        <a
          href={SUPPORT_ISSUE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="help-card__link"
          data-testid="help-support-issue"
        >
          Open an issue
          <ArrowUpRight size={ICON_SIZE.dense} strokeWidth={ICON_STROKE_WIDTH} aria-hidden />
        </a>
      </div>
    </div>
  );
}
