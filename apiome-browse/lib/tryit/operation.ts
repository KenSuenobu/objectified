/**
 * Re-export of the promoted Try It form model — DWX-4.2 (private-suite#2691).
 *
 * The parameter/request-body extraction and request composition now live in
 * `apiome-ui/lib/tryit/operation.ts`, so the designer's console builds requests from the same
 * model rather than a second reading of the same OpenAPI document.
 */

export * from '../../../apiome-ui/lib/tryit/operation';
