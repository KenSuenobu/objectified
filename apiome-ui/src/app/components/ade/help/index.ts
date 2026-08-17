/**
 * The Help & docs surface (HIVE-4.9, #5303).
 *
 * One import for the page: the three regions it draws, and the model behind them.
 */

export { default as HelpCards } from './HelpCards';
export type { HelpCardsProps } from './HelpCards';
export { default as HelpGuideSearch } from './HelpGuideSearch';
export { default as HelpSupportCard } from './HelpSupportCard';
export type { HelpSupportCardProps } from './HelpSupportCard';
export { default as ShortcutsGlance, SHORTCUTS_GLANCE_TITLE } from './ShortcutsGlance';
export type { ShortcutsGlanceProps } from './ShortcutsGlance';

export {
  GUIDE_ENTRIES,
  GUIDE_QUERY_MIN_LENGTH,
  GUIDE_RESULT_LIMIT,
  GUIDE_SECTION_LABELS,
  guideHref,
  searchGuides,
} from './helpCatalog';
export type { GuideEntry, GuideSection } from './helpCatalog';

export {
  DASHBOARD_HOME_ROUTE,
  HELP_CARDS,
  NO_TENANT_LABEL,
  SHORTCUT_GLANCE_LIMIT,
  SUPPORT_ISSUE_URL,
  VIDEO_WALKTHROUGHS_URL,
  glanceShortcuts,
  supportDetails,
} from './helpModel';
export type { HelpCard, HelpCardKind } from './helpModel';
