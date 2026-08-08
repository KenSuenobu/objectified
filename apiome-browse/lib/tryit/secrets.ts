/**
 * Re-export of the promoted Try It secret placeholders — DWX-4.2 (private-suite#2691).
 *
 * `apiome-ui/lib/tryit/secrets.ts` owns which header and query names are treated as credentials,
 * so no generated snippet in either application emits a raw one.
 */

export * from '../../../apiome-ui/lib/tryit/secrets';
