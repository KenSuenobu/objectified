/**
 * Re-export of the promoted Try It snippet renderer — DWX-4.7 (private-suite#2696).
 *
 * The curl / fetch / httpx renderers now live in `apiome-ui/lib/tryit/snippet.ts`, so the
 * designer's Try-It console and its Quick actions grid emit the same command Browse's
 * `CodeSnippetPanel` does for the same request, rather than a second renderer that agrees with
 * this one until it does not.
 */

export * from '../../../apiome-ui/lib/tryit/snippet';
