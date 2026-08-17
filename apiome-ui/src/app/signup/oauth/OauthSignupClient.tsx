'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, BadgeCheck, Building2, Link2, User } from 'lucide-react';
import { signIn } from '@lib/auth/session-client';
import { BROWSE_APP_URL } from '@lib/app-urls';
import {
  checkOauthSignupSlugAvailability,
  completeOAuthSignup,
} from '@lib/auth/oauth-signup-actions';
import { getProviderDescriptor } from '@lib/auth/provider-registry';
import { generateTenantSlug, validateTenantSlug } from '@lib/auth/tenant-slug';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { BrandMark } from '../../components/brand';
import { AuthShell } from '../../components/auth/AuthShell';
import { AuthField } from '../../components/auth/AuthField';
import { BetaBadge } from '../../components/auth/BetaBadge';
import { SlugField } from '../../components/auth/SlugField';
import { useSlugAvailability } from '../../components/auth/useSlugAvailability';
import { getProviderBrand } from '../../components/auth/provider-brand';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';

/** Shown when the reader submits a slug the probe has just found to be taken. */
const SLUG_TAKEN_ERROR = 'This slug is already taken — please choose another';

/** Shown when `completeOAuthSignup` throws rather than answering. */
const GENERIC_ERROR = 'Something went wrong. Please try again.';

/**
 * The host the organization's APIs will be browsable at, without its scheme — the
 * preview under the slug reads as a URL, and a URL is easier to judge than a word
 * in a box. Derived from the same `BROWSE_APP_URL` every other link to that app
 * uses, so a self-hosted deployment previews its own host rather than apiome's.
 */
const BROWSE_HOST = `${BROWSE_APP_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/`;

/** An illustrative project under the slug, so the preview reads as a whole path. */
const PREVIEW_PROJECT = 'payments-api';

interface OauthSignupClientProps {
  /** The `oauth_signup_pending` id from the sign-up link; the page proved it exists. */
  token: string;
  /** The provider's email for this account, already masked by the page. */
  emailHint: string;
  /** The provider id the reader arrived from (`github`, `google`, …), if known. */
  provider?: string;
}

/**
 * The OAuth self-signup completion card (OLO-2.x, re-skinned by HIVE-4.3 #5297).
 *
 * Authority: `docs/mockups/auth/signup-oauth.html`, `docs/mockups/DESIGN.md` §2 and §7.
 *
 * The flow is unchanged. The page is still token-gated — a missing or expired token
 * never renders this card, it redirects to `/login?error=SignupSessionExpired` — the
 * three fields are the same three, the slug still follows the organization name until
 * it is hand-edited, and submitting still runs `completeOAuthSignup` → a one-time-code
 * credentials sign-in → `/ade`. The Free-plan sentence is word for word what it was.
 *
 * What changed is the skin and one affordance. The gradient glass card of named
 * indigo/purple/slate is gone, so this screen follows the reader's theme, density and
 * font-scale preference like the rest of the app; the frame is the shared
 * `components/auth/AuthShell` in its centred shape, the same one `/login/2fa` uses.
 * The affordance is the live availability chip on the slug — the mockup's one addition
 * — which is `components/auth/SlugField`, built here and reused by the onboarding
 * wizard (HIVE-4.4). It is advisory in both directions: a slug it cannot verify still
 * submits, because `completeOAuthSignup` re-checks uniqueness server-side either way.
 *
 * @param props The pending-signup token, the masked email and the provider id — see
 *   {@link OauthSignupClientProps}.
 * @returns The completion card.
 */
