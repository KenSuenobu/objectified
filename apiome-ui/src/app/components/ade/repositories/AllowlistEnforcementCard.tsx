'use client';

/**
 * Turning the webhook filter off, and back on (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/webhook-allowlist.html` — *Enforcement for this workspace*
 * and the *Bypass the allowlist?* confirm the **Notes → Adds** list introduces.
 *
 * ### Why bypassing takes three steps and restoring takes one
 *
 * Bypassing means this workspace's repositories accept webhook deliveries from *any* address,
 * in front of an endpoint whose only other authentication is an HMAC signature. So it asks for
 * a reason, then asks again in a confirm that quotes the reason back — the last moment anyone
 * can correct what the audit ledger is about to record. Restoring enforcement narrows what is
 * accepted and needs no reason, so it is one click: a safety control that is hard to *turn on*
 * is a safety control that stays off.
 *
 * The reason is validated here rather than in the confirm, so an empty one never opens a
 * dialog it cannot complete.
 */

import * as React from 'react';
import { ShieldOff } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/AlertDialog';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';

import {
  BYPASS_REASON_REQUIRED,
  ENFORCEMENT_DESC,
  ENFORCEMENT_TITLE,
  bypassConfirm,
  formatTimestamp,
} from './webhookAllowlistModel';

export interface AllowlistEnforcementCardProps {
  /** Whether this workspace is currently enforcing the filter. */
  enforcing: boolean;
  /** When the policy last changed, as an ISO timestamp, or null if it never has. */
  policyUpdatedAt: string | null;
  /** True while a mutation is in flight. */
  busy: boolean;
  /**
   * Set the policy.
   *
   * @param enforcementEnabled The policy to store.
   * @param reason The recorded reason — only meaningful when turning enforcement off.
   */
  onSetPolicy: (enforcementEnabled: boolean, reason: string) => void;
}

/**
 * Render the enforcement card. See {@link AllowlistEnforcementCardProps}.
 *
 * @returns The card, and the bypass confirm it opens.
 */
export function AllowlistEnforcementCard({
  enforcing,
  policyUpdatedAt,
  busy,
  onSetPolicy,
}: AllowlistEnforcementCardProps) {
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const openConfirm = React.useCallback(() => {
    if (!reason.trim()) {
      setReasonError(BYPASS_REASON_REQUIRED);
      return;
    }
    setReasonError(null);
    setConfirming(true);
  }, [reason]);

  const confirm = bypassConfirm(reason);

  return (
    <>
      <Card aria-label={ENFORCEMENT_TITLE} data-testid="allowlist-enforcement">
        <CardHeader>
          <CardTitle>{ENFORCEMENT_TITLE}</CardTitle>
        </CardHeader>

        <CardContent>
          <p className="wal-enforce__desc">{ENFORCEMENT_DESC}</p>

          {enforcing ? (
            <div className="wal-enforce">
              <FormField
                className="wal-enforce__field"
                label="Reason for bypassing"
                htmlFor="allowlist-bypass-reason"
                error={reasonError ?? undefined}
              >
                <Input
                  id="allowlist-bypass-reason"
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    if (reasonError) setReasonError(null);
                  }}
                  placeholder="Vendor relay delivers from an unpublished address"
                  data-testid="allowlist-bypass-reason"
                />
              </FormField>
              <Button
                variant="outline"
                className="wal-enforce__submit"
                disabled={busy}
                onClick={openConfirm}
                data-testid="allowlist-bypass"
              >
                <ShieldOff aria-hidden />
                Bypass allowlist
              </Button>
            </div>
          ) : (
            <Button
              className="wal-enforce__restore"
              disabled={busy}
              onClick={() => onSetPolicy(true, '')}
              data-testid="allowlist-restore"
            >
              Restore enforcement
            </Button>
          )}

          {policyUpdatedAt ? (
            <p className="wal-enforce__changed" data-testid="allowlist-policy-changed">
              Last changed {formatTimestamp(policyUpdatedAt)}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="allowlist-bypass-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => {
                setConfirming(false);
                onSetPolicy(false, reason.trim());
                setReason('');
              }}
              data-testid="allowlist-bypass-confirm-action"
            >
              {confirm.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default AllowlistEnforcementCard;
