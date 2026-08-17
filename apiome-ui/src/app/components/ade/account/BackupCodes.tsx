'use client';

/**
 * The one-time backup codes panel (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Enable 2FA" step 3 and §"Regenerate backup
 * codes" step 2 — the same two-column mono grid in both, with **Copy codes** beside a
 * **Download .txt** the Adds list introduces.
 *
 * It is one component because it is one thing shown twice: enrolment and regeneration both end
 * by revealing a set of codes the reader has exactly one chance to keep. Before this, the grid
 * and its copy button were an inline fragment in `TwoFactorSettings`, which is why only one of
 * the two paths could have grown a download without the other.
 *
 * ### The download
 *
 * A `Blob` and an object URL, revoked on the next frame. There is no server round-trip and no
 * network request: the codes are already in the browser, and sending them anywhere to get a
 * file back would put a set of one-time secrets through a second system for no reason.
 */

import * as React from 'react';
import { Check, Copy, Download } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';

/** How long the copy confirmation stays up, in milliseconds. */
const COPIED_RESET_MS = 2000;

/** The file a download lands as. */
export const BACKUP_CODES_FILENAME = 'apiome-backup-codes.txt';

/**
 * The file's contents: one code per line, with a trailing newline.
 *
 * A plain list, not a formatted document — the reader is going to paste these into a password
 * manager, and anything else in the file is something they have to delete first.
 *
 * @param codes The codes, in the order they were issued.
 * @returns The text to write.
 */
export function backupCodesFileBody(codes: readonly string[]): string {
  return `${codes.join('\n')}\n`;
}

/** Props for {@link BackupCodes}. */
export interface BackupCodesProps {
  /** The codes to reveal. */
  codes: readonly string[];
}

/**
 * Draw the grid and its two actions.
 *
 * @param props See {@link BackupCodesProps}.
 * @returns The panel.
 */
export function BackupCodes({ codes }: BackupCodesProps) {
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // Clipboard unavailable. Nothing is claimed to have been copied; the codes are still on
      // screen and the download is still there.
    }
  }, [codes]);

  const handleDownload = React.useCallback(() => {
    const url = URL.createObjectURL(
      new Blob([backupCodesFileBody(codes)], { type: 'text/plain;charset=utf-8' })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = BACKUP_CODES_FILENAME;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [codes]);

  return (
    <div className="acct-codes-panel">
      <ul className="acct-codes" data-testid="two-factor-backup-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="acct-codes__actions">
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleDownload}
          data-testid="two-factor-backup-download"
        >
          <Download aria-hidden />
          Download .txt
        </Button>
      </div>
    </div>
  );
}

export default BackupCodes;
