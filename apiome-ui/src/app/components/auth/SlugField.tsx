'use client';

import * as React from 'react';
import { Check, Hash, Info, Loader2, X } from 'lucide-react';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { Badge, type BadgeTone } from '@/app/components/ui/Badge';
import { AuthField } from './AuthField';
import type { SlugAvailability, SlugFieldStatus } from './useSlugAvailability';

/**
 * The default name of the field, and the rule under it. Both are the strings the
 * OAuth sign-up card carried before HIVE-4.3 and the onboarding wizard carries
 * today, so neither surface changes what it says by adopting this component.
 */
export const SLUG_FIELD_LABEL = 'Organization URL slug';
export const SLUG_FIELD_HINT =
  'Lowercase letters, numbers, and dashes only. Used in API paths for your organization.';

/** How one availability state is drawn and announced. */
interface StatusPresentation {
  /** The chip's tone. */
  tone: BadgeTone;
  /** The chip's word — short, because the chip sits inside the control's box. */
  chip: string;
  /** The chip's glyph. */
  icon: React.ReactNode;
  /**
   * The sentence read out when this state arrives.
   *
   * @param slug The slug the state is about.
   * @returns The full sentence.
   */
  announce: (slug: string) => string;
}

/**
 * The four states, in one table.
 *
 * The announced sentences are the onboarding wizard's own (OLO-4.2) — the shared
 * component exists so both surfaces say the same thing, and the wizard's strings
 * are the ones already in the product.
 */
const STATUS_PRESENTATION: Readonly<Record<SlugFieldStatus, StatusPresentation>> = {
  checking: {
    tone: 'neutral',
    chip: 'Checking',
    icon: <Loader2 className="animate-spin" aria-hidden="true" />,
    announce: () => 'Checking availability…',
  },
  available: {
    tone: 'ok',
    chip: 'Available',
    icon: <Check aria-hidden="true" />,
    announce: (slug) => `"${slug}" is available`,
  },
  taken: {
    tone: 'danger',
    chip: 'Taken',
    icon: <X aria-hidden="true" />,
    announce: (slug) => `"${slug}" is already taken`,
  },
  unknown: {
    tone: 'warn',
    chip: 'Unverified',
    icon: <Info aria-hidden="true" />,
    announce: () => 'Could not verify availability — you can still continue',
  },
};

/** Inputs of {@link SlugField}. */
export interface SlugFieldProps {
  /** The control's `id`; the label points at it and callers query the page by it. */
  id: string;
  /** The field's visible name. Defaults to {@link SLUG_FIELD_LABEL}. */
  label?: React.ReactNode;
  /** The slug currently in the field. */
  value: string;
  /**
   * The reader typed. The value handed back is already lowercased — the column
   * stores lowercase and the URL is case-insensitive, so the field never shows
   * something the server will silently change.
   *
   * @param value The new slug.
   */
  onChange: (value: string) => void;
  /** The live probe state from `useSlugAvailability`, or null when there is nothing to say. */
  availability: SlugAvailability | null;
  /** What went wrong with this field — a shape error, or a rejection from the server. */
  error?: string;
  /** The rule under the control. Defaults to {@link SLUG_FIELD_HINT}. */
  hint?: React.ReactNode;
  /** The control's placeholder. */
  placeholder?: string;
  /** Disable the control while the form is submitting. */
  disabled?: boolean;
  /** The control's form field name. */
  name?: string;
  /** Mark the control required. */
  required?: boolean;
  /**
   * The origin the organization will be reachable at, e.g. `browse.apiome.dev/`.
   * Omit for no preview line.
   */
  previewBase?: string;
  /** An illustrative path under the slug, e.g. `payments-api`. Ignored without `previewBase`. */
  previewSuffix?: string;
  /** Extra classes on the field wrapper. */
  className?: string;
  /** Test hook on the control. */
  'data-testid'?: string;
}

/**
 * SlugField — the organization URL slug, with live availability (HIVE-4.3, #5297).
 *
 * Authority: `docs/mockups/auth/signup-oauth.html` (the chip inside the box and the
 * URL preview under it) and `docs/mockups/assets/hive.css` §9 (`.input-suffix`).
 *
 * Built here for the OAuth sign-up card and reused by the onboarding wizard
 * (HIVE-4.4) — the two places a tenant is named. It is deliberately presentational:
 * the probe and its debounce live in {@link useSlugAvailability}, so each surface
 * keeps its own way of asking (the wizard is signed in and asks REST; sign-up is not
 * and asks through its pending-signup token) while both draw the same four states.
 *
 * The chip is `aria-hidden` and a visually-hidden `role="status"` carries the full
 * sentence: a two-word chip is what a sighted reader can take in beside their own
 * typing, and a sentence is what a screen-reader user needs — the same information
 * twice, not two different readouts. Both are advisory. `unknown` never blocks
 * submission, because the uniqueness rule is enforced when the tenant is created.
 *
 * @param props See {@link SlugFieldProps}.
 * @returns The labelled slug field, its availability readout and its URL preview.
 */
export function SlugField({
  id,
  label = SLUG_FIELD_LABEL,
  value,
  onChange,
  availability,
  error,
  hint = SLUG_FIELD_HINT,
  placeholder,
  disabled,
  name,
  required,
  previewBase,
  previewSuffix,
  className,
  'data-testid': testId,
}: SlugFieldProps) {
  const state = availability ? STATUS_PRESENTATION[availability.status] : null;

  return (
    <div className="flex flex-col gap-1.5">
      <AuthField
        id={id}
        className={className ? `auth-slug ${className}` : 'auth-slug'}
        label={label}
        icon={<Hash size={ICON_SIZE.dense} aria-hidden="true" />}
        hint={hint}
        error={error}
        // The chip is decoration over the live region below, so it is hidden from
        // assistive technology rather than announced a second time in two words.
        suffix={
          state && (
            <Badge variant={state.tone} aria-hidden="true" data-testid="slug-availability-chip">
              {state.icon}
              {state.chip}
            </Badge>
          )
        }
        name={name}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        data-testid={testId}
      />

      {/* The announcement. Always mounted, so a screen reader hears each change
          rather than the region being introduced and read once. */}
      <span className="sr-only" role="status" aria-live="polite" data-testid="slug-availability">
        {state && availability ? state.announce(availability.slug) : ''}
      </span>

      {/* What the reader is choosing, spelled out: the slug is a URL, and a URL is
          easier to judge than a word in a box. `aria-hidden`, because the field's
          label and hint already say what it is for. */}
      {previewBase && (
        <div className="auth-slug-preview" aria-hidden="true" data-testid="slug-preview">
          {previewBase}
          <b>{value || placeholder || ''}</b>
          {previewSuffix ? `/${previewSuffix}` : ''}
        </div>
      )}
    </div>
  );
}

export default SlugField;
