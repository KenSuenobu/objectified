/**
 * The shared unload guard (HIVE-5.3, #5306).
 *
 * Three screens hold a draft that exists only in memory until it is saved — the style-guide
 * editor, its custom-rules tab, and the roles matrix — and each had written the same effect.
 * Written once, it can be pinned once, and what has to be pinned is the part that is easy to
 * get subtly wrong: the listener is attached *only* while there is something to lose, and it
 * is removed the moment there is not.
 *
 * A page that always blocks unload is a page browsers learn to distrust, and a listener left
 * behind after a save is exactly that.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { useUnsavedChangesPrompt } from '../src/app/hooks/useUnsavedChangesPrompt';

/**
 * A component that guards while `dirty`.
 *
 * @param props.dirty Whether there is unsaved work.
 * @returns Nothing visible.
 */
function Guarded({ dirty }: { dirty: boolean }) {
  useUnsavedChangesPrompt(dirty);
  return null;
}

describe('useUnsavedChangesPrompt', () => {
  let add: jest.SpiedFunction<typeof window.addEventListener>;
  let remove: jest.SpiedFunction<typeof window.removeEventListener>;

  beforeEach(() => {
    add = jest.spyOn(window, 'addEventListener');
    remove = jest.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * How many `beforeunload` listeners were added or removed.
   *
   * @param spy The spy to count in.
   * @returns The count.
   */
  const beforeunloadCalls = (spy: typeof add) =>
    spy.mock.calls.filter(([type]) => type === 'beforeunload').length;

  it('registers nothing while there is nothing to lose', () => {
    render(<Guarded dirty={false} />);
    expect(beforeunloadCalls(add)).toBe(0);
  });

  it('registers once the draft is dirty', () => {
    const { rerender } = render(<Guarded dirty={false} />);
    rerender(<Guarded dirty />);
    expect(beforeunloadCalls(add)).toBe(1);
  });

  it('unregisters as soon as the draft is saved', () => {
    const { rerender } = render(<Guarded dirty />);
    expect(beforeunloadCalls(add)).toBe(1);

    rerender(<Guarded dirty={false} />);
    expect(beforeunloadCalls(remove)).toBe(1);
  });

  it('unregisters when the screen goes away with the draft still dirty', () => {
    const { unmount } = render(<Guarded dirty />);
    unmount();
    expect(beforeunloadCalls(remove)).toBe(1);
  });

  it('asks the browser to confirm, in the way every engine still recognises', () => {
    render(<Guarded dirty />);
    const handler = add.mock.calls.find(([type]) => type === 'beforeunload')?.[1] as (
      event: BeforeUnloadEvent
    ) => void;
    expect(handler).toBeDefined();

    const event = { preventDefault: jest.fn(), returnValue: undefined } as unknown as
      BeforeUnloadEvent;
    handler(event);
    expect(event.preventDefault).toHaveBeenCalled();
    // Modern browsers ignore any custom message but still need the assignment.
    expect(event.returnValue).toBe('');
  });
});
