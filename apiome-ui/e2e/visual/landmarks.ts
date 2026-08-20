/**
 * The page-chrome landmarks the harness compares, and how each side spells them
 * (HIVE-10.1, #5337).
 *
 * The mockups and the app arrived at the same page chrome by different routes: the mockups
 * hand-wrote `.page-title`, the app composes `PageHeader` which emits `.page-header__title`.
 * Both are the same landmark, so the harness needs one table saying so. This is the only
 * place in the harness where the two vocabularies meet — everything downstream works on
 * landmark ids.
 *
 * A landmark is looked up with `querySelector`, so the first match inside the page scope
 * wins; the selectors are written to make that the page-level one.
 */

/** The landmarks of the page chrome, in reading order. */
export const LANDMARK_IDS = [
  'header',
  'breadcrumb',
  'title',
  'description',
  'actions',
  'tabs',
  'body',
] as const;

/** One landmark of the page chrome. */
export type LandmarkId = (typeof LANDMARK_IDS)[number];

/** A side of the comparison: the mockup is the source of truth, the app is under test. */
export type Side = 'mockup' | 'app';

/** How the mockups spell each landmark (`docs/mockups/assets/hive.css`). */
export const MOCKUP_LANDMARKS: Record<LandmarkId, string> = {
  header: '.page-header',
  breadcrumb: '.crumbs',
  title: '.page-title',
  description: '.page-desc',
  actions: '.page-actions',
  tabs: '.tabs',
  body: '.page-body',
};

/**
 * How the app spells each landmark.
 *
 * `tabs` is the one landmark the app has no single class for: HIVE-7.3 shipped the shared
 * sub-nav as a labelled `<nav>` with a `*-subnav` test id, and Radix tab strips expose
 * `role="tablist"`. Both are the same landmark to a reader, so both are matched.
 */
export const APP_LANDMARKS: Record<LandmarkId, string> = {
  header: '.page-header',
  breadcrumb: '.page-header__crumbs',
  title: '.page-header__title',
  description: '.page-header__desc',
  actions: '[data-testid="page-header-actions"]',
  tabs: '[data-testid$="-subnav"], [role="tablist"]',
  body: '.page-body',
};

/**
 * The landmark selector table for one side.
 *
 * @param side Which side of the comparison is being collected.
 * @returns The landmark id → CSS selector map that side uses.
 */
export function landmarkSelectors(side: Side): Record<LandmarkId, string> {
  return side === 'mockup' ? MOCKUP_LANDMARKS : APP_LANDMARKS;
}

/**
 * The element that bounds a page for one side.
 *
 * The mockup renders the whole shell — rail, top bar, page — and only the page is
 * comparable; the app fixtures *are* the page. Both resolve to `.page`, which is the class
 * both sides put on the page region, but the mockup's is a `<main>` and the app's a `<div>`,
 * so neither side may assume the tag.
 *
 * @param side Which side of the comparison is being collected.
 * @returns The selector for that side's page region.
 */
export function scopeSelector(side: Side): string {
  return side === 'mockup' ? 'main.page, .page' : '.page';
}
