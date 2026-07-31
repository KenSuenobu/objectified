import { providerSummaries } from '@lib/auth/provider-registry';
import { resolveProviderEnv } from '@lib/auth/provider-config-resolver';
import LinkedAccountsClient from './LinkedAccountsClient';

/**
 * Linked-accounts page (server half).
 *
 * Resolves the deployment's provider availability via the provider registry (OLO-2.3, #4195)
 * over the DB-over-env merge (OLO-8.5) — env is server-side only — and hands the serializable
 * summaries to the client panel, which renders exactly the enabled providers (plus coming-soon
 * teasers).
 */
export default async function LinkedAccountsPage() {
  return <LinkedAccountsClient providers={providerSummaries(await resolveProviderEnv())} />;
}
