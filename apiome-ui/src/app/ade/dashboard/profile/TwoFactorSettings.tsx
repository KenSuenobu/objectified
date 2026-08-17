'use client';

/**
 * Profile TOTP settings (OLO-9.13 #5014 + OLO-9.15 #5015 + OLO-9.50 #5070; re-skinned by
 * HIVE-4.7, #5301).
 *
 * Password-gated enable (QR + confirm + one-time backup reveal) and disable, plus self-service
 * management when enrolled: remaining backup-code count, password-gated regenerate, forget-this-
 * device (per-browser trust cookie), recovery guidance, and Email OTP availability when SendGrid
 * is configured (server-level OTP — no separate enroll).
 *
 * ## What HIVE-4.7 changed, and what it did not
 *
 * **Not** the behaviour. Every call, every error string, every busy label and every `data-testid`
 * is the one `tests/two-factor-settings.test.tsx` already pins, and that suite passes against
 * this file unchanged — which is the point: this is the most complex form cluster in the app,
 * and a redesign that quietly altered a 2FA flow would be a security change wearing a
 * stylesheet's clothes.
 *
 * What changed is everything a token can reach. The six nested boxes were
 * `border-gray-200 dark:border-gray-700` rectangles with `text-emerald-500`, `text-amber-500`,
 * `text-sky-500` and `text-indigo-500` glyphs, and the three dialogs opened with
 * `bg-emerald-100 dark:bg-emerald-900/40` tiles — eleven named colours that froze on one
 * palette. They are icon tiles and hairlines drawn from role tokens now, so the cluster follows
 * all nine themes.
 *
 * Two things are genuinely new, both from the mockup's Adds list: the multi-step dialogs carry
 * the shared {@link import('@/app/components/ui/Stepper').Stepper} in their headers, so a reader
 * can see how far through enrolment they are, and the revealed backup codes can be downloaded as
 * well as copied ({@link import('@/app/components/ade/account/BackupCodes').BackupCodes}).
 *
 * One deliberate deviation from `docs/mockups/account/profile.html`: the mockup prints the
 * two-factor state three times — a badge in the Security card's header, a badge on this row, and
 * "2FA on" in the identity hero. Two of those are kept (the hero's summary and this row's, which
 * is the one beside the control that changes it); the card header carries none, because the third
 * copy says nothing the first two did not.
 */

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import {
  Check,
  Copy,
  KeyRound,
  Mail,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  ShieldPlus,
  X,
} from 'lucide-react';
import { authClient } from '@lib/auth/auth-client';
import { useAuthSession } from '@lib/auth/session-client';
import {
  getBackupCodeStatus,
  getEmailOtpAvailability,
  getTrustedDeviceStatus,
  revokeThisTrustedDevice,
} from '@lib/auth/two-factor-profile-actions';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/app/components/ui/Dialog';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Card } from '@/app/components/ui/Card';
import { Stepper } from '@/app/components/ui/Stepper';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { BackupCodes } from '@/app/components/ade/account/BackupCodes';
import { cn } from '@lib/utils';

type EnrollStep = 'password' | 'qr' | 'backup';
type RegenStep = 'password' | 'reveal';

/** The enrolment wizard's steps, in order — the header stepper and `step` share this list. */
const ENROLL_STEPS = [
  { id: 'password', label: 'Confirm password' },
  { id: 'qr', label: 'Scan QR code' },
  { id: 'backup', label: 'Save backup codes' },
] as const;

/** The regenerate wizard's steps. */
const REGEN_STEPS = [
  { id: 'password', label: 'Confirm password' },
  { id: 'reveal', label: 'Save new codes' },
] as const;

/** How long the "Copied" confirmation on the otpauth URI stays up, in milliseconds. */
const COPIED_RESET_MS = 2000;

interface TwoFactorSettingsProps {
  /** Optional class for the outer status block. */
  className?: string;
}

/**
 * Status + enable/disable/self-service controls for authenticator (TOTP) 2FA on the Profile
 * Security card.
 *
 * @param props.className Optional wrapper class.
 * @returns The two-factor block and its three dialogs.
 */
