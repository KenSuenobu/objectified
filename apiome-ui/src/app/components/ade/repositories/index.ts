/**
 * The Repositories list surface (HIVE-7.3, #5320).
 *
 * `repositoriesModel` holds every rule; the components below are the paint. One barrel so the
 * screen has a single import, and so HIVE-7.4 (Add repository) and HIVE-7.5 (repository
 * detail) reuse the card, the provider badge and the row menu rather than cloning them.
 *
 * HIVE-7.5 (#5322) added `repositoryDetailModel` and the four detail-screen components beside
 * it. They live here rather than under `dashboard/repositories/` for the same reason 7.4's do:
 * the detail screen reuses `ProviderGlyph`, `repositoriesModel`'s status labels and the row
 * menu, and a component that both surfaces draw belongs where both can reach it.
 */

export * from './repositoriesModel';
export * from './addRepositoryModel';
export * from './repositoryDetailModel';
export { AddRepositorySourceChoice } from './AddRepositorySourceChoice';
export { LinkedAccountPicker } from './LinkedAccountPicker';
export { ProposedStepsCard } from './ProposedStepsCard';
export { ProviderBadge, ProviderGlyph } from './ProviderBadge';
export { PublicCloneUrlField } from './PublicCloneUrlField';
export { RemoteRepositoryPicker } from './RemoteRepositoryPicker';
export { RepositoriesSubNav, activeRepositoriesTab } from './RepositoriesSubNav';
export { RepositoryCard } from './RepositoryCard';
export { RepositoryIndexMark } from './RepositoryIndexMark';
export { RepositoryBranchPicker } from './RepositoryBranchPicker';
export { RepositoryDetailKpiStrip } from './RepositoryDetailKpiStrip';
export {
  REGEX_OVERRIDES_GLOB_HINT,
  RepositoryFileFilters,
} from './RepositoryFileFilters';
export {
  RepositoryFileRowMenu,
  repositoryFileProviderHref,
} from './RepositoryFileRowMenu';
export { RepositoryImportsTable, type RepositoryImportRow } from './RepositoryImportsTable';
export { RepositoryKpiStrip } from './RepositoryKpiStrip';
export {
  RepositoryPreviewTab,
  type RepositoryImportableMix,
  type RepositoryPreviewScanRow,
} from './RepositoryPreviewTab';
export { RepositorySettingsTab } from './RepositorySettingsTab';
export {
  AFFECTED_REPOS_SHOWN,
  REFRESH_ACTIVITY_ERROR,
  REFRESH_ACTIVITY_LOADING,
  RepositoryRefreshActivityPanel,
  RepositoryRefreshActivityPanelView,
  repositoryRefreshSpecsHref,
} from './RepositoryRefreshActivityPanel';
export { RepositoryRowMenu, type RepositoryRowHandlers } from './RepositoryRowMenu';
export { RepositoryTable } from './RepositoryTable';
