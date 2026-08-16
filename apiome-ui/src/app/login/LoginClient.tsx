"use client";

import { useState } from 'react';
import { Mail, Lock, User, Info, ShieldCheck, Zap, CreditCard, ArrowRight, RotateCcw } from 'lucide-react';
import { signIn } from '@lib/auth/session-client';
import { createSignupRequest } from '../../../lib/db/helper';
import { BrandMark } from '../components/brand';
import type { ProviderSummary } from '../../../lib/auth/provider-registry';
import { getProviderBrand } from '../components/auth/provider-brand';
import BetaBackground from './BetaBackground';
import { getAuthErrorCopy } from './auth-error-copy';
import styles from './login.module.css';

const FORMAT_CHIPS = ['OpenAPI', 'AsyncAPI', 'GraphQL', 'gRPC', 'Avro', 'WSDL', 'TypeSpec', 'OData'];

const inputClasses =
  "block w-full pl-11 pr-4 py-3 rounded-2xl outline-none transition-all duration-200 " +
  "border border-slate-200/90 bg-white/70 text-slate-800 placeholder-slate-400 " +
  "hover:bg-white focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 " +
  "dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:placeholder:text-slate-500 " +
  "dark:hover:bg-white/[0.07] dark:focus:bg-white/[0.07] dark:focus:border-indigo-400/60 dark:focus:ring-indigo-400/15";

const labelClasses = "block text-sm font-medium text-slate-700 mb-1.5 dark:text-slate-300";

const iconWrapClasses = "absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none";

const fieldIconClasses =
  "text-slate-400 group-focus-within:text-indigo-500 transition-colors dark:text-slate-500 dark:group-focus-within:text-indigo-300";

interface SSOButtonProps {
  provider: string;
  icon: React.ReactNode;
  onClick: () => void;
  isSignUp?: boolean;
}

