/**
 * Re-export of the promoted Try It send pipeline — DWX-4.2 (private-suite#2691).
 *
 * `apiome-ui/lib/tryit/send.ts` owns the relay's request/response envelope contract, so a request
 * composed in the studio and one composed in Browse are the same request. Browse keeps posting to
 * its own `/api/try-it` (the pipeline's default relay path), unchanged.
 */

export * from '../../../apiome-ui/lib/tryit/send';
