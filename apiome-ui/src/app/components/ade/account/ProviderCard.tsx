'use client';

/**
 * One "Add a provider" card (HIVE-4.8, #5302).
 *
 * Authority: `docs/mockups/account/linked-accounts.html` §"Add a provider" — a brand tile, the
 * provider's name with its badges ("Coming soon", "Linked", `🔑 PAT ••••••{suffix}`), a
 * one-liner, a Link button that is hidden once the provider is linked, and — for GitHub and
 * GitLab — the Personal Access Token row under a hairline.
 *
 * ### The brand hue belongs here
 *
 * `SignInMethodsCard` deliberately drops `getProviderBrand`'s colour classes, because in a quiet
 * list of methods the reader already has, a provider mark is a bullet. A card is the opposite
 * case: the provider is being *chosen*, and the hue is how it is recognised before its name is
 * read. So the mark keeps its brand colours, which is also why they are the one place this
 * ticket's DoD allows a literal hex — a brand is an identity, not a theme.
 *
 * ### Why a coming-soon card is dimmed rather than hidden
 *
 * A registry teaser is the answer to "can I use Okta?" before Okta exists, and the acceptance
 * criteria fix its look: disabled, at reduced opacity. `.lnk-provider--soon` puts that fade on
 * the brand *mark* and takes the card's elevation away, and leaves its words at full ink —
 * measured across the nine themes, no opacity keeps a muted line above WCAG AA, and the one card
 * whose whole content is an explanation must not be the one nobody can read. "Unavailable" is
 * still said three times: the faded mark, the "Coming soon" badge, and a disabled button.
 * `tests/linked-accounts-css.test.ts` holds the measurement.
 */

import * as React from 'react';
import { KeyRound, Pencil, Plus } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { getProviderBrand } from '@/app/components/auth/provider-brand';
import { cn } from '@lib/utils';
import { PAT_ADD_HINT, patMask, type ProviderCardModel } from './linkedAccountsModel';

/** Props for {@link ProviderCard}. */
export interface ProviderCardProps {
  /** The card to draw, as `buildProviderCards` composed it. */
  provider: ProviderCardModel;
  /** Whether a write is in flight, which disables every control on the card. */
  busy: boolean;
  /** Start the OAuth link round trip for this provider. */
  onLink: (providerId: string) => void;
  /** Open the Add/Update token dialog for this provider's linked identity. */
  onEditPat: (provider: ProviderCardModel) => void;
  /** Remove the stored token from this provider's linked identity. */
  onRemovePat: (provider: ProviderCardModel) => void;
}

/**
 * Draw the card.
 *
 * @param props See {@link ProviderCardProps}.
 * @returns The provider card.
 */
export function ProviderCard({
  provider,
  busy,
  onLink,
  onEditPat,
  onRemovePat,
}: ProviderCardProps) {
  const { Icon, iconClassName } = getProviderBrand(provider.id);
  const hasPat = provider.patSuffix !== null;

  // Every button on a card is labelled for what it does — "Link", "Update", "Remove" — and a
  // page holds several cards, so on their names alone a screen reader's button list would read
  // as three "Update"s. Each is *described by* the provider's name instead of renamed after it:
  // the visible label stays the accessible name (WCAG 2.5.3), and the row still says which
  // provider it belongs to.
  const nameId = `${React.useId()}-name`;

  return (
    <Card
      className={cn('lnk-provider', !provider.available && 'lnk-provider--soon')}
      data-testid={`provider-card-${provider.id}`}
    >
      <div className="lnk-provider__head">
        <span className="acct-glyph" aria-hidden>
          <Icon size={ICON_SIZE.dense} className={iconClassName} />
        </span>

        <div className="lnk-provider__body">
          <div className="lnk-provider__title">
            <span className="lnk-provider__name" id={nameId}>
              {provider.label}
            </span>
            {provider.comingSoon ? <Badge variant="neutral">Coming soon</Badge> : null}
            {provider.linked ? <Badge status="active">Linked</Badge> : null}
            {hasPat ? (
              <Badge variant="neutral" mono data-testid={`provider-pat-badge-${provider.id}`}>
                <KeyRound aria-hidden />
                PAT {patMask(provider.patSuffix as string)}
              </Badge>
            ) : null}
          </div>
          {provider.tagline ? <p className="lnk-provider__tagline">{provider.tagline}</p> : null}
        </div>

        {/* Hidden rather than disabled once linked: there is nothing left to do here, and a
            greyed "Link" beside a "Linked" badge reads as a failure. Unlinking is the table's. */}
        {provider.linked ? null : (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => onLink(provider.id)}
            disabled={busy || !provider.available}
            aria-describedby={nameId}
            data-testid={`provider-link-${provider.id}`}
          >
            <Plus aria-hidden />
            Link
          </Button>
        )}
      </div>

      {provider.showPatRow ? (
        <div className="lnk-pat" data-testid={`provider-pat-${provider.id}`}>
          <span className="lnk-pat__glyph" aria-hidden>
            <KeyRound />
          </span>
          <div className="lnk-pat__body">
            <p className="lnk-pat__label">Personal Access Token</p>
            <p className="lnk-pat__hint">
              {hasPat ? (
                <>
                  PAT set (ends in{' '}
                  <span className="lnk-pat__mask">{patMask(provider.patSuffix as string)}</span>).
                </>
              ) : (
                PAT_ADD_HINT
              )}
            </p>
          </div>
          <div className="lnk-pat__actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEditPat(provider)}
              disabled={busy}
              aria-describedby={nameId}
              data-testid={`provider-pat-edit-${provider.id}`}
            >
              {hasPat ? <Pencil aria-hidden /> : <Plus aria-hidden />}
              {hasPat ? 'Update' : 'Add'}
            </Button>
            {hasPat ? (
              <Button
                variant="ghost"
                size="sm"
                // Ghost's own `hover:text-fg` would repaint this on hover, so the danger ink
                // is restated for that state rather than left to lose a specificity tie.
                className="text-danger-fg hover:text-danger-fg"
                onClick={() => onRemovePat(provider)}
                disabled={busy}
                aria-describedby={nameId}
                data-testid={`provider-pat-remove-${provider.id}`}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default ProviderCard;