const SSOButton: React.FC<SSOButtonProps> = ({ provider, icon, onClick, isSignUp }) => {
  const label = isSignUp ? `Sign up with ${provider}` : `Continue with ${provider}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.shine} w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-2xl cursor-pointer group
        border border-slate-200/90 bg-white/70 text-slate-700
        transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-300/80 hover:bg-white hover:shadow-lg hover:shadow-indigo-500/10
        dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200
        dark:hover:border-indigo-400/40 dark:hover:bg-white/[0.08] dark:hover:shadow-indigo-950/40`}
    >
      {/* Decorative brand mark — the button's text label carries the accessible name, so the
          icon is hidden from assistive tech (some react-icons set role="img" without a title). */}
      <span aria-hidden="true" className="flex-shrink-0 transition-transform duration-200 group-hover:scale-110">{icon}</span>
      <span className="font-semibold">{label}</span>
    </button>
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
    setPayload({
      ...payload,
      [e.target.name]: e.target.value,
    });
  }

  const isBetaMode = process.env.NEXT_PUBLIC_BETA_MODE;
  // Distinct guidance per structured auth error code (OLO-1.5) from the NextAuth error redirect,
  // rendered with per-code affordances (OLO-3.2). Unknown codes resolve to the safe generic
  // banner inside getAuthErrorCopy; in-page signup feedback always outranks the redirect error.
  const authErrorCopy = getAuthErrorCopy(error);
  const message = signupMessage || authErrorCopy;
  // "Try again" returns to a clean login page: the error param is dropped so the banner clears,
  // while the (already-validated) callbackUrl survives the round trip.
  const showRetry = !signupMessage && Boolean(authErrorCopy?.retry);
  const retryHref = `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  return (
    <div className="min-h-screen relative overflow-hidden bg-slate-50 dark:bg-slate-950">
      {/* Aurora field */}
      <div aria-hidden="true" className="absolute inset-0">
        <div
          className={`${styles.blob} ${styles.blobA} w-[42rem] h-[42rem] -top-56 -left-40
            bg-gradient-to-br from-indigo-300/50 to-violet-300/40
            dark:from-indigo-600/25 dark:to-violet-600/20`}
        />
        <div
          className={`${styles.blob} ${styles.blobB} w-[38rem] h-[38rem] -bottom-48 -right-32
            bg-gradient-to-br from-sky-300/45 to-cyan-200/40
            dark:from-blue-700/20 dark:to-cyan-600/15`}
        />
        <div
          className={`${styles.blob} ${styles.blobC} w-[28rem] h-[28rem] top-1/3 left-1/2 -translate-x-1/2
            bg-gradient-to-br from-fuchsia-300/30 to-pink-200/30
            dark:from-fuchsia-700/15 dark:to-pink-700/15`}
        />
        <div className={`${styles.grid} text-slate-900/[0.05] dark:text-white/[0.05]`} />
        <div className={styles.grain} />
      </div>

      {/* Beta Background */}
      {isBetaMode && <BetaBackground />}

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center gap-16 px-6 py-12 lg:grid lg:grid-cols-[1.05fr_1fr]">
        {/* Brand hero (desktop) */}
        <div className={`${styles.enterSlow} hidden lg:flex flex-col justify-center select-none`}>
          <BrandMark variant="wordmark" size={48} className="mb-10 self-start" priority />

          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.28em] text-indigo-600/80 dark:text-indigo-300/80">
            The API design environment
          </p>

          <h2 className="text-5xl xl:text-6xl font-bold tracking-tight leading-[1.05] text-slate-900 dark:text-slate-50">
            Design. Version.
            <br />
            <span
              className={`${styles.shimmer} bg-gradient-to-r from-indigo-600 via-fuchsia-500 to-indigo-600 bg-clip-text text-transparent
                dark:from-indigo-300 dark:via-fuchsia-300 dark:to-indigo-300`}
            >
              Publish your APIs.
            </span>
          </h2>

          <p className="mt-6 max-w-md text-base leading-relaxed text-slate-600 dark:text-slate-400">
            Model your API once, then import, lint, diff, and export across every
            format your consumers speak — with honest fidelity at each step.
          </p>

          <div className="mt-10 flex max-w-md flex-wrap gap-2.5">
            {FORMAT_CHIPS.map((chip, i) => (
              <span
                key={chip}
                className={`${i % 2 === 0 ? styles.float : styles.floatDelayed} rounded-full px-3.5 py-1.5 text-xs font-semibold
                  border border-slate-200/90 bg-white/70 text-slate-600 backdrop-blur-sm
                  dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-300`}
              >
                {chip}
              </span>
            ))}
          </div>
        </div>

        {/* Auth card */}
        <div data-testid="login-card" className={`${styles.enter} w-full max-w-md lg:justify-self-end`}>
          <div
            className="rounded-[28px] p-px shadow-2xl shadow-indigo-500/10 dark:shadow-black/50
              bg-gradient-to-b from-white/90 via-slate-200/70 to-slate-200/40
              dark:from-white/15 dark:via-white/[0.07] dark:to-transparent"
          >
            <div className="rounded-[27px] bg-white/80 p-8 backdrop-blur-2xl dark:bg-slate-900/70">
              {/* Logo (mobile — hero carries it on desktop) */}
              <div className="mb-8 flex justify-center lg:hidden">
                <div className="relative">
                  <div className="absolute inset-0 scale-150 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 opacity-20 blur-xl" />
                  <BrandMark variant="wordmark" size={52} className="relative" />
                </div>
              </div>

              {/* Header */}
              <div className="mb-8 text-center lg:text-left">
                <h1 className="mb-2 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  {isSignUp ? 'Create your account' : 'Welcome back'}
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {isSignUp
                    ? 'Join thousands of developers building with Apiome'
                    : 'Sign in to continue to your workspace'}
                </p>
                {!isSignUp && (
                  <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                    New to Apiome?{' '}
                    <a
                      href="https://youtu.be/GQBgza8eYoQ"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-indigo-600 transition-colors hover:text-indigo-500 hover:underline dark:text-indigo-300 dark:hover:text-indigo-200"
                    >
                      Watch our intro video →
                    </a>
                  </p>
                )}
              </div>

              {/* Message Display — per-code copy and affordances (OLO-3.2).
                  Errors announce assertively via role="alert" so a screen reader interrupts
                  with the failure; success/info updates stay polite (OLO-3.5, a11y). */}
              {message && (
                <div
                  role={message.type === 'error' ? 'alert' : 'status'}
                  aria-live={message.type === 'error' ? 'assertive' : 'polite'}
                  data-testid="login-banner"
                  className={`mb-6 rounded-2xl border p-4 backdrop-blur-sm ${
                    message.type === 'success'
                      ? 'border-emerald-200 bg-emerald-50/80 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-900/30 dark:text-emerald-200'
                      : message.type === 'info'
                        ? 'border-blue-200 bg-blue-50/80 text-blue-800 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-200'
                        : 'border-red-200 bg-red-50/80 text-red-800 dark:border-red-700/60 dark:bg-red-900/30 dark:text-red-200'
                  }`}
                >
                  <p className="text-sm font-medium">{message.text}</p>
                  {showRetry && (
                    <a
                      href={retryHref}
                      className={`mt-3 inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                        message.type === 'info'
                          ? 'border-blue-300 hover:bg-blue-100/80 dark:border-blue-600/60 dark:hover:bg-blue-900/50'
                          : 'border-red-300 hover:bg-red-100/80 dark:border-red-600/60 dark:hover:bg-red-900/50'
                      }`}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      Try again
                    </a>
                  )}
                </div>
              )}

              {/* SSO first — the primary path. One button per enabled provider (registry, OLO-2.3). */}
              {ssoProviders.length > 0 && (
                isSSOLoading ? (
                  <div className="py-8 text-center">
                    <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-500">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    </div>
                    <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">Connecting…</p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Redirecting to authentication provider</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {ssoProviders.map((provider) => {
                      const { Icon, iconClassName } = getProviderBrand(provider.id);
                      return (
                        <SSOButton
                          key={provider.id}
                          provider={provider.label}
                          icon={<Icon size={20} className={iconClassName} />}
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
                <div className="relative my-8">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-slate-200 dark:border-white/10" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    {showCredentials ? (
                      <span className="px-4 font-medium text-slate-400 bg-white/80 dark:bg-slate-900/70 dark:text-slate-500 rounded-full">
                        or use your email
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowCredentials(true)}
                        disabled={isSSOLoading}
                        aria-expanded={false}
                        aria-controls="credentials-form"
                        className="cursor-pointer px-4 font-medium text-indigo-600 bg-white/80 rounded-full
                          transition-colors hover:text-indigo-500 hover:underline
                          disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline
                          dark:bg-slate-900/70 dark:text-indigo-300 dark:hover:text-indigo-200"
                      >
                        or use your email
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Credentials form — collapsed (hidden) until requested when SSO is available
                  (OLO-3.1). Tailwind preflight gives [hidden] display:none, and hidden fields
                  are neither focusable nor submittable, so the collapsed form is fully inert. */}
              <form id="credentials-form" hidden={!showCredentials} onSubmit={handleSubmit} className="space-y-5">
                {isSignUp && (
                  <div>
                    <label htmlFor="name" className={labelClasses}>
                      Full Name
                    </label>
                    <div className="group relative">
                      <div className={iconWrapClasses}>
                        <User size={18} className={fieldIconClasses} />
                      </div>
                      <input
                        id="name"
                        type="text"
                        name={'name'}
                        value={payload['name']}
                        onChange={handleChange}
                        required
                        autoComplete="name"
                        className={inputClasses}
                        placeholder="John Doe"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label htmlFor="email" className={labelClasses}>
                    Email Address
                  </label>
                  <div className="group relative">
                    <div className={iconWrapClasses}>
                      <Mail size={18} className={fieldIconClasses} />
                    </div>
                    <input
                      id="email"
                      type="email"
                      name={'email'}
                      value={payload['email']}
                      onChange={handleChange}
                      required
                      autoComplete="email"
                      className={inputClasses}
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="password" className={labelClasses}>
                    Password
                  </label>
                  <div className="group relative">
                    <div className={iconWrapClasses}>
                      <Lock size={18} className={fieldIconClasses} />
                    </div>
                    <input
                      id="password"
                      type="password"
                      name={'password'}
                      value={payload['password']}
                      onChange={handleChange}
                      required
                      autoComplete={isSignUp ? 'new-password' : 'current-password'}
                      className={inputClasses}
                      placeholder="••••••••"
                    />
                  </div>
                </div>

                {isSignUp && (
                  <div>
                    <label htmlFor="signupSource" className={labelClasses}>
                      How did you hear about us?
                      <span className="ml-1 font-normal text-slate-400 dark:text-slate-500">(optional)</span>
                    </label>
                    <div className="group relative">
                      <div className={iconWrapClasses}>
                        <Info size={18} className={fieldIconClasses} />
                      </div>
                      <input
                        id="signupSource"
                        type="text"
                        name={'signupSource'}
                        value={payload['signupSource'] || ''}
                        onChange={handleChange}
                        className={inputClasses}
                        placeholder="e.g., Google, Twitter, a friend"
                      />
                    </div>
                  </div>
                )}

                {!isSignUp && (
                  <div className="flex items-center justify-end">
                    <a
                      href="#"
                      className="text-sm font-medium text-indigo-600 transition-colors hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200"
                    >
                      Forgot your password?
                    </a>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!signInEnabled || isSSOLoading}
                  className={`${styles.shine} group w-full cursor-pointer rounded-2xl py-3.5 font-semibold text-white
                    bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600 bg-[length:150%_auto]
                    shadow-lg shadow-indigo-500/25 transition-all duration-300
                    hover:bg-right hover:shadow-xl hover:shadow-indigo-500/40 hover:-translate-y-0.5
                    disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0`}
                >
                  <span className="inline-flex items-center justify-center gap-2">
                    {isSignUp ? 'Create Account' : 'Sign In'}
                    <ArrowRight size={17} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                  </span>
                </button>
              </form>

              {/* Toggle Sign Up/Sign In */}
              <div className="mt-8 border-t border-slate-100 pt-6 text-center dark:border-white/10">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
                  <button
                    type="button"
                    disabled={!signInEnabled || isSSOLoading}
                    onClick={() => {
                      setIsSignUp(!isSignUp);
                      setSignupMessage(null);
                    }}
                    className="cursor-pointer font-semibold text-indigo-600 transition-colors hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200"
                  >
                    {isSignUp ? 'Sign In' : 'Create one'}
                  </button>
                </p>
              </div>

              {/* Trust Badges */}
              {!isSignUp && (
                <div className="mt-6 flex items-center justify-center gap-6 text-xs text-slate-400 dark:text-slate-500">
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck size={15} className="text-emerald-500" />
                    <span>Secure</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Zap size={15} className="text-emerald-500" />
                    <span>Free to start</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <CreditCard size={15} className="text-emerald-500" />
                    <span>No credit card</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <p className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">
            By signing in, you agree to our{' '}
            <a href="#" className="text-indigo-500 transition-colors hover:text-indigo-600 dark:text-indigo-300 dark:hover:text-indigo-200">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="#" className="text-indigo-500 transition-colors hover:text-indigo-600 dark:text-indigo-300 dark:hover:text-indigo-200">
              Privacy Policy
            </a>
          </p>
        </div>
      </main>
    </div>
  );
};

export default LoginClient;
