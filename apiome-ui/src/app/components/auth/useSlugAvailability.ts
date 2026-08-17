'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SLUG_CHECK_DEBOUNCE_MS,
  type SlugAvailabilityProbe,
} from '@lib/auth/slug-availability';
import { validateTenantSlug } from '@lib/auth/tenant-slug';

/**
 * The state a slug field can show (HIVE-4.3, #5297).
 *
 * The probe vocabulary minus `invalid` — a mis-shaped slug is a validation
 * error under the field, not an availability verdict — plus `checking`, which
 * only a live field has.
 */
export type SlugFieldStatus = 'checking' | 'available' | 'taken' | 'unknown';

/** A settled verdict — everything except "still asking". */
export type SettledSlugStatus = Exclude<SlugFieldStatus, 'checking'>;

/** A verdict, bound to the slug it is about, so a stale one is recognisable. */
export interface SlugAvailability {
  /** The normalized slug this state describes. */
  slug: string;
  /** Where the probe for that slug got to. */
  status: SlugFieldStatus;
}

/** A probe result that has landed. */
interface SettledAvailability {
  /** The normalized slug this verdict is about. */
  slug: string;
  /** What the probe concluded. */
  status: SettledSlugStatus;
}

/** What {@link useSlugAvailability} hands back. */
export interface UseSlugAvailability {
  /** The live state for whatever is in the field, or `null` when there is nothing to say. */
  availability: SlugAvailability | null;
  /**
   * Settle a verdict for `candidate` now, for the moment the form is submitted.
   *
   * Reuses the landed result when it is about this same slug; otherwise runs one
   * more probe and records it. Callers gate on `taken` and let `unknown` through
   * — see {@link SlugAvailabilityProbe}.
   *
   * @param candidate The slug being submitted (normalized here).
   * @returns The settled status.
   */
  resolve: (candidate: string) => Promise<SettledSlugStatus>;
}

/**
 * Debounced tenant-slug availability, shared by the sign-up card and the
 * onboarding wizard (HIVE-4.3, #5297 — reused by HIVE-4.4).
 *
 * Watches the slug currently in the field and, once it is well-shaped, asks
 * `probe` after {@link SLUG_CHECK_DEBOUNCE_MS} of quiet.
 *
 * Only *landed* verdicts are stored, each tagged with the slug it is about;
 * `checking` and "nothing to say" are derived from the field's own value rather
 * than written into state. That is what makes a stale answer harmless — a slow
 * reply about `acm` is simply never the verdict for `acme` — and it keeps the
 * effect free of the synchronous `setState` that turns one keystroke into a
 * cascade of renders.
 *
 * Nothing here blocks the reader: `unknown` is a "could not check", never a
 * "no". The uniqueness rule is enforced when the tenant is actually created.
 *
 * @param slug The raw field value (trimmed and lowercased here).
 * @param probe How to ask; see {@link SlugAvailabilityProbe}.
 * @returns The live state and a submit-time {@link UseSlugAvailability.resolve}.
 */
export function useSlugAvailability(
  slug: string,
  probe: SlugAvailabilityProbe
): UseSlugAvailability {
  const [settled, setSettled] = useState<SettledAvailability | null>(null);
  const normalizedSlug = (slug ?? '').trim().toLowerCase();

  // The probe is typically an inline arrow at the call site, so a new identity
  // arrives on every render. Reading it through a ref is what stops the debounce
  // from restarting on each render and never firing.
  const probeRef = useRef(probe);
  useEffect(() => {
    probeRef.current = probe;
  }, [probe]);

  /**
   * Ask about one slug and record the answer.
   *
   * @param candidate A slug already known to be well-shaped.
   * @returns The settled status.
   */
  const runProbe = useCallback(async (candidate: string): Promise<SettledSlugStatus> => {
    const result = await probeRef.current(candidate);
    // `invalid` cannot occur for a shape-checked slug; treated defensively as
    // "could not check" rather than asserted away.
    const status: SettledSlugStatus = result.status === 'invalid' ? 'unknown' : result.status;
    setSettled({ slug: candidate, status });
    return status;
  }, []);

  useEffect(() => {
    // Nothing to probe: an empty field, or one whose contents could not be a
    // slug at all — the shape error under the field already says why.
    if (!normalizedSlug || validateTenantSlug(normalizedSlug)) return;

    const timer = setTimeout(() => {
      void runProbe(normalizedSlug);
    }, SLUG_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [normalizedSlug, runProbe]);

  const availability: SlugAvailability | null =
    !normalizedSlug || validateTenantSlug(normalizedSlug)
      ? null
      : settled && settled.slug === normalizedSlug
        ? settled
        : { slug: normalizedSlug, status: 'checking' };

  const resolve = useCallback(
    async (candidate: string): Promise<SettledSlugStatus> => {
      const target = (candidate ?? '').trim().toLowerCase();
      // A landed verdict about this exact slug is the answer. Anything else —
      // still checking, or a slug derived at submit time that was never in the
      // field — needs its own.
      if (settled && settled.slug === target) return settled.status;
      return runProbe(target);
    },
    [settled, runProbe]
  );

  return { availability, resolve };
}
