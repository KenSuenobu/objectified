'use client';

import { useCallback, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2 } from 'lucide-react';
import { generateTenantSlug, validateTenantSlug } from '@lib/auth/tenant-slug';
import { checkTenantSlugAvailability } from '@lib/auth/tenant-slug-availability';
import { SLUG_CHECK_DEBOUNCE_MS } from '@lib/auth/slug-availability';
import { ICON_SIZE } from '../../ui/iconSizes';
import { Button } from '../../ui/Button';
import { AuthField } from '../AuthField';
import { SlugField } from '../SlugField';
import { useSlugAvailability } from '../useSlugAvailability';

/**
 * Idle time after the last keystroke before the availability probe fires.
 *
 * Re-exported from the shared slug vocabulary (HIVE-4.3) rather than restated, so this
 * step and the sign-up card cannot debounce differently. The probe itself is
 * `useSlugAvailability`, which reads the same constant.
 */
export { SLUG_CHECK_DEBOUNCE_MS };

/** Shown when the reader submits a slug the probe has just found to be taken. */
const SLUG_TAKEN_ERROR = 'This slug is already taken — please choose another';

/** Shown when the name has no characters a slug could be built from. */
const SLUG_UNDERIVABLE_ERROR =
  'Could not derive a URL slug from this name — please add a slug below';

/** Shown when the organization name is left blank. */
const NAME_REQUIRED_ERROR = 'Organization name is required';

/** The rule under the slug control — what the field will accept, and where it comes from. */
const SLUG_HINT =
  'Lowercase letters, numbers, and dashes. Suggested from the name — edit it if you like.';

/**
 * Which chrome the step draws around itself.
 *
 * The step is shared by two hosts: the onboarding wizard, whose card is banded so the
 * actions stay put as the body changes, and `CreateTenantDialog`, which supplies its own
 * padding and would double the wizard's.
 */
export type OrganizationStepChrome = 'wizard' | 'plain';

/** The body band's classes per chrome. */
const BODY_CLASS: Readonly<Record<OrganizationStepChrome, string>> = {
  wizard: 'wiz-card__body',
  plain: '',
};

/** The action band's classes per chrome. */
const FOOT_CLASS: Readonly<Record<OrganizationStepChrome, string>> = {
  wizard: 'wiz-card__foot',
  plain: 'mt-6 flex flex-wrap items-center justify-between gap-2',
};

/** Values the organization step hands back once valid. */
export interface OrganizationStepValues {
  /** Trimmed organization display name. */
  name: string;
  /** Normalized slug (entered, or derived from the name when left blank). */
  slug: string;
}

/** Inputs and callbacks of the organization step. */
export interface OrganizationStepProps {
  /** Name to prefill (from a previous visit to this step). */
  initialName: string;
  /** Slug to prefill (from a previous visit to this step). */
  initialSlug: string;
  /** Return to the welcome step (entered values are kept by the wizard). */
  onBack: () => void;
  /** Advance with validated values. Only called when the form is valid. */
  onContinue: (values: OrganizationStepValues) => void;
  /** Which chrome to draw. Defaults to the wizard's card bands. */
  chrome?: OrganizationStepChrome;
}

/**
 * Second wizard step (OLO-4.1 shell, OLO-4.2 live validation, re-skinned by
 * HIVE-4.4 #5298): collects the organization name and URL slug.
 *
 * Authority: `docs/mockups/auth/onboarding.html`, step 2.
 *
 * As the name is typed a slug suggestion is derived into the slug field, which
 * stays editable; once the user edits the slug the suggestion stops overwriting
 * it (clearing the field re-enables suggestions). The slug is shape-validated
 * live (`validateTenantSlug`, the same rule the server re-applies) and, once
 * well-formed, probed for availability against `HEAD /v1/tenants/{slug}` after
 * a {@link SLUG_CHECK_DEBOUNCE_MS} debounce.
 *
 * A slug known to be taken blocks Continue. If no fresh availability result
 * exists at submit time, one final probe runs; an `unknown` result fails open
 * (provisioning still enforces uniqueness server-side).
 *
 * The probe, its debounce and the four states it draws are now the shared
 * `useSlugAvailability` + `SlugField` pair built for the OAuth sign-up card
 * (HIVE-4.3) — the two places in the product where a tenant is named. The
 * sentences that pair announces are this step's own, so nothing it says changed.
 *
 * Neither control is a native `required` field: the browser would refuse an empty
 * submit before {@link NAME_REQUIRED_ERROR} and {@link SLUG_UNDERIVABLE_ERROR}
 * could ever be shown, and those two messages are the ones that tell the reader
 * *which* field to fix. The asterisk and `aria-required` say the same thing
 * without taking the validation away.
 *
 * @param props Prefill values, the two callbacks and the chrome — see
 *   {@link OrganizationStepProps}.
 * @returns The step's body band and its action band.
 */
