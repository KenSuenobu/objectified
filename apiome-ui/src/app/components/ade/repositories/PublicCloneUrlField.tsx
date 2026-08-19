'use client';

/**
 * The "Public clone URL" card (HIVE-7.4, #5321).
 *
 * Authority: `docs/mockups/sources/repository-new.html` card 4 (`.field` + `.hint` + the
 * `--ok-fg` result line), and the mockup's footnote listing the four Test outcomes.
 *
 * ### "Public-URL test gives real feedback" — the ticket's second acceptance criterion
 *
 * The screen this replaces printed one tinted sentence and left it at that, which fails the
 * criterion in three ways a reader actually hits:
 *
 * 1. **Nothing said the URL was untested.** The field looked identical before the first Test
 *    and after a passing one, so the disabled Continue button had no visible cause. There is
 *    now a permanent status line, and its first state is {@link URL_TEST_UNTESTED}.
 * 2. **The result was not announced.** It appeared silently in the DOM; the toast was the only
 *    thing a screen reader heard, and toasts do not persist. The line is a `role="status"` live
 *    region, so the outcome reaches every reader in the place the answer belongs.
 * 3. **A passing result outlived the URL it was about.** Clearing on change is the *screen's*
 *    job (it owns the state), but the rule it enforces is {@link addRepositoryBlocker}'s: a
 *    URL may only be submitted while a passing test for that exact string is standing.
 *
 * The tone comes from `urlTestTone` — the shared status vocabulary — and lands on the line as
 * `data-tone`, which `globals.css` paints as a **tinted strip**: the `-soft` ground with the
 * `-fg` ink that was calibrated against it. Not `--ok-fg` as bare text on the card, which is
 * what the mockup draws and what measures 1.5–3.5:1 in the six themes that inherit the light
 * semantic pairs — the exposure HIVE-7.3 recorded and this block does not repeat. The untested
 * state is `--fg-muted` on `--bg-inset` (5.02:1 worst-of-nine) for the same reason.
 */

import * as React from 'react';
import { CircleCheck, CircleX, CircleDashed } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import { Spinner } from '@/app/components/ui/Spinner';

import {
  URL_FIELD_HINT,
  URL_FIELD_LABEL,
  URL_FIELD_PLACEHOLDER,
  URL_TEST_BUSY_LABEL,
  URL_TEST_LABEL,
  URL_TEST_UNTESTED,
  urlTestTone,
  type UrlTestResult,
} from './addRepositoryModel';

/** The field's id, so the label, the hint and the status line all point at one control. */
const URL_FIELD_ID = 'repo-clone-url';

export interface PublicCloneUrlFieldProps {
  /** What the reader has typed. */
  value: string;
  /** Called as they type. Clearing {@link PublicCloneUrlFieldProps.result} is the caller's job. */
  onChange: (next: string) => void;
  /** Run the reachability check. */
  onTest: () => void;
  /** The check is in flight. */
  testing: boolean;
  /** The outcome of the last check for this exact URL, or null when there has been none. */
  result: UrlTestResult | null;
}

/**
 * Render the URL field, its Test button and the standing result line.
 *
 * @param props See {@link PublicCloneUrlFieldProps}.
 * @returns The field and its status line.
 */
export function PublicCloneUrlField({
  value,
  onChange,
  onTest,
  testing,
  result,
}: PublicCloneUrlFieldProps) {
  const tone = result ? urlTestTone(result) : 'neutral';
  const Glyph = result ? (result.ok ? CircleCheck : CircleX) : CircleDashed;

  return (
    <>
      <FormField label={URL_FIELD_LABEL} htmlFor={URL_FIELD_ID} helperText={URL_FIELD_HINT}>
        <div className="repo-new-url">
          <Input
            id={URL_FIELD_ID}
            type="url"
            inputMode="url"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={URL_FIELD_PLACEHOLDER}
            className="mono repo-new-url__input"
            data-testid="repo-clone-url"
          />
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={testing || !value.trim()}
            aria-busy={testing}
            className="repo-new-url__test"
            data-testid="repo-clone-url-test"
          >
            {testing ? <Spinner size="sm" aria-hidden /> : null}
            {testing ? URL_TEST_BUSY_LABEL : URL_TEST_LABEL}
          </Button>
        </div>
      </FormField>

      <p
        role="status"
        aria-live="polite"
        data-tone={tone}
        data-testid="repo-clone-url-result"
        className="repo-new-url__result"
      >
        <Glyph className="repo-new-url__result-glyph" aria-hidden />
        {result ? result.message : URL_TEST_UNTESTED}
      </p>
    </>
  );
}

export default PublicCloneUrlField;
