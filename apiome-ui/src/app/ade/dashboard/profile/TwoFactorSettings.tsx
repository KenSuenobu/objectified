'use client';

/**
 * Profile TOTP settings (OLO-9.13 #5014).
 *
 * Password-gated enable (QR + confirm code + one-time backup-code reveal) and disable.
 * Backup-code regenerate / trusted devices / Email OTP belong to #5006 / #5015.
 */

import { useState } from 'react';
import QRCode from 'react-qr-code';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import { authClient } from '@lib/auth/auth-client';
import { useAuthSession } from '@lib/auth/session-client';
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

type EnrollStep = 'password' | 'qr' | 'backup';

interface TwoFactorSettingsProps {
  /** Optional class for the outer status block. */
  className?: string;
}

/**
 * Status + enable/disable controls for authenticator (TOTP) 2FA on the Profile Security card.
 *
 * @param props.className Optional wrapper class.
 */
export function TwoFactorSettings({ className }: TwoFactorSettingsProps) {
  const { data: session, update } = useAuthSession();
  const enabled = Boolean(session?.user?.twoFactorEnabled);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [step, setStep] = useState<EnrollStep>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [totpURI, setTotpURI] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disable failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyBackupCodes = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className={className} data-testid="two-factor-settings">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-500" aria-hidden />
            Authenticator app (TOTP)
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Require a code from Authy or Google Authenticator after your password when signing in.
          </p>
        </div>
        <Badge variant={enabled ? 'success' : 'secondary'} data-testid="two-factor-status">
          {enabled ? 'Enabled' : 'Off'}
        </Badge>
      </div>

      {enabled ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={openDisable}
          data-testid="two-factor-disable-open"
        >
          Disable 2FA
        </Button>
      ) : (
        <Button
          size="sm"
          className="w-full"
          onClick={openEnroll}
          data-testid="two-factor-enable-open"
        >
          Enable 2FA
        </Button>
      )}

      {/* Enrollment dialog */}
      <Dialog
        open={enrollOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setEnrollOpen(open);
          if (!open) resetEnroll();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-emerald-100 dark:bg-emerald-900/40">
                <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              {step === 'password' && 'Enable two-factor authentication'}
              {step === 'qr' && 'Scan QR code'}
              {step === 'backup' && 'Save backup codes'}
            </DialogTitle>
            <DialogDescription>
              {step === 'password' &&
                'Confirm your password to start enrollment. You will scan a QR code next.'}
              {step === 'qr' &&
                'Scan this QR with Authy or Google Authenticator, then enter the 6-digit code.'}
              {step === 'backup' &&
                'Store these one-time codes somewhere safe. They will not be shown again here until regenerate lands in a later release.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {error && <Alert variant="error">{error}</Alert>}

            {step === 'password' && (
              <div className="space-y-2">
                <Label htmlFor="tfa-enroll-password">Current password</Label>
                <Input
                  id="tfa-enroll-password"
                  type="password"
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
              <>
                <div
                  className="mx-auto rounded-xl bg-white p-4 w-fit"
                  data-testid="two-factor-qr"
                >
                  <QRCode value={totpURI} size={180} />
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 break-all font-mono">
                  {totpURI}
                </p>
                <div className="space-y-2">
                  <Label htmlFor="tfa-enroll-code">Authentication code</Label>
                  <Input
                    id="tfa-enroll-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    disabled={busy}
                    className="font-mono tracking-widest"
                    data-testid="two-factor-enroll-code"
                    onKeyDown={(e) => e.key === 'Enter' && !busy && handleConfirmTotp()}
                  />
                </div>
              </>
            )}

            {step === 'backup' && (
              <div className="space-y-3">
                <ul
                  className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3 font-mono text-sm"
                  data-testid="two-factor-backup-codes"
                >
                  {backupCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={handleCopyBackupCodes}
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4 mr-2" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-2" /> Copy codes
                    </>
                  )}
                </Button>
              </div>
            )}
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
              <Button onClick={handleEnablePassword} disabled={busy} data-testid="two-factor-enroll-continue">
                {busy ? 'Working…' : 'Continue'}
              </Button>
            )}
            {step === 'qr' && (
              <Button onClick={handleConfirmTotp} disabled={busy || code.length !== 6} data-testid="two-factor-enroll-verify">
                {busy ? 'Verifying…' : 'Confirm and enable'}
              </Button>
            )}
            {step === 'backup' && (
              <Button
                onClick={() => {
                  setEnrollOpen(false);
                  resetEnroll();
                }}
                data-testid="two-factor-enroll-done"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-rose-100 dark:bg-rose-900/40">
                <ShieldCheck className="h-5 w-5 text-rose-600 dark:text-rose-400" />
              </div>
              Disable two-factor authentication
            </DialogTitle>
            <DialogDescription>
              Enter your password to turn off authenticator codes on this account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {error && <Alert variant="error">{error}</Alert>}
            <div className="space-y-2">
              <Label htmlFor="tfa-disable-password">Current password</Label>
              <Input
                id="tfa-disable-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                autoFocus
                data-testid="two-factor-disable-password"
                onKeyDown={(e) => e.key === 'Enter' && !busy && handleDisable()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
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
