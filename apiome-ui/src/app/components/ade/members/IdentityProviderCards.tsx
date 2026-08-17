'use client';

import * as React from 'react';
import { KeyRound, KeySquare, RefreshCw, Settings2 } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';

/**
 * Identity provider — the two "coming soon" cards (HIVE-5.2, #5305).
 *
 * Authority: `docs/mockups/workspace/members.html`, the *Identity provider* section, whose
 * Keeps list asks for the same copy, the same "Coming soon" pills and the same disabled
 * buttons. Nothing here is wired to anything, and that is the point: they describe features
 * the product does not have, and a card that pretends otherwise is worse than no card.
 *
 * The one deviation from the mockup is measured rather than aesthetic. It draws these at
 * 72 % opacity; a fade dims the words along with the mark, and `--fg-muted` behind
 * `opacity: .72` measures under the 4.5:1 WCAG AA asks of normal text on paper — the same
 * finding HIVE-4.8 made for its own coming-soon cards and HIVE-5.1 for an off toolset. The
 * badge and the disabled control are what say "not yet", and they say it without dimming
 * anything.
 */

/** One card's content. Listed rather than written twice, since the two differ only in text. */
interface IdentityProviderEntry {
  /** Stable key, and the `data-testid` suffix. */
  id: string;
  /** The glyph in the leading tile. */
  icon: React.ReactNode;
  /** The tone of that tile, from the shared vocabulary. */
  tone: 'honey' | 'accent';
  /** The card's heading. */
  title: string;
  /** What the feature would do. */
  description: string;
  /** The disabled call to action. */
  action: React.ReactNode;
}

/** The two cards, in the mockup's order. */
const ENTRIES: readonly IdentityProviderEntry[] = [
  {
    id: 'sso',
    icon: <KeySquare aria-hidden />,
    tone: 'honey',
    title: 'Single Sign-On (OIDC/SAML)',
    description:
      'Enforce sign-in through your identity provider and map IdP groups to Apiome roles.',
    action: (
      <>
        <Settings2 aria-hidden />
        Configure SSO
      </>
    ),
  },
  {
    id: 'scim',
    icon: <KeyRound aria-hidden />,
    tone: 'accent',
    title: 'SCIM 2.0 provisioning',
    description:
      'Automatically create, update, and deactivate members from your identity provider.',
    action: (
      <>
        <RefreshCw aria-hidden />
        Enable SCIM
      </>
    ),
  },
];

/**
 * The identity-provider section.
 *
 * @returns Its heading and the two placeholder cards.
 */
export default function IdentityProviderCards() {
  return (
    <section data-testid="members-idp">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-fg">Identity provider</h2>
        <p className="text-sm text-fg-muted">Enterprise identity features — coming soon</p>
      </div>

      <div className="mbr-idp-grid">
        {ENTRIES.map((entry) => (
          <article key={entry.id} className="mbr-idp-card" data-testid={`members-idp-${entry.id}`}>
            <div className="flex items-start gap-3">
              <span className="tnt-icon-tile" data-tone={entry.tone}>
                {entry.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-fg">{entry.title}</h3>
                  <Badge variant="honey">Coming soon</Badge>
                </div>
              </div>
            </div>

            <p className="mbr-idp-card__desc">{entry.description}</p>

            <div className="flex justify-end">
              <Button variant="outline" disabled aria-disabled="true">
                {entry.action}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
