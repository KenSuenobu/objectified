'use server';

// Imported via the alias so the jest `auth/server-session` mock mapping
// applies (a relative `./server-session` would pull the real Better Auth / DB stack into tests).
import { getAuthSession } from '@lib/auth/server-session';
import { provisionFirstTenantViaRest } from './first-tenant-provisioning';

/** Outcome of {@link provisionFirstTenant}. */
export type ProvisionFirstTenantResult =
  | {
      success: true;
      /** The newly created tenant, ready to be activated in the session. */
      tenant: { id: string; name: string; slug: string };
    }
  | { success: false; error: string };

/**
 * Create the authenticated user's first tenant from the onboarding wizard
 * (OLO-4.1, #4205) via the atomic REST endpoint
 * `POST /v1/onboarding/first-tenant` (OLO-4.3, #4207).
 *
 * The endpoint provisions everything in one transaction (tenant, active
 * membership, Owner role, free-tier entitlements, best-effort sample
 * project), so there is no compensation logic here and no partially created
 * tenant to clean up.
 *
 * Misuse safeguards:
 * - The user id comes from the server session, never from the client.
 * - Name/slug are re-validated server-side, and the endpoint enforces slug
 *   uniqueness and the caller's `max_tenants` entitlement inside the
 *   transaction — a second tab or stale wizard prompt cannot create extra
 *   tenants (403 `tenant-cap-reached`, OLO-5.3).
 *
 * @param orgNameInput Organization display name entered in the wizard.
 * @param slugInput Optional slug; when blank one is derived from the name.
 * @returns The created tenant, or a human-readable error.
 */
export async function provisionFirstTenant(
  orgNameInput: string,
  slugInput: string
): Promise<ProvisionFirstTenantResult> {
  const session = await getAuthSession();
  const user = session?.user as
    | { user_id?: string; email?: string | null; name?: string | null }
    | undefined;
  if (!user?.user_id) {
    return { success: false, error: 'Your session has expired. Please sign in again.' };
  }

  const result = await provisionFirstTenantViaRest(
    { user_id: user.user_id, email: user.email, name: user.name },
    orgNameInput,
    slugInput
  );

  if (!result.success && result.code === 'tenant-cap-reached') {
    // The wizard only prompts at zero memberships, so hitting the cap here
    // means a membership appeared since the prompt (another tab, an invite).
    return {
      success: false,
      error:
        'Your account already belongs to a tenant. Use "Check again" to continue to your dashboard.',
    };
  }

  return result;
}

/**
 * Create an additional tenant from the header's tenant switcher (OLO-6.1,
 * #4218) via the same atomic endpoint as {@link provisionFirstTenant} — REST
 * explicitly provisions "the first tenant (or next, when the entitlement
 * allows more than one)".
 *
 * The switcher entry is already cap-gated client-side, but the transaction
 * re-enforces `max_tenants` (OLO-5.3); the 403 `tenant-cap-reached` here is
 * therefore worded as upgrade guidance rather than the wizard's
 * "already belongs to a tenant" copy.
 *
 * @param orgNameInput Organization display name entered in the dialog.
 * @param slugInput Optional slug; when blank one is derived from the name.
 * @returns The created tenant, or a human-readable error.
 */
export async function provisionAdditionalTenant(
  orgNameInput: string,
  slugInput: string
): Promise<ProvisionFirstTenantResult> {
  const session = await getAuthSession();
  const user = session?.user as
    | { user_id?: string; email?: string | null; name?: string | null }
    | undefined;
  if (!user?.user_id) {
    return { success: false, error: 'Your session has expired. Please sign in again.' };
  }

  const result = await provisionFirstTenantViaRest(
    { user_id: user.user_id, email: user.email, name: user.name },
    orgNameInput,
    slugInput
  );

  if (!result.success && result.code === 'tenant-cap-reached') {
    return {
      success: false,
      error:
        "You've reached your plan's tenant limit. Upgrade your plan to create more tenants.",
    };
  }

  return result;
}
