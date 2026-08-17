'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import { generateTenantSlug, validateTenantSlug } from '@lib/auth/tenant-slug';
import { checkTenantSlugAvailability } from '@lib/auth/tenant-slug-availability';
import { SLUG_CHECK_DEBOUNCE_MS } from '@lib/auth/slug-availability';
import { cn } from '@lib/utils';
import { Button } from '../../ui/Button';
import { FormField } from '../../ui/FormField';
import { Input } from '../../ui/Input';

/**
 * Idle time after the last keystroke before the availability probe fires.
 *
 * Re-exported from the shared slug vocabulary (HIVE-4.3) rather than restated, so this
 * step and the sign-up card cannot debounce differently. HIVE-4.4 replaces the probe
 * below with `useSlugAvailability`, which reads the same constant.
 */
export { SLUG_CHECK_DEBOUNCE_MS };

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
}

/** Live availability state for the slug currently in the field. */
interface SlugAvailability {
  /** The normalized slug this state describes (stale results are discarded). */
  slug: string;
  /** Probe state; `unknown` means the check failed and is advisory only. */
  status: 'checking' | 'available' | 'taken' | 'unknown';
}

/**
 * Second wizard step (OLO-4.1 shell, OLO-4.2 live validation): collects the
 * organization name and URL slug.
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
 */
export function OrganizationStep({
  initialName,
  initialSlug,
  onBack,
  onContinue,
}: OrganizationStepProps) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  // A prefilled slug returned to from a later step counts as user-edited;
  // otherwise typing in the name field would overwrite the chosen slug.
  const [slugEdited, setSlugEdited] = useState(initialSlug.trim() !== '');
  const [errors, setErrors] = useState<{ name?: string; slug?: string }>({});
  const [availability, setAvailability] = useState<SlugAvailability | null>(null);
  const [submitChecking, setSubmitChecking] = useState(false);

  /** Normalized content of the slug field (what the probe and submit use). */
  const normalizedSlug = slug.trim().toLowerCase();
  /** Shape error for the current field value, shown as the user types. */
  const liveSlugError = normalizedSlug ? validateTenantSlug(normalizedSlug) : null;

  /** Debounced availability probe of the slug currently in the field. */
  useEffect(() => {
    if (!normalizedSlug || validateTenantSlug(normalizedSlug)) {
      setAvailability(null);
      return;
    }
    setAvailability({ slug: normalizedSlug, status: 'checking' });
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await checkTenantSlugAvailability(normalizedSlug);
      if (cancelled) return;
      // `invalid` cannot occur here (shape-checked above); treat defensively as unknown.
      const status = result.status === 'invalid' ? 'unknown' : result.status;
      setAvailability({ slug: normalizedSlug, status });
    }, SLUG_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [normalizedSlug]);

  /** Updates the name and, until the slug is hand-edited, its suggestion. */
  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) {
      setSlug(generateTenantSlug(value));
    }
  };

  /** Updates the slug; a cleared field re-enables name-derived suggestions. */
  const handleSlugChange = (value: string) => {
    setSlug(value);
    setSlugEdited(value.trim() !== '');
  };

  /**
   * Validates the form and gates on slug availability; on success normalizes
   * values and calls onContinue. When no fresh availability result exists for
   * the submitted slug, one last probe runs before continuing.
   */
  const handleContinue = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrors({ name: 'Organization name is required' });
      return;
    }

    const effectiveSlug = normalizedSlug || generateTenantSlug(trimmedName);
    const slugError = validateTenantSlug(effectiveSlug);
    if (slugError) {
      // With no entered slug the failure came from deriving one, so the name
      // field is the one the user must fix.
      setErrors(
        normalizedSlug
          ? { slug: slugError }
          : { name: 'Could not derive a URL slug from this name — please add a slug below' }
      );
      return;
    }

    // Reuse the live probe's verdict when it matches the submitted slug;
    // otherwise (still typing, still checking, or slug derived at submit)
    // run one final check now.
    let status =
      availability && availability.slug === effectiveSlug && availability.status !== 'checking'
        ? availability.status
        : null;
    if (!status) {
      setSubmitChecking(true);
      try {
        const result = await checkTenantSlugAvailability(effectiveSlug);
        status = result.status === 'invalid' ? 'unknown' : result.status;
        setAvailability({ slug: effectiveSlug, status });
      } finally {
        setSubmitChecking(false);
      }
    }
    if (status === 'taken') {
      setErrors({ slug: 'This slug is already taken — please choose another' });
      return;
    }

    // `available` continues; `unknown` fails open — provisioning re-checks
    // uniqueness server-side and reports a taken slug on the summary step.
    setErrors({});
    onContinue({ name: trimmedName, slug: effectiveSlug });
  };

  return (
    <div data-testid="onboarding-step-organization">
      <h1
        id="first-tenant-onboarding-title"
        className="text-xl font-bold text-gray-900 dark:text-white"
      >
        Name your organization
      </h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        This becomes your tenant — the workspace your projects and teammates live in.
      </p>
      <form
        className="mt-6 space-y-4 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          void handleContinue();
        }}
      >
        <FormField label="Organization name" required error={errors.name}>
          <Input
            autoFocus
            name="organization-name"
            placeholder="Acme, Inc."
            value={name}
            onChange={(event) => handleNameChange(event.target.value)}
          />
        </FormField>
        <FormField
          label="URL slug"
          error={errors.slug || liveSlugError || undefined}
          helperText="Lowercase letters, numbers, and dashes. Suggested from the name — edit it if you like."
        >
          <Input
            name="organization-slug"
            placeholder="acme-inc"
            aria-invalid={Boolean(errors.slug || liveSlugError) || undefined}
            value={slug}
            onChange={(event) => handleSlugChange(event.target.value)}
          />
          <SlugAvailabilityStatus availability={availability} />
        </FormField>
        <div className="flex justify-between gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onBack}>
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back
          </Button>
          <Button type="submit" disabled={submitChecking}>
            {submitChecking ? 'Checking…' : 'Continue'}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Inline availability feedback under the slug field. Renders nothing until a
 * well-formed slug is being (or has been) probed; announces changes to screen
 * readers via `role="status"`.
 *
 * @param availability The live probe state, or null when idle.
 */
function SlugAvailabilityStatus({ availability }: { availability: SlugAvailability | null }) {
  if (!availability) return null;

  const content = {
    checking: {
      icon: <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />,
      text: 'Checking availability…',
      className: 'text-gray-500 dark:text-gray-400',
    },
    available: {
      icon: <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />,
      text: `"${availability.slug}" is available`,
      className: 'text-emerald-600 dark:text-emerald-400',
    },
    taken: {
      icon: <XCircle aria-hidden="true" className="h-3.5 w-3.5" />,
      text: `"${availability.slug}" is already taken`,
      className: 'text-red-600 dark:text-red-400',
    },
    unknown: {
      icon: <Info aria-hidden="true" className="h-3.5 w-3.5" />,
      text: 'Could not verify availability — you can still continue',
      className: 'text-amber-600 dark:text-amber-400',
    },
  }[availability.status];

  return (
    <p
      role="status"
      data-testid="slug-availability"
      className={cn('flex items-center gap-1.5 text-xs leading-5', content.className)}
    >
      {content.icon}
      {content.text}
    </p>
  );
}
