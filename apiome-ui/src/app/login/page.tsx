import { redirect } from 'next/navigation';
import { getAuthSession } from '@lib/auth/server-session';
import { resolveCallbackUrl } from '@lib/auth/cookie-options';
import { resolvePostLoginRouteForUser } from '@lib/auth/post-login-routing';
import { providerSummaries } from '@lib/auth/provider-registry';
import { resolveProviderEnv } from '@lib/auth/provider-config-resolver';
import LoginClient from '@/app/login/LoginClient';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = resolveCallbackUrl(params.callbackUrl);

  const session = await getAuthSession();
  if (session) {
    // Post-login routing rules (OLO-3.3): members land on the allowlisted
    // callbackUrl (or the default tenant dashboard); zero-tenant users land on
    // the default landing where the first-tenant onboarding guard prompts the
    // wizard, regardless of the requested callbackUrl.
    const sessionUser = session.user as { user_id?: string; current_tenant_id?: string };
    if (sessionUser?.user_id) {
      const route = await resolvePostLoginRouteForUser(sessionUser.user_id, {
        lastActiveTenantId: sessionUser.current_tenant_id,
        callbackUrl: params.callbackUrl,
      });
      redirect(route.destination);
    }
    redirect(callbackUrl);
  }

  // Env is server-side only, so the enabled-provider list (provider registry, OLO-2.3)
  // is resolved here and passed down; the client resolves brand icons by id. The registry reads
  // through the DB-over-env merge (OLO-8.5) so a provider enabled only in the admin screen
  // gets its login button too, not just a working OAuth flow.
  const ssoProviders = providerSummaries(await resolveProviderEnv()).filter(
    (provider) => provider.enabled
  );

  return <LoginClient error={params.error} callbackUrl={callbackUrl} ssoProviders={ssoProviders} />;
}
