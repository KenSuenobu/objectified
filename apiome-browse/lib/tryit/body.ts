/**
 * Re-export of the promoted Try It body transport encoding — DWX-4.2 (private-suite#2691).
 *
 * `apiome-ui/lib/tryit/body.ts` owns the text/base64 rule the relay envelope is encoded with; both
 * consoles decode what the shared relay encodes.
 */

export * from '../../../apiome-ui/lib/tryit/body';
