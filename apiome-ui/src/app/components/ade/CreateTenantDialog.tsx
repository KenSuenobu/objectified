'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { provisionAdditionalTenant } from '@lib/auth/first-tenant-actions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog';
import {
  OrganizationStep,
  type OrganizationStepValues,
} from '../auth/onboarding/OrganizationStep';

/** The tenant a successful creation hands back to the caller. */
export interface CreatedTenant {
  /** New tenant id, ready to activate in the session. */
  id: string;
  /** Display name. */
  name: string;
  /** URL slug. */
  slug: string;
}

/** Inputs and callbacks of the create-tenant dialog. */
export interface CreateTenantDialogProps {
  /** Whether the dialog is shown. */
  open: boolean;
  /** Radix-style open/close callback (backdrop, Escape, close button). */
  onOpenChange: (open: boolean) => void;
  /** Called with the new tenant after successful provisioning. */
  onCreated: (tenant: CreatedTenant) => void;
}

/**
 * "Create tenant" dialog opened from the header tenant switcher (OLO-6.1,
 * #4218).
 *
 * Reuses the onboarding wizard's {@link OrganizationStep} (name + live
 * slug validation/availability, OLO-4.2) and provisions through
 * `provisionAdditionalTenant`, the same atomic REST endpoint as the
 * first-tenant wizard — the OLO-5.3 tenant-cap is re-enforced inside that
 * transaction, so a stale menu (cap reached in another tab) fails with
 * upgrade guidance rather than creating an extra tenant.
 */
export function CreateTenantDialog({ open, onOpenChange, onCreated }: CreateTenantDialogProps) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');

  // A reopened dialog starts fresh rather than resuming a failed attempt.
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setError(null);
      setOrgName('');
      setSlug('');
    }
  }, [open]);

  /** Provisions the tenant; success closes via the parent, failure re-shows the form. */
  const handleContinue = async (values: OrganizationStepValues) => {
    setOrgName(values.name);
    setSlug(values.slug);
    setCreating(true);
    setError(null);
    try {
      const result = await provisionAdditionalTenant(values.name, values.slug);
      if (result.success) {
        onCreated(result.tenant);
      } else {
        setError(result.error);
      }
    } catch (creationError) {
      console.error('[CreateTenantDialog] provisioning failed:', creationError);
      setError('Something went wrong while creating the tenant. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent data-testid="create-tenant-dialog">
        <DialogHeader>
          <DialogTitle>Create a tenant</DialogTitle>
          <DialogDescription>
            A new workspace for projects and teammates. You can switch between your tenants from
            the header at any time.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p
            role="alert"
            data-testid="create-tenant-error"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        )}
        {creating ? (
          <div
            role="status"
            data-testid="create-tenant-creating"
            className="flex items-center justify-center gap-2 py-10 text-sm text-gray-600 dark:text-gray-300"
          >
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            Creating your tenant…
          </div>
        ) : (
          <OrganizationStep
            // The dialog supplies its own padding; the wizard's card bands would
            // double it and draw a hairline across the middle of the sheet.
            chrome="plain"
            initialName={orgName}
            initialSlug={slug}
            onBack={() => onOpenChange(false)}
            onContinue={handleContinue}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CreateTenantDialog;
