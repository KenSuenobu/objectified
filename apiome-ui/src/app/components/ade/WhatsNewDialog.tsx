'use client';

import React, { useEffect, useState } from 'react';
import { Markdown } from '@/app/components/ui/Markdown';
import { githubMarkdownComponents } from '@/app/components/ui/markdownGithubComponents';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { APP_VERSION_BADGE } from '@lib/app-version';

/**
 * The release notes (`public/WHATS_NEW.md`), as a dialog.
 *
 * Opened from the rail user menu's *What's new* row and from the build string beneath it
 * (HIVE-3.4, #5290), and from the launcher's own badge. The markdown is fetched rather
 * than bundled so a release can update the notes without a rebuild.
 *
 * Re-tokened onto the Hive `Dialog` primitive by HIVE-3.4. It used to be a hand-rolled
 * portal painted in `bg-white` / `dark:bg-gray-800`, which meant it read as the *old* app
 * on all nine themes and — more seriously — had no focus trap, no `Esc` and no focus
 * restoration, because those are the things the primitive was introduced to stop every
 * overlay reimplementing. The behaviour a reader notices is unchanged: it is still a
 * centred, viewport-fixed sheet that closes on a click outside (#2531).
 */

/** Props for {@link WhatsNewDialog}. */
export interface WhatsNewDialogProps {
  /** Whether the notes are showing. */
  isOpen: boolean;
  /** Called on `Esc`, the backdrop, and the close button. */
  onClose: () => void;
}

/** What the body says while the markdown is in flight. */
const LOADING_COPY = 'Loading…';

/** What the body says when the notes could not be fetched. */
const ERROR_COPY = "# Couldn't load the release notes\n\nPlease try again in a moment.";

const WhatsNewDialog: React.FC<WhatsNewDialogProps> = ({ isOpen, onClose }) => {
  const [markdownContent, setMarkdownContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  // Fetched on open rather than on mount: the dialog is mounted by the rail on every
  // dashboard route, and a reader who never opens it should not pay for the request.
  //
  // `isLoading` is only ever turned *off* here. Re-arming it on a reopen would flash the
  // spinner over notes the reader has already been shown, and it is the kind of
  // synchronous setState in an effect that `react-hooks/set-state-in-effect` exists to
  // catch — the second fetch simply replaces the text in place when it arrives.
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    fetch('/WHATS_NEW.md')
      .then((response) => response.text())
      .then((text) => {
        if (cancelled) return;
        setMarkdownContent(text);
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        console.error("Error loading What's New content:", error);
        if (cancelled) return;
        setMarkdownContent(ERROR_COPY);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="lg"
        data-testid="whats-new-dialog"
        // The notes are long; the sheet scrolls its body rather than the page behind it.
        className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>What&apos;s new</DialogTitle>
          <DialogDescription className="mono text-2xs">{APP_VERSION_BADGE}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto scroll-smooth">
          {isLoading ? (
            <p className="py-12 text-center text-sm text-fg-muted">{LOADING_COPY}</p>
          ) : (
            <Markdown variant="article" allowHtml components={githubMarkdownComponents}>
              {markdownContent}
            </Markdown>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default WhatsNewDialog;
