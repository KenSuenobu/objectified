/**
 * The Versions screen (HIVE-6.2, #5313).
 *
 * `docs/mockups/build/versions.html` in parts — the table and its row menu, the timeline
 * filters, the three banners, the git-like chip panels, the project facts aside, and the
 * five in-scope dialogs (New · Edit · Sunset · Publish · Spec viewer) — plus `versionsModel`,
 * the rules all of them share.
 *
 * The compare, merge, branch, tag, fork, rollback and history surfaces are deliberately *not*
 * here: they are HIVE-6.3's (`build/version-dialogs.html`) and stay in the page until then.
 */

export * from './versionsModel';

export { GitlikeFlag } from './GitlikeFlag';
export type { GitlikeFlagProps } from './GitlikeFlag';

export { VersionRowMenu } from './VersionRowMenu';
export type { VersionRowMenuProps } from './VersionRowMenu';

export { default as VersionsTable } from './VersionsTable';
export type { VersionsTableProps } from './VersionsTable';

export { default as VersionsTimelineFilters } from './VersionsTimelineFilters';
export type { VersionAuthorOption, VersionsTimelineFiltersProps } from './VersionsTimelineFilters';

export { default as VersionsBanners, SUNSET_TIMELINE_ROUTE } from './VersionsBanners';
export type { VersionsBannersProps } from './VersionsBanners';

export { default as VersionGitlikePanels } from './VersionGitlikePanels';
export type { VersionGitlikePanelsProps } from './VersionGitlikePanels';

export { default as ProjectFactsCard, EXPORT_STUDIO_ROUTE, PUBLISHED_ROUTE } from './ProjectFactsCard';
export type { ProjectFactsCardProps } from './ProjectFactsCard';

export {
  LifecycleSelect,
  SUCCESSOR_SELECT_NONE,
  SuccessorRevisionField,
  VersionDialogHead,
} from './VersionDialogChrome';
export type {
  LifecycleSelectProps,
  SuccessorRevisionFieldProps,
  VersionDialogHeadProps,
  VersionDialogTone,
} from './VersionDialogChrome';

export { default as NewVersionDialog } from './NewVersionDialog';
export type { BumpStrategy, NewVersionDialogProps } from './NewVersionDialog';

export { default as EditVersionDialog } from './EditVersionDialog';
export type { EditVersionDialogProps } from './EditVersionDialog';

export { default as SunsetScheduleDialog } from './SunsetScheduleDialog';
export type { SunsetScheduleDialogProps } from './SunsetScheduleDialog';

export { default as PublishVersionDialog } from './PublishVersionDialog';
export type {
  PublishBlockers,
  PublishChangeReportBaselineMode,
  PublishChangeReportPreview,
  PublishChangeReportProps,
  PublishVersionDialogProps,
  PublishVisibility,
} from './PublishVersionDialog';

export { default as SpecViewerDialog, SPEC_FORMATS, renderSpec, specDownloadName } from './SpecViewerDialog';
export type { SpecFormat, SpecViewerDialogProps } from './SpecViewerDialog';
