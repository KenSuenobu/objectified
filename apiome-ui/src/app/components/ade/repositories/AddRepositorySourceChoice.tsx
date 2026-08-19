'use client';

/**
 * "Where does the repository live?" — the two source cards (HIVE-7.4, #5321).
 *
 * Authority: `docs/mockups/sources/repository-new.html` card 1 (`.src-option`), whose copy the
 * mockup's **Keeps (1:1)** list pins verbatim.
 *
 * ### Why these are real radios
 *
 * The mockup draws `<button role="radio">`, which is a shape rather than a control: a button
 * with `role="radio"` has to implement roving tabstops, arrow keys, Home/End and Space itself,
 * and the screen this replaces implemented none of them — its cards were `<label>`s wrapping a
 * radio whose only keyboard affordance was Tab, so a keyboard reader could not move between the
 * two choices at all. `ui/RadioGroup` renders native inputs inside labels, so the browser
 * supplies the whole interaction and "2 of 2" is announced without a line of ARIA here.
 *
 * The card's chrome — the accent ring, the tinted ground, the leading tile — is
 * `.repo-new-source` in `globals.css`, so it follows every theme, density and font scale.
 */

import * as React from 'react';
import { Globe, UserCheck } from 'lucide-react';

import { RadioGroup, RadioGroupItem } from '@/app/components/ui/RadioGroup';
import { cn } from '@lib/utils';

import {
  ADD_REPOSITORY_SOURCES,
  isAddRepositorySource,
  type AddRepositorySource,
} from './addRepositoryModel';

/** The glyph each source card leads with, matching the mockup's lucide names. */
const SOURCE_ICON: Readonly<
  Record<AddRepositorySource, React.ComponentType<{ 'aria-hidden'?: boolean }>>
> = {
  linked: UserCheck,
  public_url: Globe,
};

export interface AddRepositorySourceChoiceProps {
  /** Which card is selected. */
  value: AddRepositorySource;
  /** Called with the newly selected card's id. */
  onChange: (next: AddRepositorySource) => void;
}

/**
 * Render the two source cards. See {@link AddRepositorySourceChoiceProps}.
 *
 * @returns A radio group of two cards.
 */
export function AddRepositorySourceChoice({ value, onChange }: AddRepositorySourceChoiceProps) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => {
        if (isAddRepositorySource(next)) onChange(next);
      }}
      aria-label="Repository source"
      className="repo-new-sources"
    >
      {ADD_REPOSITORY_SOURCES.map((option) => {
        const Icon = SOURCE_ICON[option.id];
        const selected = option.id === value;
        return (
          <RadioGroupItem
            key={option.id}
            value={option.id}
            id={`repo-source-${option.id}`}
            name="repo-source"
            data-testid={`repo-source-${option.id}`}
            className={cn('repo-new-source', selected && 'is-selected')}
            label={
              <>
                <span className="repo-new-source__tile" aria-hidden>
                  <Icon aria-hidden />
                </span>
                <span className="repo-new-source__text">
                  <span className="repo-new-source__title">{option.label}</span>
                  <span className="repo-new-source__desc">{option.description}</span>
                </span>
              </>
            }
          />
        );
      })}
    </RadioGroup>
  );
}

export default AddRepositorySourceChoice;
