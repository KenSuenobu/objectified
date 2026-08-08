/**
 * Re-export of the promoted Try It relay — DWX-4.2 (private-suite#2691).
 *
 * The relay's policy — the DNS pre-check, the connect-time re-check, the operator-mock-origin
 * exemption, the spec-server allow-list and the size/time caps — now lives in
 * `apiome-ui/lib/tryit/relay.ts` so the designer's own Try-It console can enforce *the same* one.
 * Two copies of an SSRF policy is the failure mode this promotion exists to prevent, so this file
 * is a re-export and never a fork: nothing may be added here.
 *
 * Browse's own import graph is unchanged — `src/app/api/try-it/route.ts` and the SIM-3.2 test
 * suite still name `lib/tryit/relay`, and behave exactly as they did.
 */

export * from '../../../apiome-ui/lib/tryit/relay';
