import { getAuthSession } from '@lib/auth/server-session';
import { getCommercialAccessForSession } from '@lib/db/commercial-access';
import { getLauncherSummaryForSession } from '@lib/db/launcher-summary';
import AdeHome from '@/app/components/ade/AdeHome';

/**
 * The `/ade` launcher route.
 *
 * Everything the launcher shows that is not in the session is resolved here, on the server:
 * the entitlement-filtered commercial cards and the hero's summary chips. Both are skipped
 * entirely when there is no signed-in user, so a signed-out render costs no round-trips.
 *
 * @returns The launcher, with its host-injected cards and summary.
 */
export default async function AdePage() {
  const session = await getAuthSession();
  const signedIn = session?.user != null;

  const [commercial, summary] = await Promise.all([
    signedIn
      ? getCommercialAccessForSession()
      : Promise.resolve({ entitledFlags: [], homeCards: [] }),
    signedIn ? getLauncherSummaryForSession() : Promise.resolve(undefined),
  ]);

  return (
    <AdeHome
      commercialHomeCards={commercial.homeCards}
      entitledFeatureFlags={commercial.entitledFlags}
      summary={summary}
    />
  );
}
