"use client";

import { useState } from 'react';
import { Mail, Lock, User, Info, ShieldCheck, Zap, CreditCard, ArrowRight, RotateCcw } from 'lucide-react';
import { signIn } from '@lib/auth/session-client';
import { createSignupRequest } from '../../../lib/db/helper';
import { BrandMark } from '../components/brand';
import type { ProviderSummary } from '../../../lib/auth/provider-registry';
import { getProviderBrand } from '../components/auth/provider-brand';
import { AuthShell } from '../components/auth/AuthShell';
import { AuthField } from '../components/auth/AuthField';
import { BetaBadge } from '../components/auth/BetaBadge';
import LoginBrandPanel from './LoginBrandPanel';
import { getAuthErrorCopy } from './auth-error-copy';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';

/**
 * The sign-in / create-account page (HIVE-4.1, #5295 — re-skin of OLO-3.1's layout).
 *
 * Authority: `docs/mockups/auth/login.html`, `docs/mockups/DESIGN.md` §2 and §7.
 *
 * The information architecture is unchanged from the page this replaces — SSO first,
 * credentials collapsed beneath an "or use your email" expander, one banner carrying the
 * 17 mapped auth error codes, a mode toggle at the foot. What changed is everything that
 * named a colour: the animated aurora blobs, the film grain and the glass card
 * (`login.module.css`) are gone, and the page is drawn from the Hive token layer instead —
 * so the front door now follows the reader's theme, density and font-scale like the rest of
 * the app, and carries the bee.
 *
 * The frame (hex canvas, brand panel, card column) is `components/auth/AuthShell`, shared
 * with the other signed-out screens.
 */

/** The three promises under the sign-in form. Icons are decorative; the words carry them. */
const TRUST_BADGES = [
  { icon: ShieldCheck, label: 'Secure' },
  { icon: Zap, label: 'Free to start' },
  { icon: CreditCard, label: 'No credit card' },
] as const;

/**
 * The field-level message shown under the password box after a rejected credentials attempt
 * (mockup § Adds). The banner says what happened; this says *where*.
 */
const CREDENTIALS_FIELD_ERROR = 'Incorrect email or password.';

interface SSOButtonProps {
  /** The provider's display label, e.g. `GitHub`. */
  provider: string;
  /** The provider's brand mark. */
  icon: React.ReactNode;
  /** Start this provider's redirect. */
  onClick: () => void;
  /** Label the button for account creation rather than sign-in. */
  isSignUp?: boolean;
}

/**
 * One provider row: brand mark, label, and an arrow that surfaces under the pointer.
 *
 * @param props Provider label, icon, click handler and mode — see {@link SSOButtonProps}.
 * @returns The full-width outline button for that provider.
 */
const SSOButton: React.FC<SSOButtonProps> = ({ provider, icon, onClick, isSignUp }) => {
  const label = isSignUp ? `Sign up with ${provider}` : `Continue with ${provider}`;
  return (
    <Button type="button" variant="outline" size="lg" className="auth-sso" onClick={onClick}>
      {/* Decorative brand mark — the button's text label carries the accessible name, so the
          icon is hidden from assistive tech (some react-icons set role="img" without a title,
          which axe reports as a serious violation). */}
      <span aria-hidden="true" className="auth-sso__mark">
        {icon}
      </span>
      <span className="font-semibold">{label}</span>
      <ArrowRight className="auth-sso__arrow" aria-hidden="true" />
    </Button>
  );
};

interface LoginClientProps {
  error?: string;
  /** Validated by the login page (resolveCallbackUrl) before being passed in. */
  callbackUrl?: string;
  /**
   * The deployment's enabled SSO providers (provider registry, OLO-2.3), resolved server-side
   * by the login page. Exactly one button renders per entry; an empty list hides the SSO block.
   * When any provider is listed, SSO is the primary path and the credentials form starts
   * collapsed beneath the "or" divider (OLO-3.1); with an empty list the form is the only path
   * and renders expanded.
   */
  ssoProviders?: ProviderSummary[];
}

