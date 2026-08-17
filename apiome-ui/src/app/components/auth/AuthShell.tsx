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
  /** The card column: the auth card, and anything under it (the terms line). */
  children: React.ReactNode;
}

/**
 * The signed-out page frame.
 *
 * @param props Brand panel, its region label, and the card column — see {@link AuthShellProps}.
 * @returns The hex canvas wrapping a single `<main>` landmark.
 */
export function AuthShell({ brand, brandLabel = 'About Apiome', children }: AuthShellProps) {
  return (
    <div className="auth-shell hex-bg">
      <main className={brand ? 'auth-split' : 'auth-center'}>
        {brand && (
          <section className="auth-brand glow-honey glow-azure" aria-label={brandLabel}>
            <div className="auth-brand__inner">{brand}</div>
          </section>
        )}
        <section className="auth-form">
          <div className="auth-form__inner">{children}</div>
        </section>
      </main>
    </div>
  );
}

export default AuthShell;
