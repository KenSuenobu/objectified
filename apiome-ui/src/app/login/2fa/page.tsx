import { resolveCallbackUrl } from '@lib/auth/cookie-options';
import TwoFactorClient from '@/app/login/2fa/TwoFactorClient';

/**
 * Login second step — TOTP verify after password sign-in returns `twoFactorRedirect`
 * (OLO-9.13 #5014). No full session exists yet; only Better Auth's short-lived 2FA cookie.
 */
export default async function TwoFactorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = resolveCallbackUrl(params.callbackUrl);

  return <TwoFactorClient callbackUrl={callbackUrl} error={params.error} />;
}
