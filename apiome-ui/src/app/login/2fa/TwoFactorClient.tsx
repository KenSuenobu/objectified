'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ShieldCheck, KeyRound, ArrowLeft, Mail } from 'lucide-react';
import { authClient } from '@lib/auth/auth-client';
import {
  peekTwoFactorMethods,
  takeTwoFactorCallbackUrl,
  takeTwoFactorMethods,
  TWO_FACTOR_DEFAULT_CALLBACK,
  type TwoFactorMethod,
} from '@lib/auth/two-factor-callback';
import { browserNavigate } from '@lib/auth/browser-navigate';
import { BrandMark } from '../../components/brand';
import BetaBackground from '../BetaBackground';
import { getAuthErrorCopy } from '../auth-error-copy';
import styles from '../login.module.css';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { cn } from '@lib/utils';

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
 * Second-factor verification after password sign-in (OLO-9.13 #5014 + OLO-9.50 #5070).
 *
 * Honors `twoFactorMethods` from the challenge: TOTP (`verifyTotp`), email OTP (`sendOtp` /
 * `verifyOtp`), or a switcher when both are offered.
 */
const TwoFactorClient: React.FC<TwoFactorClientProps> = ({
  callbackUrl = TWO_FACTOR_DEFAULT_CALLBACK,
  error,
}) => {
  const methods = useMemo(() => peekTwoFactorMethods(), []);
  const [activeMethod, setActiveMethod] = useState<TwoFactorMethod>(() =>
    methods.includes('totp') ? 'totp' : methods[0] ?? 'totp'
  );
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const queryError = getAuthErrorCopy(error);
  const showMethodSwitcher = methods.includes('totp') && methods.includes('otp');

  const finishSuccess = () => {
    takeTwoFactorMethods();
    const destination = takeTwoFactorCallbackUrl(callbackUrl);
    browserNavigate(destination);
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
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
      finishSuccess();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Verification failed. Please try again.');
      setIsSubmitting(false);
    }
  };

  const handleSendOtp = async () => {
    setIsSendingOtp(true);
    setLocalError(null);
    try {
      const res = await authClient.twoFactor.sendOtp({});
      if (res?.error) {
        setLocalError(res.error.message || 'Could not send the email code. Try again.');
        return;
      }
      setOtpSent(true);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not send the email code.');
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(trimmed)) {
      setLocalError('Enter the 6-digit code from your email.');
      return;
    }
    setIsSubmitting(true);
    setLocalError(null);
    try {
      const res = await authClient.twoFactor.verifyOtp({ code: trimmed });
      if (res?.error) {
        setLocalError(
          res.error.message || 'That code was not accepted. Request a new email code and try again.'
        );
        setIsSubmitting(false);
        return;
      }
      finishSuccess();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Verification failed. Please try again.');
      setIsSubmitting(false);
    }
  };

  const selectMethod = (method: TwoFactorMethod) => {
    setActiveMethod(method);
    setCode('');
    setLocalError(null);
  };

  const heading =
    activeMethod === 'otp' ? 'Check your email' : 'Two-factor authentication';
  const description =
    activeMethod === 'otp'
      ? otpSent
        ? 'Enter the 6-digit code we emailed you.'
        : 'We will email a 6-digit code to the address on your account.'
      : 'Enter the 6-digit code from Authy, Google Authenticator, or another TOTP app.';

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
                  <BrandMark variant="wordmark" size={52} className="relative" priority />
                </div>
              </div>

              <div className="mb-8 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 dark:bg-indigo-900/40">
                  {activeMethod === 'otp' ? (
                    <Mail className="h-6 w-6 text-indigo-600 dark:text-indigo-300" aria-hidden />
                  ) : (
                    <ShieldCheck className="h-6 w-6 text-indigo-600 dark:text-indigo-300" aria-hidden />
                  )}
                </div>
                <h1 className="mb-2 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  {heading}
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
              </div>

              {showMethodSwitcher && (
                <div
                  className={cn(TAB_LIST_CLASS, 'mb-6')}
                  role="tablist"
                  aria-label="Verification method"
                  data-testid="two-factor-method-switcher"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeMethod === 'totp'}
                    data-testid="two-factor-method-totp"
                    className={tabTriggerClass({ active: activeMethod === 'totp' })}
                    onClick={() => selectMethod('totp')}
                  >
                    Authenticator
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeMethod === 'otp'}
                    data-testid="two-factor-method-otp"
                    className={tabTriggerClass({ active: activeMethod === 'otp' })}
                    onClick={() => selectMethod('otp')}
                  >
                    Email code
                  </button>
                </div>
              )}

              {(queryError || localError) && (
                <div
                  role="alert"
                  className="mb-6 rounded-2xl border border-rose-200/80 bg-rose-50 px-4 py-3 text-sm text-rose-800
                    dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200"
                >
                  {localError ?? queryError?.text}
                </div>
              )}

              {activeMethod === 'otp' ? (
                <form onSubmit={handleOtpSubmit} className="space-y-5" noValidate>
                  <button
                    type="button"
                    onClick={handleSendOtp}
                    disabled={isSendingOtp || isSubmitting}
                    data-testid="two-factor-send-otp"
                    className="w-full rounded-2xl border border-slate-200/90 bg-white/70 px-4 py-3 text-sm font-semibold
                      text-slate-800 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60
                      dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.07]"
                  >
                    {isSendingOtp ? 'Sending…' : otpSent ? 'Resend email code' : 'Send email code'}
                  </button>

                  <div className="group">
                    <label htmlFor="email-otp-code" className={labelClasses}>
                      Email code
                    </label>
                    <div className="relative">
                      <span className={iconWrapClasses}>
                        <Mail className={`h-5 w-5 ${fieldIconClasses}`} aria-hidden />
                      </span>
                      <input
                        id="email-otp-code"
                        name="code"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        pattern="\d{6}"
                        placeholder="000000"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        className={`${inputClasses} font-mono tracking-[0.35em]`}
                        disabled={isSubmitting}
                        aria-invalid={Boolean(localError)}
                        data-testid="two-factor-otp-code"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitting || code.length !== 6}
                    data-testid="two-factor-otp-submit"
                    className={`${styles.shine} w-full rounded-2xl px-4 py-3.5 font-semibold text-white
                      bg-gradient-to-r from-indigo-600 to-violet-600
                      transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/25
                      disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none`}
                  >
                    {isSubmitting ? 'Verifying…' : 'Verify and continue'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleTotpSubmit} className="space-y-5" noValidate>
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
              )}

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
