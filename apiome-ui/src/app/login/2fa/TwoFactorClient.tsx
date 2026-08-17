'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { ArrowLeft, KeyRound, Mail, RefreshCw, Send, ShieldCheck } from 'lucide-react';
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
import { AuthShell } from '../../components/auth/AuthShell';
import { AuthField } from '../../components/auth/AuthField';
import { BetaBadge } from '../../components/auth/BetaBadge';
import { getAuthErrorCopy } from '../auth-error-copy';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';

/**
 * How long the code the second factor asks for is. Both Better Auth methods issue six
 * digits, which is why one field serves both and why submit stays disabled until then.
 */
const CODE_LENGTH = 6;

/** A complete code: six digits and nothing else. */
const COMPLETE_CODE = /^\d{6}$/;

/**
 * Keep only the digits of whatever landed in the box, capped at {@link CODE_LENGTH}.
 *
 * Applied on every change rather than on paste alone, so a pasted `"123 456"`, a code
 * copied with its trailing newline and a mistyped letter all resolve the same way.
 *
 * @param raw What the control now holds.
 * @returns The digits of `raw`, at most six of them.
 */
const sanitizeCode = (raw: string): string => raw.replace(/\D/g, '').slice(0, CODE_LENGTH);

/** Everything that differs between the two second factors, in one table. */
interface MethodCopy {
  /** The tab's label in the method switcher. */
  tab: string;
  /** The card's heading for this method. */
  heading: string;
  /** The `id` of this method's code box — the label points at it. */
  fieldId: string;
  /** The code box's visible name. */
  fieldLabel: string;
  /** Shown when submit is pressed with fewer than six digits, before any request. */
  incomplete: string;
  /** Shown when the API rejects the code and sends no message of its own. */
  rejected: string;
}

const METHOD_COPY: Readonly<Record<TwoFactorMethod, MethodCopy>> = {
  totp: {
    tab: 'Authenticator',
    heading: 'Two-factor authentication',
    fieldId: 'totp-code',
    fieldLabel: 'Authentication code',
    incomplete: 'Enter the 6-digit code from your authenticator app.',
    rejected: 'That code was not accepted. Check your authenticator app and try again.',
  },
  otp: {
    tab: 'Email code',
    heading: 'Check your email',
    fieldId: 'email-otp-code',
    fieldLabel: 'Email code',
    incomplete: 'Enter the 6-digit code from your email.',
    rejected: 'That code was not accepted. Request a new email code and try again.',
  },
};

/** The description under the heading — the only line that also depends on progress. */
const TOTP_DESCRIPTION =
  'Enter the 6-digit code from Authy, Google Authenticator, or another TOTP app.';
const OTP_DESCRIPTION_BEFORE_SEND =
  'We will email a 6-digit code to the address on your account.';
const OTP_DESCRIPTION_AFTER_SEND = 'Enter the 6-digit code we emailed you.';

interface TwoFactorClientProps {
  /** Validated by the page (resolveCallbackUrl) before being passed in. */
  callbackUrl?: string;
  error?: string;
}

