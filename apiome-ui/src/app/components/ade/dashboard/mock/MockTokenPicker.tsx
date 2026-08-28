'use client';

/**
 * Insertable `{{ ... }}` token picker for the mock editors (#5529, MSC-1.3).
 *
 * The bounded template language (#4744, PMR-2.1) is small, but an author still had to remember its
 * grammar *and* guess which parameters the operation declares. This offers both: the selected
 * operation's own path, query and header parameters, its request-body fields, and the fixture
 * names this version actually defines — each as a chip that types the expression for you.
 *
 * A disclosure rather than a popover on purpose: it sits inside a dialog beside a text field, and a
 * second focus trap over the first is the one thing that would make it worse than typing.
 */

import { useId, useState } from 'react';
import { Braces, ChevronDown } from 'lucide-react';

import { Button } from '../../../ui/Button';
import type { MockTokenGroup } from './mockAuthoringModel';

export interface MockTokenPickerProps {
  /** The groups to offer, from `buildTokenGroups`. */
  groups: MockTokenGroup[];
  /** Called with the expression when a chip is chosen. */
  onInsert: (token: string) => void;
  /** Names the field the tokens go into, for the toggle's accessible name. */
  fieldLabel: string;
  /** Test id for the picker root, so a page with several pickers can be queried per field. */
  testId?: string;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * Render the token disclosure for one expression field.
 *
 * @param props - see {@link MockTokenPickerProps}
 * @returns the toggle and, when open, the grouped token chips
 */
export function MockTokenPicker({
  groups,
  onInsert,
  fieldLabel,
  className,
  testId,
}: MockTokenPickerProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (groups.length === 0) return null;

  return (
    <div className={className ? `mock-tok ${className}` : 'mock-tok'} data-testid={testId}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Insert a token into ${fieldLabel}`}
        className="mock-tok__toggle"
      >
        <Braces aria-hidden />
        Insert token
        <ChevronDown aria-hidden className={open ? 'mock-tok__chevron--open' : undefined} />
      </Button>

      <div id={panelId} className="mock-tok__panel" hidden={!open}>
        {groups.map((group) => (
          <div key={group.title} className="mock-tok__group">
            <p className="mock-tok__group-title">{group.title}</p>
            <div className="mock-tok__chips">
              {group.tokens.map((token) => (
                <button
                  key={token.token}
                  type="button"
                  className="mock-tok__chip"
                  onClick={() => onInsert(token.token)}
                  title={`${token.token} — ${token.hint}`}
                >
                  <span className="mono">{token.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
