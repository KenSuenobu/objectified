'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShieldCheck, KeyRound, ArrowLeft } from 'lucide-react';
import { authClient } from '@lib/auth/auth-client';
import {
  takeTwoFactorCallbackUrl,
  TWO_FACTOR_DEFAULT_CALLBACK,
} from '@lib/auth/two-factor-callback';
import { browserNavigate } from '@lib/auth/browser-navigate';
import { useDarkMode } from '../../hooks/useDarkMode';
import BetaBackground from '../BetaBackground';
import { getAuthErrorCopy } from '../auth-error-copy';
import styles from '../login.module.css';

const inputClasses =
  'block w-full pl-11 pr-4 py-3 rounded-2xl outline-none transition-all duration-200 ' +
  'border border-slate-200/90 bg-white/70 text-slate-800 placeholder-slate-400 ' +
  'hover:bg-white focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 ' +
  'dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:placeholder:text-slate-500 ' +
  'dark:hover:bg-white/[0.07] dark:focus:bg-white/[0.07] dark:focus:border-indigo-400/60 dark:focus:ring-indigo-400/15';

const labelClasses = 'block text-sm font-medium text-slate-700 mb-1.5 dark:text-slate-300';

const iconWrapClasses = 'absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none';

const fieldIconClasses =
  'text-slate-400 group-focus-within:text-indigo-500 transition-colors dark:text-slate-500 dark:group-focus-within:text-indigo-300';

interface TwoFactorClientProps {
  /** Validated by the page (resolveCallbackUrl) before being passed in. */
  callbackUrl?: string;
  error?: string;
}

/**
 * TOTP verification form for the password-path second factor (OLO-9.13 #5014).
 *
 * Submits a 6-digit authenticator code via `authClient.twoFactor.verifyTotp`, then navigates to
 * the stored/queried callback URL once Better Auth issues the full session.
 */
const TwoFactorClient: React.FC<TwoFactorClientProps> = ({
  callbackUrl = TWO_FACTOR_DEFAULT_CALLBACK,
  error,
}) => {
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const isDark = useDarkMode();
  const queryError = getAuthErrorCopy(error);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(trimmed)) {
      setLocalError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setIsSubmitting(true);
    setLocalError(null);
    try {
      const res = await authClient.twoFactor.verifyTotp({ code: trimmed });
      if (res?.error) {
        setLocalError(
          res.error.message ||
            'That code was not accepted. Check your authenticator app and try again.'
        );
        setIsSubmitting(false);
        return;
      }
      const destination = takeTwoFactorCallbackUrl(callbackUrl);
      browserNavigate(destination);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Verification failed. Please try again.');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <BetaBackground />
      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-6 py-12">
        <div data-testid="two-factor-card" className={`${styles.enter} w-full`}>
          <div
            className="rounded-[28px] p-px shadow-2xl shadow-indigo-500/10 dark:shadow-black/50
              bg-gradient-to-b from-white/90 via-slate-200/70 to-slate-200/40
              dark:from-white/15 dark:via-white/[0.07] dark:to-transparent"
          >
            <div className="rounded-[27px] bg-white/80 p-8 backdrop-blur-2xl dark:bg-slate-900/70">
              <div className="mb-8 flex justify-center">
                <div className="relative">
                  <div className="absolute inset-0 scale-150 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 opacity-20 blur-xl" />
                  <img
                    src={isDark ? '/Apiome-05.png' : '/Apiome-02.png'}
                    alt="Apiome Logo"
                    className="relative"
                    style={{ height: '52px', width: 'auto', objectFit: 'contain' }}
                  />
                </div>
              </div>

              <div className="mb-8 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 dark:bg-indigo-900/40">
                  <ShieldCheck className="h-6 w-6 text-indigo-600 dark:text-indigo-300" aria-hidden />
                </div>
                <h1 className="mb-2 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  Two-factor authentication
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Enter the 6-digit code from Authy, Google Authenticator, or another TOTP app.
                </p>
              </div>

              {(queryError || localError) && (
                <div
                  role="alert"
                  className="mb-6 rounded-2xl border border-rose-200/80 bg-rose-50 px-4 py-3 text-sm text-rose-800
                    dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200"
                >
                  {localError ?? queryError?.text}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                <div className="group">
                  <label htmlFor="totp-code" className={labelClasses}>
                    Authentication code
                  </label>
                  <div className="relative">
                    <span className={iconWrapClasses}>
                      <KeyRound className={`h-5 w-5 ${fieldIconClasses}`} aria-hidden />
                    </span>
                    <input
                      id="totp-code"
                      name="code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      maxLength={6}
                      pattern="\d{6}"
                      placeholder="000000"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className={`${inputClasses} font-mono tracking-[0.35em]`}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(localError)}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || code.length !== 6}
                  data-testid="two-factor-submit"
                  className={`${styles.shine} w-full rounded-2xl px-4 py-3.5 font-semibold text-white
                    bg-gradient-to-r from-indigo-600 to-violet-600
                    transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/25
                    disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none`}
                >
                  {isSubmitting ? 'Verifying…' : 'Verify and continue'}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
                <Link
                  href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
                  className="inline-flex items-center gap-1.5 font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Back to sign in
                </Link>
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default TwoFactorClient;