/**
 * Second-factor verification after password sign-in (OLO-9.13 #5014 + OLO-9.50 #5070,
 * re-skinned by HIVE-4.2 #5296).
 *
 * Authority: `docs/mockups/auth/two-factor.html`, `docs/mockups/DESIGN.md` §2 and §7.
 *
 * Nothing about the flow moved. It still honours `twoFactorMethods` from the challenge —
 * TOTP (`verifyTotp`), email OTP (`sendOtp` / `verifyOtp`), or a switcher when both are
 * offered — still reads and clears the same two `sessionStorage` keys, and still carries
 * every error string it carried before. What changed is that the screen is now drawn from
 * the Hive token layer instead of a page-local stylesheet of named colours: the aurora
 * blobs, the tiled BETA watermark and the glass card are gone, so the second step follows
 * the reader's theme, density and font-scale preference like the rest of the app.
 *
 * The frame is `components/auth/AuthShell` in its centred shape (no brand panel), shared
 * with `/login` — see the "AUTH SURFACES" section of `globals.css` for the skin.
 *
 * The method switcher is a real `role="tablist"`, driven by Radix rather than by hand,
 * because the two methods are two *panes*: arrow keys move between them and select as they
 * move, and the group keeps a single Tab stop. The card's own strip is drawn as the
 * segmented well of DESIGN.md §7 (`.auth-methods`) rather than the app's underline tabs,
 * which the mockup calls for explicitly — an underline strip inside a 27 rem card reads as
 * a page's primary sections rather than as one field's choice.
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
  /**
   * Whether the code box may still take focus on mount.
   *
   * The box is autofocused on arrival, which is what the reader wants: they have the code
   * in front of them already. It must not happen a second time, though — the switcher
   * selects as the arrow keys move, so a freshly mounted panel that grabbed focus would
   * strand the reader in the field they were trying to move past.
   */
  const [autoFocusCode, setAutoFocusCode] = useState(true);

  const queryError = getAuthErrorCopy(error);
  const showMethodSwitcher = methods.includes('totp') && methods.includes('otp');
  const copy = METHOD_COPY[activeMethod];
  const bannerText = localError ?? queryError?.text;

  /** The challenge is spent: drop what was stored for it and leave for the callback. */
  const finishSuccess = () => {
    takeTwoFactorMethods();
    const destination = takeTwoFactorCallbackUrl(callbackUrl);
    browserNavigate(destination);
  };

  /**
   * Verify the code in the box with whichever method is showing.
   *
   * Both methods answer the same shape, so the only thing that differs is which client
   * call is made and which sentence is shown when the API rejects the code without one of
   * its own.
   *
   * @param e The form's submit event.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = sanitizeCode(code);
    if (!COMPLETE_CODE.test(trimmed)) {
      setLocalError(copy.incomplete);
      return;
    }
    setIsSubmitting(true);
    setLocalError(null);
    try {
      const res =
        activeMethod === 'otp'
          ? await authClient.twoFactor.verifyOtp({ code: trimmed })
          : await authClient.twoFactor.verifyTotp({ code: trimmed });
      if (res?.error) {
        setLocalError(res.error.message || copy.rejected);
        setIsSubmitting(false);
        return;
      }
      finishSuccess();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Verification failed. Please try again.');
      setIsSubmitting(false);
    }
  };

  /** Ask Better Auth to mail a fresh code. Also the "resend" path — same request. */
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

  /**
   * Show a different second factor.
   *
   * The half-typed code and any error belong to the method that was showing, so both go:
   * an authenticator code is not an email code, and the sentence about one would be read
   * as being about the other.
   *
   * @param method The method the reader moved to.
   */
  const selectMethod = (method: string) => {
    if (method !== 'totp' && method !== 'otp') return;
    setActiveMethod(method);
    setCode('');
    setLocalError(null);
    setAutoFocusCode(false);
  };

  const description =
    activeMethod === 'otp'
      ? otpSent
        ? OTP_DESCRIPTION_AFTER_SEND
        : OTP_DESCRIPTION_BEFORE_SEND
      : TOTP_DESCRIPTION;

  /**
   * The card body for one method: the send button (email only), the code box, and submit.
   *
   * Written once and called for each method rather than spelled out twice, so the two
   * paths cannot drift on the parts the ticket requires of both — digits only, six of
   * them, `one-time-code`, and a submit that stays disabled until the code is complete.
   *
   * @param method Which second factor this form verifies.
   * @returns The form.
   */
  const renderForm = (method: TwoFactorMethod) => {
    const form = METHOD_COPY[method];
    const isComplete = code.length === CODE_LENGTH;

    return (
      <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4" noValidate>
        {method === 'otp' && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            onClick={handleSendOtp}
            disabled={isSendingOtp || isSubmitting}
            data-testid="two-factor-send-otp"
          >
            {isSendingOtp ? (
              <Spinner size="sm" aria-hidden="true" />
            ) : otpSent ? (
              <RefreshCw aria-hidden="true" />
            ) : (
              <Send aria-hidden="true" />
            )}
            {isSendingOtp ? 'Sending…' : otpSent ? 'Resend email code' : 'Send email code'}
          </Button>
        )}

        <AuthField
          className="auth-code"
          id={form.fieldId}
          label={form.fieldLabel}
          icon={
            method === 'otp' ? (
              <Mail size={ICON_SIZE.dense} aria-hidden="true" />
            ) : (
              <KeyRound size={ICON_SIZE.dense} aria-hidden="true" />
            )
          }
          hint={`Digits only · the button enables once ${CODE_LENGTH} digits are entered`}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus={autoFocusCode}
          maxLength={CODE_LENGTH}
          pattern="\d{6}"
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(sanitizeCode(e.target.value))}
          disabled={isSubmitting}
          invalid={Boolean(localError)}
          data-testid={method === 'otp' ? 'two-factor-otp-code' : 'two-factor-totp-code'}
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={isSubmitting || !isComplete}
          data-testid={method === 'otp' ? 'two-factor-otp-submit' : 'two-factor-submit'}
        >
          {isSubmitting && <Spinner size="sm" tone="light" aria-hidden="true" />}
          {isSubmitting ? 'Verifying…' : 'Verify and continue'}
        </Button>
      </form>
    );
  };

  return (
    <AuthShell>
      {/* The mark sits above the card rather than inside it: this page has no brand panel,
          so it is the only thing naming the product the reader is signing in to. */}
      <div className="auth-brandbar">
        <BrandMark variant="lockup" size={36} className="auth-brand__lockup" priority />
        <BetaBadge />
      </div>

      <Card data-testid="two-factor-card" className="auth-card">
        <span className="auth-icon" aria-hidden="true">
          {activeMethod === 'otp' ? <Mail /> : <ShieldCheck />}
        </span>
        <h1 className="auth-title mt-4">{copy.heading}</h1>
        <p className="auth-sub mt-1">{description}</p>

        {/* One banner for both sources: the local "that is not six digits" sentence and the
            `?error=` copy the redirect carries. `role="alert"` so a screen reader is
            interrupted — a rejected code is the reader's next problem, not a note. */}
        {bannerText && (
          <Alert
            variant="danger"
            role="alert"
            data-testid="two-factor-error"
            className="mt-4"
          >
            {bannerText}
          </Alert>
        )}

        {/* The email code has been sent, which nothing else on the card announces: the
            description changes, and a changed paragraph is not read out. */}
        {activeMethod === 'otp' && otpSent && !bannerText && (
          <Alert
            variant="ok"
            role="status"
            aria-live="polite"
            data-testid="two-factor-otp-sent"
            className="mt-4"
          >
            Email code sent. Check your inbox.
          </Alert>
        )}

        {showMethodSwitcher ? (
          <TabsPrimitive.Root value={activeMethod} onValueChange={selectMethod}>
            <TabsPrimitive.List
              className="auth-methods mt-5"
              aria-label="Verification method"
              data-testid="two-factor-method-switcher"
            >
              {(['totp', 'otp'] as const).map((method) => (
                <TabsPrimitive.Trigger
                  key={method}
                  value={method}
                  className="auth-methods__tab"
                  data-testid={`two-factor-method-${method}`}
                >
                  {method === 'otp' ? (
                    <Mail aria-hidden="true" />
                  ) : (
                    <ShieldCheck aria-hidden="true" />
                  )}
                  {METHOD_COPY[method].tab}
                </TabsPrimitive.Trigger>
              ))}
            </TabsPrimitive.List>
            <TabsPrimitive.Content value="totp">{renderForm('totp')}</TabsPrimitive.Content>
            <TabsPrimitive.Content value="otp">{renderForm('otp')}</TabsPrimitive.Content>
          </TabsPrimitive.Root>
        ) : (
          renderForm(activeMethod)
        )}

        <div className="auth-sub mt-6 text-center">
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
            className="auth-link inline-flex items-center gap-1.5 font-medium"
          >
            <ArrowLeft className="size-[var(--icon-button)]" aria-hidden="true" />
            Back to sign in
          </Link>
        </div>
      </Card>
    </AuthShell>
  );
};

export default TwoFactorClient;