export function OrganizationStep({
  initialName,
  initialSlug,
  onBack,
  onContinue,
  chrome = 'wizard',
}: OrganizationStepProps) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  // A prefilled slug returned to from a later step counts as user-edited;
  // otherwise typing in the name field would overwrite the chosen slug.
  const [slugEdited, setSlugEdited] = useState(initialSlug.trim() !== '');
  const [errors, setErrors] = useState<{ name?: string; slug?: string }>({});
  const [submitChecking, setSubmitChecking] = useState(false);

  /** Normalized content of the slug field (what the probe and submit use). */
  const normalizedSlug = slug.trim().toLowerCase();
  /** Shape error for the current field value, shown as the user types. */
  const liveSlugError = normalizedSlug ? validateTenantSlug(normalizedSlug) : null;

  // The wizard's reader is signed in, so the probe identifies them from the session —
  // unlike the sign-up card's, which has only a pending-signup token to prove itself with.
  const probe = useCallback((candidate: string) => checkTenantSlugAvailability(candidate), []);
  const { availability, resolve } = useSlugAvailability(slug, probe);

  /**
   * Update the name and, until the slug is hand-edited, its suggestion.
   *
   * @param value The new organization name.
   */
  const handleNameChange = (value: string) => {
    setName(value);
    // A changed name clears both messages: its own, and any error about a slug that was
    // derived from the name it just replaced.
    setErrors({});
    if (!slugEdited) {
      setSlug(generateTenantSlug(value));
    }
  };

  /**
   * Update the slug; a cleared field re-enables name-derived suggestions.
   *
   * @param value The new slug (already lowercased by {@link SlugField}).
   */
  const handleSlugChange = (value: string) => {
    setSlug(value);
    setSlugEdited(value.trim() !== '');
    setErrors((previous) => ({ ...previous, slug: undefined }));
  };

  /**
   * Validate the form and gate on slug availability; on success normalize the
   * values and call `onContinue`. When no landed availability result exists for
   * the submitted slug, `resolve` runs one last probe before continuing.
   */
  const handleContinue = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrors({ name: NAME_REQUIRED_ERROR });
      return;
    }

    const effectiveSlug = normalizedSlug || generateTenantSlug(trimmedName);
    const slugError = validateTenantSlug(effectiveSlug);
    if (slugError) {
      // With no entered slug the failure came from deriving one, so the name
      // field is the one the user must fix.
      setErrors(normalizedSlug ? { slug: slugError } : { name: SLUG_UNDERIVABLE_ERROR });
      return;
    }

    setSubmitChecking(true);
    let status;
    try {
      status = await resolve(effectiveSlug);
    } finally {
      setSubmitChecking(false);
    }
    if (status === 'taken') {
      setErrors({ slug: SLUG_TAKEN_ERROR });
      return;
    }

    // `available` continues; `unknown` fails open — provisioning re-checks
    // uniqueness server-side and reports a taken slug on the summary step.
    setErrors({});
    onContinue({ name: trimmedName, slug: effectiveSlug });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleContinue();
      }}
    >
      <div className={BODY_CLASS[chrome]} data-testid="onboarding-step-organization">
        <h1 id="first-tenant-onboarding-title" className="auth-title">
          Name your organization
        </h1>
        <p className="auth-sub mt-1">
          This becomes your tenant — the workspace your projects and teammates live in.
        </p>

        <div className="mt-5 flex flex-col gap-4 text-left">
          <AuthField
            id="organization-name"
            label={
              <>
                Organization name{' '}
                <span className="text-danger-fg" aria-hidden="true">
                  *
                </span>
              </>
            }
            icon={<Building2 size={ICON_SIZE.dense} aria-hidden="true" />}
            name="organization-name"
            autoComplete="organization"
            placeholder="Acme, Inc."
            aria-required="true"
            autoFocus
            value={name}
            error={errors.name}
            onChange={(event) => handleNameChange(event.target.value)}
          />

          <SlugField
            id="organization-slug"
            name="organization-slug"
            label="URL slug"
            hint={SLUG_HINT}
            placeholder="acme-inc"
            value={slug}
            onChange={handleSlugChange}
            availability={availability}
            error={errors.slug || liveSlugError || undefined}
          />
        </div>
      </div>

      <div className={FOOT_CLASS[chrome]}>
        <Button type="button" variant="outline" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={submitChecking}>
          {submitChecking ? 'Checking…' : 'Continue'}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}
