'use client';

import * as React from 'react';

/**
 * Copy text, and remember for a moment that it worked.
 *
 * Written for HIVE-5.4 (#5307), where two surfaces need the same behaviour — the row's
 * copy-prefix button and the reveal-once secret dialog — and where getting it wrong is not
 * cosmetic: a button that says "Copied!" when the clipboard write threw sends the reader
 * away from the only screen that will ever show their API key.
 *
 * So `copied` is set from the *resolved* write and never from the attempt, and a failure is
 * reported rather than swallowed, for a caller that wants to say "press ⌘C instead".
 *
 * ```tsx
 * const { copied, copy } = useClipboardCopy();
 * <Button onClick={() => void copy(secret)}>{copied ? 'Copied!' : 'Copy'}</Button>
 * ```
 *
 * @param resetMs How long the copied state lasts, in milliseconds (default 2000 — the two
 *   seconds the screen this replaced used, and which the mockup's notes keep).
 * @returns `copied` (true for `resetMs` after a successful write), `error` (the failure, or
 *   `null`), and `copy`, which resolves to whether the write succeeded.
 */
export function useClipboardCopy(resetMs = 2000): {
  copied: boolean;
  error: string | null;
  copy: (text: string) => Promise<boolean>;
} {
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // A component can unmount while the reset is pending — closing the dialog the button was
  // in is the ordinary way — and a timer that fires afterwards sets state on nothing.
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = React.useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        setCopied(false);
        setError('Copying failed. Select the text and copy it by hand.');
        return false;
      }
      setError(null);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
      return true;
    },
    [resetMs]
  );

  return { copied, error, copy };
}

export default useClipboardCopy;
