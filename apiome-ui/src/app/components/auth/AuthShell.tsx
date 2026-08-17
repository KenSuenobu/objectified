'use client';

import * as React from 'react';

/**
 * AuthShell — the frame every signed-out page is drawn in (HIVE-4.1, #5295).
 *
 * Authority: `docs/mockups/auth/login.html`, whose own comment calls the split layout
 * "shared verbatim by the four auth mockups", and `docs/mockups/DESIGN.md` §2 (the hexagon
 * is "the faint canvas pattern on auth/launcher pages").
 *
 * These pages have no rail, no page header and no tenant — the reader is not in the product
 * yet — so the only chrome they get is the brand: a hex canvas, a honey glow and one card
 * carrying the whole decision. Two shapes, decided by whether a `brand` panel is given:
 *
 * | `brand` | Layout | Used by |
 * | --- | --- | --- |
 * | given | split — brand panel beside the card | `/login` |
 * | omitted | the card centred on the canvas | the 2FA / OAuth sign-up screens |
 *
 * Below 1000 px (the mockup's breakpoint) the brand panel is hidden by CSS and the card
 * shows the bee itself — see `.auth-card__logo` in `globals.css`, which is turned on in the
 * same media block that turns the panel off, so no width shows two marks or none.
 *
 * The first-tenant onboarding wizard (HIVE-4.4) draws the same shell from the *inside* of
 * the product — the reader is signed in, just not a member of anything yet — so it adds the
 * two slots that case needs: a `topbar` naming who is signed in, and `wide` for a card that
 * carries a progress row rather than a single decision. Both are opt-in; the three
 * signed-out pages pass neither.
 *
 * Everything visual lives in the "AUTH SURFACES" section of `globals.css`: this component
 * only decides the landmarks.
 */
export interface AuthShellProps {
  /**
   * The brand panel's content — rendered inside the left column at ≥1000 px, and dropped
   * entirely below it. Omit for a centred single-column page.
   */
  brand?: React.ReactNode;
  /** Accessible name for the brand panel's region. */
  brandLabel?: string;
  /**
   * A row above the page's `<main>` — the brand, who is signed in, and the way out.
   *
   * Only the onboarding wizard has one, and only because it is drawn *instead of* the
   * app: without it the page reads as a sign-in screen the reader cannot get past. Its
   * presence is also what tells the shell to share the viewport between the two rows
   * rather than letting the centred column claim all of it (`globals.css`,
   * `.auth-shell:has(> .auth-topbar)`).
   */
  topbar?: React.ReactNode;
  /**
   * Widen the card column from the sign-in card's 27.5 rem to the wizard's 35 rem — for
   * a card carrying a progress row and a two-column review rather than one decision.
   */
  wide?: boolean;
  /** The card column: the auth card, and anything under it (the terms line). */
  children: React.ReactNode;
}

/**
 * The signed-out page frame.
 *
 * @param props Brand panel, its region label, the optional top row and card width, and the
 *   card column — see {@link AuthShellProps}.
 * @returns The hex canvas wrapping an optional `<header>` and a single `<main>` landmark.
 */
export function AuthShell({
  brand,
  brandLabel = 'About Apiome',
  topbar,
  wide = false,
  children,
}: AuthShellProps) {
  return (
    <div className="auth-shell hex-bg">
      {topbar && <header className="auth-topbar">{topbar}</header>}
      <main className={brand ? 'auth-split' : 'auth-center'}>
        {brand && (
          <section className="auth-brand glow-honey glow-azure" aria-label={brandLabel}>
            <div className="auth-brand__inner">{brand}</div>
          </section>
        )}
        <section className="auth-form">
          <div className={wide ? 'auth-form__inner auth-form__inner--wide' : 'auth-form__inner'}>
            {children}
          </div>
        </section>
      </main>
    </div>
  );
}

export default AuthShell;
