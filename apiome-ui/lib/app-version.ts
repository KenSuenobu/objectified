/**
 * The build string this app reports to the reader (HIVE-3.4, #5290).
 *
 * One version string is printed in two places that must never disagree: the top bar's
 * version badge (until HIVE-3.8 retires it) and the rail user menu's footer. Both used to
 * derive it from `package.json` and `NEXT_PUBLIC_APP_BUILD_LABEL` inline, which is a
 * duplication that only shows up as a bug — two surfaces claiming different builds — long
 * after the copy has drifted.
 *
 * It is also the key the "What's new" unread dot is decided by
 * (`src/app/components/shell/whatsNewSeen.ts`): "the reader has seen this build's notes"
 * is a statement about exactly this string.
 *
 * `NEXT_PUBLIC_*` is inlined by Next.js at build time, so this module is safe on the
 * server and in the client bundle alike.
 */
import packageJson from '../package.json';

/** Semantic version from `package.json`, e.g. `0.241.0`. */
export const APP_VERSION: string = packageJson.version;

/**
 * Optional CI/build stamp, e.g. `2026.05.05-84a231c`.
 *
 * `undefined` when unset *or* set to whitespace, so a blank value in a `.env` file reads
 * as "not stamped" rather than as an empty badge.
 */
export const APP_BUILD_LABEL: string | undefined =
  process.env.NEXT_PUBLIC_APP_BUILD_LABEL?.trim() || undefined;

/**
 * What the reader sees: the CI stamp when there is one, otherwise `v<semver> RC`.
 *
 * The `RC` suffix is what an unstamped local or preview build has always said, and the
 * mockups print it verbatim (`docs/mockups/assets/hive.js`, `v0.241.0 RC`).
 */
export const APP_VERSION_BADGE: string = APP_BUILD_LABEL ?? `v${APP_VERSION} RC`;