export function TwoFactorSettings({ className }: TwoFactorSettingsProps) {
  const { data: session, update } = useAuthSession();
  const enabled = Boolean(session?.user?.twoFactorEnabled);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [step, setStep] = useState<EnrollStep>('password');
  const [regenStep, setRegenStep] = useState<RegenStep>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [totpURI, setTotpURI] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [emailOtpAvailable, setEmailOtpAvailable] = useState(false);

  const refreshManagementStatus = useCallback(async () => {
    if (!enabled) {
      setRemaining(null);
      setTrusted(false);
      setEmailOtpAvailable(false);
      return;
    }
    setStatusLoading(true);
    try {
      const [codes, device, emailOtp] = await Promise.all([
        getBackupCodeStatus(),
        getTrustedDeviceStatus(),
        getEmailOtpAvailability(),
      ]);
      setRemaining(codes.remaining);
      setTrusted(device.trusted);
      setEmailOtpAvailable(emailOtp.available);
    } catch {
      setRemaining(null);
      setTrusted(false);
      setEmailOtpAvailable(false);
    } finally {
      setStatusLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refreshManagementStatus();
  }, [refreshManagementStatus]);

  const resetEnroll = () => {
    setStep('password');
    setPassword('');
    setCode('');
    setTotpURI('');
    setBackupCodes([]);
    setError('');
    setBusy(false);
    setCopied(false);
  };

  const resetRegen = () => {
    setRegenStep('password');
    setPassword('');
    setBackupCodes([]);
    setError('');
    setBusy(false);
    setCopied(false);
  };

  const openEnroll = () => {
    resetEnroll();
    setEnrollOpen(true);
  };

  const openDisable = () => {
    setPassword('');
    setError('');
    setBusy(false);
    setDisableOpen(true);
  };

  const openRegen = () => {
    resetRegen();
    setRegenOpen(true);
  };

  const refreshSessionFlag = async () => {
    // update() always refetches; the server session now carries the flipped twoFactorEnabled.
    await update({});
  };

  const handleEnablePassword = async () => {
    if (!password) {
      setError('Enter your current password to enable two-factor authentication.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await authClient.twoFactor.enable({ password });
      if (res?.error) {
        setError(res.error.message || 'Could not start enrollment. Check your password and try again.');
        setBusy(false);
        return;
      }
      const data = res.data as { totpURI?: string; backupCodes?: string[] } | null;
      if (!data?.totpURI) {
        setError('Enrollment did not return a TOTP URI. Please try again.');
        setBusy(false);
        return;
      }
      setTotpURI(data.totpURI);
      setBackupCodes(Array.isArray(data.backupCodes) ? data.backupCodes : []);
      setStep('qr');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enrollment failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmTotp = async () => {
    const trimmed = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await authClient.twoFactor.verifyTotp({ code: trimmed });
      if (res?.error) {
        setError(res.error.message || 'That code was not accepted. Try again.');
        setBusy(false);
        return;
      }
      await refreshSessionFlag();
      setStep('backup');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!password) {
      setError('Enter your current password to disable two-factor authentication.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await authClient.twoFactor.disable({ password });
      if (res?.error) {
        setError(res.error.message || 'Could not disable 2FA. Check your password and try again.');
        setBusy(false);
        return;
      }
      await refreshSessionFlag();
      setDisableOpen(false);
      setPassword('');
      setRemaining(null);
      setTrusted(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disable failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async () => {
    if (!password) {
      setError('Enter your current password to regenerate backup codes.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await authClient.twoFactor.generateBackupCodes({ password });
      if (res?.error) {
        setError(res.error.message || 'Could not regenerate codes. Check your password and try again.');
        setBusy(false);
        return;
      }
      const data = res.data as { backupCodes?: string[] } | null;
      const nextCodes = Array.isArray(data?.backupCodes) ? data.backupCodes : [];
      if (nextCodes.length === 0) {
        setError('No backup codes were returned. Please try again.');
        setBusy(false);
        return;
      }
      setBackupCodes(nextCodes);
      setRemaining(nextCodes.length);
      setRegenStep('reveal');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Regenerate failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleForgetDevice = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await revokeThisTrustedDevice();
      if (!res.ok) {
        setError('Could not forget this device. Try again.');
        return;
      }
      setTrusted(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not forget this device.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyUri = async () => {
    try {
      await navigator.clipboard.writeText(totpURI);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // Clipboard unavailable — the URI is on screen and the QR is beside it.
    }
  };

  return (
    <div className={cn('acct-2fa', className)} data-testid="two-factor-settings">
      <div className="acct-row">
        <span className={enabled ? 'acct-glyph acct-glyph--ok' : 'acct-glyph'} aria-hidden>
          <ShieldCheck />
        </span>
        <div className="acct-row__body">
          <div className="acct-row__title">
            Authenticator app (TOTP)
            <Badge status={enabled ? 'active' : 'disabled'} data-testid="two-factor-status">
              {enabled ? 'Enabled' : 'Off'}
            </Badge>
          </div>
          <p className="acct-row__desc">
            Require a code from Authy or Google Authenticator after your password when signing in.
          </p>
        </div>
        {enabled && (
          <Button
            size="sm"
            variant="outline"
            onClick={openDisable}
            data-testid="two-factor-disable-open"
          >
            <ShieldOff aria-hidden />
            Disable 2FA
          </Button>
        )}
      </div>

      {enabled ? (
        <>
          <Card variant="soft" className="acct-methods" data-testid="two-factor-methods">
            <div className="acct-caps">Sign-in methods</div>
            <ul className="acct-methods__list">
              <li>
                <Check size={ICON_SIZE.dense} className="text-ok" aria-hidden />
                Authenticator app (TOTP)
              </li>
              {emailOtpAvailable && (
                <li data-testid="two-factor-method-email-otp">
                  <Check size={ICON_SIZE.dense} className="text-ok" aria-hidden />
                  Email OTP — available at sign-in (no separate enrollment)
                </li>
              )}
            </ul>
          </Card>

          <div className="acct-mfa">
            {emailOtpAvailable && (
              <div className="acct-mfa__box" data-testid="two-factor-email-otp-info">
                <div className="acct-mfa__title">
                  <Mail size={ICON_SIZE.dense} aria-hidden />
                  Email one-time code
                </div>
                <p className="acct-mfa__desc">
                  After your password, you can request a code emailed to your account address
                  instead of (or in addition to) using your authenticator app.
                </p>
              </div>
            )}

            <div className="acct-mfa__box">
              <div className="acct-mfa__title">
                <KeyRound size={ICON_SIZE.dense} aria-hidden />
                Backup codes
              </div>
              <p className="acct-mfa__desc" data-testid="two-factor-backup-remaining">
                {statusLoading
                  ? 'Checking remaining codes…'
                  : remaining === null
                    ? 'Remaining count unavailable'
                    : `${remaining} remaining`}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={openRegen}
                data-testid="two-factor-regen-open"
              >
                <RefreshCw aria-hidden />
                Regenerate backup codes
              </Button>
            </div>

            <div className="acct-mfa__box">
              <div className="acct-mfa__title">
                <MonitorSmartphone size={ICON_SIZE.dense} aria-hidden />
                Trusted device
              </div>
              <p className="acct-mfa__desc" data-testid="two-factor-trusted-status">
                {statusLoading
                  ? 'Checking this browser…'
                  : trusted
                    ? 'This browser is trusted (skips 2FA for ~30 days when signing in).'
                    : 'This browser is not marked as trusted.'}
              </p>
              {trusted && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleForgetDevice}
                  disabled={busy}
                  data-testid="two-factor-forget-device"
                >
                  <X aria-hidden />
                  {busy ? 'Working…' : 'Forget this device'}
                </Button>
              )}
            </div>
          </div>

          <Alert variant="info" data-testid="two-factor-recovery-guidance">
            <span className="font-semibold">Recovery.</span> Store backup codes somewhere safe. If
            you lose your authenticator, use a backup code at sign-in (when available) or contact
            an admin. After recovery, regenerate codes so old ones cannot be reused.
          </Alert>

          {error && !disableOpen && !regenOpen && !enrollOpen && (
            <Alert variant="error">{error}</Alert>
          )}
        </>
      ) : (
        <Button
          variant="primary"
          className="w-full"
          onClick={openEnroll}
          data-testid="two-factor-enable-open"
        >
          <ShieldPlus aria-hidden />
          Enable 2FA
        </Button>
      )}

      {/* Enrollment dialog */}
      <Dialog
        open={enrollOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setEnrollOpen(open);
          if (!open) {
            resetEnroll();
            void refreshManagementStatus();
          }
        }}
      >
        <DialogContent size="lg">
          <DialogHeader className="acct-dialog__header acct-dialog__header--stacked">
            <div className="acct-dialog__lead">
              <span className="acct-glyph acct-glyph--ok" aria-hidden>
                <ShieldPlus />
              </span>
              <div className="acct-dialog__heading">
                <DialogTitle>Enable two-factor authentication</DialogTitle>
                <DialogDescription>
                  {step === 'password' &&
                    'Confirm your password to start enrollment. You will scan a QR code next.'}
                  {step === 'qr' &&
                    'Scan this QR with Authy or Google Authenticator, then enter the 6-digit code.'}
                  {step === 'backup' &&
                    'Store these one-time codes somewhere safe. You can regenerate a new set later from this page.'}
                </DialogDescription>
              </div>
            </div>
            <Stepper
              steps={ENROLL_STEPS}
              current={step}
              fill
              aria-label="Enrollment progress"
              data-testid="two-factor-enroll-stepper"
            />
          </DialogHeader>

          <div className="acct-dialog__body">
            {error && <Alert variant="error">{error}</Alert>}

            {step === 'password' && (
              <div className="acct-field">
                <Label htmlFor="tfa-enroll-password">Current password</Label>
                <Input
                  id="tfa-enroll-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  autoFocus
                  data-testid="two-factor-enroll-password"
                  onKeyDown={(e) => e.key === 'Enter' && !busy && handleEnablePassword()}
                />
              </div>
            )}

            {step === 'qr' && (
              <div className="acct-enroll">
                {/* Literally white, and deliberately so: a QR code is read by a camera, and
                    the quiet zone has to stay light in every theme for it to scan. */}
                <div className="acct-qr bg-white" data-testid="two-factor-qr">
                  <QRCode value={totpURI} size={180} />
                </div>
                <div className="acct-enroll__fields">
                  <div className="acct-field">
                    <div className="acct-caps">Or enter this URI</div>
                    <div className="acct-uri">
                      <code className="mono">{totpURI}</code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyUri}
                        aria-label={copied ? 'Copied URI' : 'Copy URI'}
                        title={copied ? 'Copied URI' : 'Copy URI'}
                        data-testid="two-factor-copy-uri"
                      >
                        {copied ? <Check className="text-ok" aria-hidden /> : <Copy aria-hidden />}
                      </Button>
                    </div>
                  </div>
                  <div className="acct-field">
                    <Label htmlFor="tfa-enroll-code">Authentication code</Label>
                    <Input
                      id="tfa-enroll-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="000000"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      disabled={busy}
                      className="acct-code-input mono"
                      data-testid="two-factor-enroll-code"
                      onKeyDown={(e) => e.key === 'Enter' && !busy && handleConfirmTotp()}
                    />
                  </div>
                </div>
              </div>
            )}

            {step === 'backup' && <BackupCodes codes={backupCodes} />}
          </div>

          <DialogFooter>
            {step !== 'backup' && (
              <Button
                variant="outline"
                onClick={() => {
                  setEnrollOpen(false);
                  resetEnroll();
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            )}
            {step === 'password' && (
              <Button
                variant="primary"
                onClick={handleEnablePassword}
                disabled={busy}
                data-testid="two-factor-enroll-continue"
              >
                {busy ? 'Working…' : 'Continue'}
              </Button>
            )}
            {step === 'qr' && (
              <Button
                variant="primary"
                onClick={handleConfirmTotp}
                disabled={busy || code.length !== 6}
                data-testid="two-factor-enroll-verify"
              >
                {busy ? 'Verifying…' : 'Confirm and enable'}
              </Button>
            )}
            {step === 'backup' && (
              <Button
                variant="primary"
                onClick={() => {
                  setEnrollOpen(false);
                  resetEnroll();
                  void refreshManagementStatus();
                }}
                data-testid="two-factor-enroll-done"
              >
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerate backup codes */}
      <Dialog
        open={regenOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setRegenOpen(open);
          if (!open) resetRegen();
        }}
      >
        <DialogContent size="sm">
          <DialogHeader className="acct-dialog__header acct-dialog__header--stacked">
            <div className="acct-dialog__lead">
              <span className="acct-glyph acct-glyph--warn" aria-hidden>
                <RefreshCw />
              </span>
              <div className="acct-dialog__heading">
                <DialogTitle>
                  {regenStep === 'password' ? 'Regenerate backup codes' : 'Save new backup codes'}
                </DialogTitle>
                <DialogDescription>
                  {regenStep === 'password'
                    ? 'Enter your password. This replaces your existing backup codes immediately.'
                    : 'Copy these codes now. The previous set is no longer valid.'}
                </DialogDescription>
              </div>
            </div>
            <Stepper
              steps={REGEN_STEPS}
              current={regenStep}
              fill
              aria-label="Regeneration progress"
              data-testid="two-factor-regen-stepper"
            />
          </DialogHeader>

          <div className="acct-dialog__body">
            {error && <Alert variant="error">{error}</Alert>}
            {regenStep === 'password' && (
              <>
                <div className="acct-field">
                  <Label htmlFor="tfa-regen-password">Current password</Label>
                  <Input
                    id="tfa-regen-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                    autoFocus
                    data-testid="two-factor-regen-password"
                    onKeyDown={(e) => e.key === 'Enter' && !busy && handleRegenerate()}
                  />
                </div>
                {remaining !== null && (
                  <Alert variant="warn">
                    Your {remaining} remaining codes stop working the moment new ones are issued.
                  </Alert>
                )}
              </>
            )}
            {regenStep === 'reveal' && <BackupCodes codes={backupCodes} />}
          </div>

          <DialogFooter>
            {regenStep === 'password' && (
              <>
                <Button variant="outline" onClick={() => setRegenOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleRegenerate}
                  disabled={busy}
                  data-testid="two-factor-regen-confirm"
                >
                  {busy ? 'Working…' : 'Regenerate'}
                </Button>
              </>
            )}
            {regenStep === 'reveal' && (
              <Button
                variant="primary"
                onClick={() => {
                  setRegenOpen(false);
                  resetRegen();
                }}
                data-testid="two-factor-regen-done"
              >
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable dialog */}
      <Dialog
        open={disableOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setDisableOpen(open);
          if (!open) {
            setPassword('');
            setError('');
          }
        }}
      >
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader className="acct-dialog__header">
            <span className="acct-glyph acct-glyph--danger" aria-hidden>
              <ShieldOff />
            </span>
            <div className="acct-dialog__heading">
              <DialogTitle>Disable two-factor authentication</DialogTitle>
              <DialogDescription>
                Enter your password to turn off authenticator codes on this account.
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="acct-dialog__body">
            {error && <Alert variant="error">{error}</Alert>}
            <div className="acct-field">
              <Label htmlFor="tfa-disable-password">Current password</Label>
              <Input
                id="tfa-disable-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                autoFocus
                data-testid="two-factor-disable-password"
                onKeyDown={(e) => e.key === 'Enter' && !busy && handleDisable()}
              />
            </div>
            <p className="acct-hint">
              Backup codes and the trusted-device cookie are cleared too. You can re-enable 2FA any
              time.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDisable}
              disabled={busy}
              data-testid="two-factor-disable-confirm"
            >
              {busy ? 'Disabling…' : 'Disable 2FA'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
