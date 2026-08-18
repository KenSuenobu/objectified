/**
 * The Projects screen (HIVE-6.1, #5312).
 *
 * `docs/mockups/build/projects.html` in four parts — the card, the table, the two form
 * dialogs and the portfolio trend — plus `projectsModel`, the rules all four share.
 *
 * The scores dialog is deliberately *not* here: it lives at
 * `components/ade/dashboard/ProjectQualityHistoryDialog` because the Catalog list and a
 * catalog item's detail open the same one.
 */

export * from './projectsModel';

export { default as ProjectCard, ProjectCreateTile } from './ProjectCard';
export type { ProjectCardProps, ProjectCreateTileProps } from './ProjectCard';

export { default as ProjectsTable } from './ProjectsTable';
export type { ProjectsTableProps } from './ProjectsTable';

export { default as PortfolioTrendCard } from './PortfolioTrendCard';
export type { PortfolioTrendCardProps } from './PortfolioTrendCard';

export { ProjectCreateDialog, ProjectEditDialog } from './ProjectFormDialogs';
export type {
  CreateProjectTab,
  ProjectCreateDialogProps,
  ProjectEditDialogProps,
} from './ProjectFormDialogs';
