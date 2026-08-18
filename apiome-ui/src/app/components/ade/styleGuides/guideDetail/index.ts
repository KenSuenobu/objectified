/**
 * The style-guide detail surface — HIVE-5.7 (#5310).
 *
 * `/ade/dashboard/style-guides/[guideId]`: one guide, and the three answers it gives —
 * which built-in rules apply and how severely ({@link RuleCatalogTab}), what the tenant has
 * written itself ({@link CustomRulesTab}), and what a score is allowed to gate
 * ({@link PolicyTab}).
 *
 * The page composes these. The drafts they edit live in {@link ./guideEditorState}, so a
 * tab switch cannot lose one; the derivations they share are in {@link ./guideDetailModel},
 * which is pure and unit-tested; and the calls they make are in
 * `src/app/ade/dashboard/style-guides/api.ts`, shared with the guides list.
 */

export { default as RuleCatalogTab } from './RuleCatalogTab';
export type { RuleCatalogTabProps } from './RuleCatalogTab';

export { default as CustomRulesTab } from './CustomRulesTab';
export type { CustomRulesTabProps } from './CustomRulesTab';

export { default as PolicyTab } from './PolicyTab';
export type { PolicyTabProps } from './PolicyTab';

export { default as GuideSaveBar } from './GuideSaveBar';
export type { GuideSaveBarProps } from './GuideSaveBar';

export { default as GuideReadOnlyNotice } from './GuideReadOnlyNotice';
export type { GuideReadOnlyNoticeProps, GuideReadOnlySurface } from './GuideReadOnlyNotice';

export * from './guideDetailModel';
export * from './guideEditorState';
