/**
 * The tenant-slug availability vocabulary, shared by every surface that asks
 * "is this slug free?" (HIVE-4.3, #5297).
 *
 * Two surfaces ask, from opposite sides of the sign-in line: the first-tenant
 * onboarding wizard (signed in, `checkTenantSlugAvailability`) and OAuth
 * self-signup (not signed in yet, `checkOauthSignupSlugAvailability`). They
 * reach different back-ends because they carry different credentials, but they
 * answer with the same four words — which is what lets one field component
 * (`components/auth/SlugField`) render both.
 *
 * Pure and dependency-free: importable from server actions and client
 * components alike. Nothing here talks to a database or the network.
 */

/**
 * What a probe can conclude about a candidate slug:
 * - `available` — no tenant uses it.
 * - `taken` — a tenant already does.
 * - `invalid` — it fails shape validation; `error` carries the message.
 * - `unknown` — the check could not be completed (back-end unreachable, the
 *   caller's credentials did not resolve, an unexpected status). Callers **fail
 *   open**: tenant provisioning re-enforces uniqueness when the form is
 *   submitted, so an unverifiable slug never blocks the reader.
 */
export type SlugAvailabilityStatus = 'available' | 'taken' | 'invalid' | 'unknown';

/** A probe's verdict on one candidate slug. */
export interface SlugAvailabilityResult {
  /** The verdict — see {@link SlugAvailabilityStatus}. */
  status: SlugAvailabilityStatus;
  /** Validation message when `status` is `invalid`. */
  error?: string;
}

/**
 * A function that decides whether a slug is free.
 *
 * Both concrete probes satisfy it, which is the point: the field takes the
 * probe as a prop rather than importing one, so the same component serves the
 * signed-out sign-up card and the signed-in onboarding wizard.
 *
 * @param slug Candidate slug (probes normalize case/whitespace themselves).
 * @returns The verdict; a probe never throws — failures degrade to `unknown`.
 */
export type SlugAvailabilityProbe = (slug: string) => Promise<SlugAvailabilityResult>;

/**
 * Idle time after the last keystroke before the availability probe fires.
 *
 * Long enough that typing a slug is one request rather than one per character,
 * short enough that the verdict lands before the reader reaches the button.
 */
export const SLUG_CHECK_DEBOUNCE_MS = 400;