const LoginClient: React.FC<LoginClientProps> = ({ error, callbackUrl = '/ade', ssoProviders = [] }) => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [payload, setPayload] = useState<Record<string, string>>({
    email: '',
    password: '',
  });
  const [signInEnabled, setSignInEnabled] = useState(true);
  const [signupMessage, setSignupMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isSSOLoading, setIsSSOLoading] = useState(false);
  // SSO is the primary path (OLO-3.1): the credentials form starts collapsed beneath the "or"
  // divider whenever SSO buttons render. It starts expanded when credentials are the only path
  // (no enabled providers) or when the user just failed a credentials attempt and needs the
  // form back to retry. Expansion is one-way — the form never re-collapses.
  const [showCredentials, setShowCredentials] = useState(
    ssoProviders.length === 0 || error === 'CredentialsSignin'
  );
  // The rejected pair is marked on the fields themselves until the user edits either one —
  // an error the reader has already started fixing should stop shouting.
  const [credentialsRejected, setCredentialsRejected] = useState(error === 'CredentialsSignin');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignInEnabled(false);
    setSignupMessage(null);

    if (isSignUp) {
      try {
        const result = await createSignupRequest(
          payload.name || '',
          payload.email || '',
          payload.password || '',
          payload.signupSource || ''
        );

        const response = JSON.parse(result);

        if (response.success) {
          setSignupMessage({type: 'success', text: response.message});
          // Clear the form
          setPayload({
            email: '',
            password: '',
            name: '',
            signupSource: '',
          });
        } else if (response.duplicate) {
          setSignupMessage({type: 'info', text: response.message});
        } else {
          setSignupMessage({type: 'error', text: response.error || 'An error occurred during signup.'});
        }
      } catch (error) {
        console.error('Signup error:', error);
        setSignupMessage({type: 'error', text: 'An unexpected error occurred. Please try again.'});
      } finally {
        setSignInEnabled(true);
      }
    } else {
      signIn('credentials', {
        payload: JSON.stringify(payload),
        callbackUrl,
        redirect: true,
      }).finally(() => setSignInEnabled(true));
    }
  };

  const handleSSOLogin = async (provider: string) => {
    setIsSSOLoading(true);
    try {
      if (isSignUp) {
        const res = await fetch(`/api/auth/signup-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        if (!res.ok) {
          setSignupMessage({ type: 'error', text: 'Could not start sign-up. Please try again.' });
          setIsSSOLoading(false);
          return;
        }
      }
      await signIn(provider, { callbackUrl });
    } catch (error) {
      console.error('SSO sign-in error:', error);
      setIsSSOLoading(false);
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.name === 'email' || e.target.name === 'password') {
      setCredentialsRejected(false);
    }
    setPayload({
      ...payload,
      [e.target.name]: e.target.value,
    });
  }

  // Distinct guidance per structured auth error code (OLO-1.5) from the NextAuth error redirect,
  // rendered with per-code affordances (OLO-3.2). Unknown codes resolve to the safe generic
  // banner inside getAuthErrorCopy; in-page signup feedback always outranks the redirect error.
  const authErrorCopy = getAuthErrorCopy(error);
  const message = signupMessage || authErrorCopy;
  // "Try again" returns to a clean login page: the error param is dropped so the banner clears,
  // while the (already-validated) callbackUrl survives the round trip.
  const showRetry = !signupMessage && Boolean(authErrorCopy?.retry);
  const retryHref = `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
  // The banner's tone, and how insistently it is announced. An error interrupts a screen
  // reader (role="alert"); success and info wait their turn (role="status") — OLO-3.5.
  const isErrorMessage = message?.type === 'error';
  const bannerTone = message?.type === 'success' ? 'ok' : message?.type === 'info' ? 'info' : 'danger';
  // Both boxes redden — the pair was rejected, not one of them — but the sentence is
  // printed once, under the password, exactly as the mockup's error variant has it.
  const fieldError = !isSignUp && credentialsRejected ? CREDENTIALS_FIELD_ERROR : undefined;

  return (
    <AuthShell brand={<LoginBrandPanel />}>
      <Card data-testid="login-card" className="auth-card">
        {/* The bee and the beta chip, for the widths where the brand panel is hidden. CSS
            owns the swap, so exactly one copy of each is on screen at any width. */}
        <div className="auth-card__logo">
          <BrandMark variant="glyph" size={44} />
          <BetaBadge />
        </div>

        <h1 className="auth-title">{isSignUp ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-sub mt-1">
          {isSignUp
            ? 'Join thousands of developers building with Apiome'
            : 'Sign in to continue to your workspace'}
        </p>
        {!isSignUp && (
          <p className="mt-2 text-xs text-fg-muted">
            New to Apiome?{' '}
            <a
              href="https://youtu.be/GQBgza8eYoQ"
              target="_blank"
              rel="noopener noreferrer"
              className="auth-link font-medium"
            >
              Watch our intro video →
            </a>
          </p>
        )}

        {/* Message Display — per-code copy and affordances (OLO-3.2).
            Errors announce assertively via role="alert" so a screen reader interrupts
            with the failure; success/info updates stay polite (OLO-3.5, a11y). */}
        {message && (
          <Alert
            variant={bannerTone}
            role={isErrorMessage ? 'alert' : 'status'}
            aria-live={isErrorMessage ? 'assertive' : 'polite'}
            data-testid="login-banner"
            className="mt-4"
            actions={
              showRetry ? (
                <Button asChild variant="outline" size="sm" pill>
                  <a href={retryHref}>
                    <RotateCcw aria-hidden="true" />
                    Try again
                  </a>
                </Button>
              ) : undefined
            }
          >
            {message.text}
          </Alert>
        )}

        {/* SSO first — the primary path. One button per enabled provider (registry, OLO-2.3). */}
        {ssoProviders.length > 0 && (
          isSSOLoading ? (
            <Card variant="soft" className="auth-wait mt-5" role="status" aria-live="polite">
              {/* The tile is the live region; the spinner inside it is ornament, so it is
                  hidden rather than announcing a second time. */}
              <Spinner size="md" aria-hidden="true" />
              <div className="text-sm font-semibold text-fg">Connecting…</div>
              <div className="text-xs text-fg-muted">Redirecting to authentication provider</div>
            </Card>
          ) : (
            <div className="mt-5 flex flex-col gap-2">
              {ssoProviders.map((provider) => {
                const { Icon, iconClassName } = getProviderBrand(provider.id);
                return (
                  <SSOButton
                    key={provider.id}
                    provider={provider.label}
                    icon={<Icon size={ICON_SIZE.rail} className={iconClassName} />}
                    onClick={() => handleSSOLogin(provider.id)}
                    isSignUp={isSignUp}
                  />
                );
              })}
            </div>
          )
        )}

        {/* Divider (only when SSO renders above the email form). While the credentials
            form is collapsed it doubles as the expand control. */}
        {ssoProviders.length > 0 && (
          showCredentials ? (
            <div className="auth-divider mt-5">or use your email</div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCredentials(true)}
              disabled={isSSOLoading}
              aria-expanded={false}
              aria-controls="credentials-form"
              className="auth-divider mt-5"
            >
              or use your email
            </button>
          )
        )}

        {/* Credentials form — collapsed (hidden) until requested when SSO is available
            (OLO-3.1). Tailwind preflight gives [hidden] display:none, and hidden fields
            are neither focusable nor submittable, so the collapsed form is fully inert. */}
        <form
          id="credentials-form"
          hidden={!showCredentials}
          onSubmit={handleSubmit}
          className="mt-4 space-y-4"
        >
          {isSignUp && (
            <AuthField
              id="name"
              label="Full Name"
              icon={<User size={ICON_SIZE.dense} aria-hidden="true" />}
              type="text"
              name="name"
              value={payload['name'] || ''}
              onChange={handleChange}
              required
              autoComplete="name"
              placeholder="John Doe"
            />
          )}

          <AuthField
            id="email"
            label="Email Address"
            icon={<Mail size={ICON_SIZE.dense} aria-hidden="true" />}
            type="email"
            name="email"
            value={payload['email']}
            onChange={handleChange}
            required
            autoComplete="email"
            placeholder="you@example.com"
            invalid={Boolean(fieldError)}
          />

          <AuthField
            id="password"
            label="Password"
            icon={<Lock size={ICON_SIZE.dense} aria-hidden="true" />}
            aside={
              !isSignUp ? (
                <a href="#" className="auth-link text-xs font-medium">
                  Forgot your password?
                </a>
              ) : undefined
            }
            type="password"
            name="password"
            value={payload['password']}
            onChange={handleChange}
            required
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            placeholder="••••••••"
            error={fieldError}
          />

          {isSignUp && (
            <AuthField
              id="signupSource"
              label={
                <>
                  How did you hear about us?{' '}
                  <span className="font-normal text-fg-muted">(optional)</span>
                </>
              }
              icon={<Info size={ICON_SIZE.dense} aria-hidden="true" />}
              type="text"
              name="signupSource"
              value={payload['signupSource'] || ''}
              onChange={handleChange}
              placeholder="e.g., Google, Twitter, a friend"
            />
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!signInEnabled || isSSOLoading}
          >
            {isSignUp ? 'Create Account' : 'Sign In'}
            <ArrowRight aria-hidden="true" />
          </Button>
        </form>

        {/* Toggle Sign Up/Sign In */}
        <p className="auth-sub mt-5 text-center">
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <Button
            type="button"
            variant="link"
            className="font-semibold text-accent-fg"
            disabled={!signInEnabled || isSSOLoading}
            onClick={() => {
              setIsSignUp(!isSignUp);
              setSignupMessage(null);
            }}
          >
            {isSignUp ? 'Sign In' : 'Create one'}
          </Button>
        </p>

        {/* Trust Badges */}
        {!isSignUp && (
          <div className="auth-trust mt-4">
            {TRUST_BADGES.map(({ icon: Icon, label }) => (
              <span key={label}>
                <Icon aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* Footer */}
      <p className="auth-terms mt-4">
        By signing in, you agree to our{' '}
        <a href="#" className="auth-link">
          Terms of Service
        </a>{' '}
        and{' '}
        <a href="#" className="auth-link">
          Privacy Policy
        </a>
      </p>
    </AuthShell>
  );
};

export default LoginClient;
