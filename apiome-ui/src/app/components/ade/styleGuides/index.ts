/**
 * The style-guides surface — HIVE-5.6 (#5309).
 *
 * `/ade/dashboard/style-guides`: the governance rules a tenant's specs are scored against,
 * and the two tenant policies that decide what those scores are allowed to gate. The page
 * composes these; the derivations they share are in {@link ./styleGuidesModel}, which is pure
 * and unit-tested, and the calls they make are in
 * `src/app/ade/dashboard/style-guides/api.ts` — shared with the guide editor, so it stays
 * where the editor can reach it.
 */

export { default as StyleGuidesTable } from './StyleGuidesTable';
export type { StyleGuidesTableProps } from './StyleGuidesTable';

export { GuideFormDialog, EditGuideDialog } from './GuideFormDialogs';
export type {
  GuideFormDialogProps,
  GuideFormMode,
  GuideDraft,
  EditGuideDialogProps,
} from './GuideFormDialogs';

export { default as AssignGuideDialog } from './AssignGuideDialog';
export type { AssignGuideDialogProps, AssignableProject } from './AssignGuideDialog';

export { default as DeleteGuideDialog } from './DeleteGuideDialog';
export type { DeleteGuideDialogProps } from './DeleteGuideDialog';

export * from './styleGuidesModel';