export default function OauthSignupClient({ token, emailHint, provider }: OauthSignupClientProps) {
  const [displayName, setDisplayName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);

  // The probe is gated on the same token that gated the page: the reader has no
  // account yet, so there is no session for the wizard's probe to identify them by.
  const probe = useCallback(
    (candidate: string) => checkOauthSignupSlugAvailability(token, candidate),
    [token]
  );
  const { availability, resolve } = useSlugAvailability(slug, probe);

  /** The shape error for what is in the field right now, shown as the reader types. */
  const liveSlugError = slug.trim() ? validateTenantSlug(slug.trim()) : null;

  const providerLabel = provider ? getProviderDescriptor(provider)?.label ?? provider : null;
  const ProviderIcon = provider ? getProviderBrand(provider).Icon : null;

  /**
   * Update the organization name and, until the slug is hand-edited, its suggestion.
   *
   * @param value The new organization name.
   */
  const onOrgChange = (value: string) => {
    setOrgName(value);
    if (!slugTouched) {
      setSlug(generateTenantSlug(value));
    }
  };

  /**
   * Update the slug. A cleared field re-enables the name-derived suggestion, which is
   * how the reader gets back to the default after trying something of their own.
   *
   * @param value The new slug (already lowercased by the field).
   */
  const onSlugChange = (value: string) => {
    setSlug(value);
    setSlugTouched(value.trim() !== '');
    setSlugError(null);
  };

  /**
   * Create the account: settle the slug's availability, provision, then sign in.
   *
   * A slug the probe reports as `taken` stops here with the field marked, because the
   * server would only reject it a moment later. Anything else — including a verdict
   * that could not be reached — goes through, and `completeOAuthSignup` has the last
   * word on uniqueness.
   *
   * @param e The form's submit event.
   */
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSlugError(null);

    // Every field is `required`, so the browser has already refused an empty one; the
    // shape check below is what catches a slug that is present but could never be one.
    const candidate = slug.trim().toLowerCase();
    const shapeError = validateTenantSlug(candidate);
    if (shapeError) {
      setSlugError(shapeError);
      return;
    }

    setBusy(true);
    try {
      if ((await resolve(candidate)) === 'taken') {
        setSlugError(SLUG_TAKEN_ERROR);
        setBusy(false);
        return;
      }

      const result = await completeOAuthSignup(token, displayName, orgName, candidate);
      if (!result.success) {
        setError(result.error);
        setBusy(false);
        return;
      }
      await signIn('credentials', {
        payload: JSON.stringify({ oneTimeCode: result.oneTimeCode }),
        callbackUrl: '/ade',
        redirect: true,
      });
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      {/* The mark sits above the card: this page has no brand panel, so it is the only
          thing naming the product the reader is about to have an account with. */}
      <div className="auth-brandbar">
        <BrandMark variant="lockup" size={36} className="auth-brand__lockup" priority />
        <BetaBadge />
      </div>

      <Card className="auth-card" data-testid="oauth-signup-card">
        <span className="auth-icon" aria-hidden="true">
          <Link2 />
        </span>
        <h1 className="auth-title mt-4">Finish setting up your account</h1>
        {/* A `div`, not a `p`: the unlayered `p { color: … }` at the foot of `globals.css`
            outranks every `@layer utilities` colour, so the masked email would lose its ink. */}
        <div className="auth-sub mt-1" data-testid="oauth-signup-identity">
          Signed in as <span className="mono font-medium text-fg">{emailHint}</span>
          {providerLabel && ProviderIcon && (
            <>
              {' via '}
              <span className="inline-flex items-center gap-1 align-[-0.1em]">
                {/* The glyph is hidden from assistive technology: some `react-icons` brand
                    marks set `role="img"` with no title, which axe reports as serious — and
                    the provider's name is right beside it either way. */}
                <span aria-hidden="true" className="inline-flex">
                  <ProviderIcon size={ICON_SIZE.button} />
                </span>
                {providerLabel}
              </span>
            </>
          )}
        </div>

        <Alert
          variant="ok"
          role="note"
          icon={<BadgeCheck className="mt-px size-4 shrink-0" aria-hidden="true" />}
          className="mt-5"
          data-testid="oauth-signup-plan"
        >
          <span className="font-semibold">Free plan</span> — Includes 1 organization, 1 project,
          and up to 3 versions. You can upgrade anytime.
        </Alert>

        {/* `role="alert"`, so a rejected sign-up interrupts rather than waiting to be found. */}
        {error && (
          <Alert variant="danger" role="alert" className="mt-4" data-testid="oauth-signup-error">
            {error}
          </Alert>
        )}

        <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-4">
          <AuthField
            id="displayName"
            label="Your name"
            icon={<User size={ICON_SIZE.dense} aria-hidden="true" />}
            name="displayName"
            autoComplete="name"
            placeholder="Jane Doe"
            required
            disabled={busy}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            data-testid="oauth-signup-name"
          />

          <AuthField
            id="orgName"
            label="Organization name"
            icon={<Building2 size={ICON_SIZE.dense} aria-hidden="true" />}
            name="orgName"
            autoComplete="organization"
            placeholder="Acme Design"
            required
            disabled={busy}
            value={orgName}
            onChange={(event) => onOrgChange(event.target.value)}
            data-testid="oauth-signup-org"
          />

          <SlugField
            id="slug"
            name="slug"
            value={slug}
            onChange={onSlugChange}
            availability={availability}
            error={slugError ?? liveSlugError ?? undefined}
            placeholder="acme-design"
            previewBase={BROWSE_HOST}
            previewSuffix={PREVIEW_PROJECT}
            required
            disabled={busy}
            data-testid="oauth-signup-slug"
          />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="mt-1 w-full"
            disabled={busy}
            data-testid="oauth-signup-submit"
          >
            {busy && <Spinner size="sm" tone="light" aria-hidden="true" />}
            {busy ? 'Creating your workspace…' : 'Create account'}
            {!busy && <ArrowRight aria-hidden="true" />}
          </Button>
        </form>

        <div className="auth-sub mt-6 text-center">
          <Link href="/login" className="auth-link inline-flex items-center gap-1.5 font-medium">
            <ArrowLeft className="size-[var(--icon-button)]" aria-hidden="true" />
            Back to sign in
          </Link>
        </div>
      </Card>

      <p className="auth-terms mt-4">
        The slug follows the organization name until you edit it. This link expires after a short
        while — if it does, you’ll be sent back to sign in.
      </p>
    </AuthShell>
  );
}
