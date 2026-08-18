'use client';

/**
 * One project, as a card (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html` §Cards view — the hex avatar, the
 * domain-category pill, the mono `id · slug` line, the status pill, the two-line summary, the
 * Quality / Lint / Debt rings, the version count, the creator and the relative timestamp; and
 * the amber treatment with Undelete / Permanently delete for a card that needs attention.
 *
 * ### The whole card opens the project, and it is still one link
 *
 * The screen this replaces made the card body a `role="button"` with a `tabIndex` and then
 * put real buttons — the score orbs, the actions menu — inside it. That is
 * `nested-interactive`, a *serious* axe violation, and the ticket's definition of done asks
 * for none: a screen reader is told the whole card is a button and then walks into three more.
 *
 * So the card is an `<article>` with no role of its own, and the project's **name** is the
 * link. `.prj-card__link::after` stretches that one link over the whole card, which is what
 * gives back the big hit area; every control that has to stay clickable sits on
 * `.prj-card__above`, one stacking step higher. One tab stop, one accessible name, the same
 * pointer target — and the orbs and the menu still work.
 *
 * A deleted project has no link at all: its versions are hidden with it, so the card is inert
 * except for the two verbs in its footer.
 *
 * @see `./projectsModel.ts` — every figure and every string on this card.
 */

import * as React from 'react';
import Link from 'next/link';
import { Ellipsis, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { EmptyStateArt } from '@/app/components/ui/EmptyState';
import { Ring } from '@/app/components/ui/metrics';
import { formatRelativeTime } from '@/app/ade/dashboard/versions/version-history-dag';
import { cn } from '@lib/utils';

import {
  PROJECT_LIFECYCLE_LABEL,
  projectDomainLabel,
  projectLifecycle,
  projectScores,
  projectShortId,
  projectSummaryText,
  projectVersionsHref,
  projectVersionsLabel,
  type Project,
} from './projectsModel';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';

/** The row-menu item class, shared with the tenants and projects tables. */
const MENU_ITEM_CLASS = 'tnt-menu__item';

export interface ProjectCardProps {
  /** The project this card is about. */
  project: Project;
  /** Its browser-local quality snapshots, oldest first. */
  qualityHistory?: readonly ProjectQualitySnapshot[];
  /** Open the scores dialog on its Quality tab. */
  onOpenQuality: (project: Project) => void;
  /** Open the scores dialog on its Lint tab. */
  onOpenLint: (project: Project) => void;
  /** Open the edit dialog. */
  onEdit: (project: Project) => void;
  /** Soft-delete it. */
  onDelete: (project: Project) => void;
  /** Restore a soft-deleted project. */
  onRestore: (project: Project) => void;
  /** Destroy it, after the type-to-confirm gate. */
  onPermanentDelete: (project: Project) => void;
  /** True while a write is in flight — every verb on the card goes inert. */
  busy?: boolean;
}

/**
 * Render one project card. See {@link ProjectCardProps}.
 *
 * @returns The card, or its amber variant when the project needs attention.
 */
export default function ProjectCard({
  project,
  qualityHistory = [],
  onOpenQuality,
  onOpenLint,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  busy = false,
}: ProjectCardProps) {
  const lifecycle = projectLifecycle(project);
  const isDeleted = lifecycle === 'deleted';
  const scores = projectScores(project, qualityHistory);
  const domain = projectDomainLabel(project);
  const updated = formatRelativeTime(project.updated_at);

  return (
    <article
      className="prj-card"
      data-lifecycle={lifecycle}
      data-testid="project-card"
      data-project-id={project.id}
    >
      <div className="prj-card__body">
        <div className="prj-card__head">
          <Avatar shape="hex" size="lg" name={project.name} id={project.id} />
          <div className="prj-card__identity">
            <div className="prj-card__title-line">
              <h3 className="prj-card__name">
                {isDeleted ? (
                  project.name
                ) : (
                  <Link href={projectVersionsHref(project)} className="prj-card__link">
                    {project.name}
                  </Link>
                )}
              </h3>
              {domain ? <Badge variant="violet">{domain}</Badge> : null}
            </div>
            <p className="prj-card__id mono" title={project.slug ?? project.id}>
              {projectShortId(project.id)}
              {project.slug ? ` · ${project.slug}` : ''}
            </p>
          </div>
          <Badge status={lifecycle} dot data-testid="project-card-status">
            {PROJECT_LIFECYCLE_LABEL[lifecycle]}
          </Badge>
        </div>

        <p className="prj-card__summary">{projectSummaryText(project)}</p>

        <div className="prj-card__meter">
          {scores.isEmpty ? (
            <span className="prj-card__quiet" data-testid="project-card-empty">
              Empty project
            </span>
          ) : (
            <div className="prj-card__scores prj-card__above">
              <ProjectOrb
                label="Quality"
                title="Open quality score history"
                onClick={scores.quality != null ? () => onOpenQuality(project) : undefined}
              >
                <Ring score={scores.quality} label="Quality score" size="sm" />
              </ProjectOrb>
              <ProjectOrb
                label="Lint"
                title="Open lint report"
                onClick={scores.grade ? () => onOpenLint(project) : undefined}
              >
                <Ring
                  score={scores.quality}
                  grade={scores.grade}
                  display="grade"
                  label="Lint grade"
                  size="sm"
                />
              </ProjectOrb>
              <ProjectOrb label="Debt" title="Technical debt (not yet computed)">
                <Ring score={null} label="Technical debt" size="sm" />
              </ProjectOrb>
            </div>
          )}
          <span className="prj-card__versions mono" data-testid="project-card-versions">
            {projectVersionsLabel(scores.versionsCount)}
          </span>
        </div>
      </div>

      {isDeleted ? (
        <footer className="prj-card__footer prj-card__above" data-testid="project-card-recovery">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onRestore(project)}>
            <Undo2 aria-hidden />
            Undelete
          </Button>
          <Button
            variant="danger-soft"
            size="sm"
            disabled={busy}
            onClick={() => onPermanentDelete(project)}
          >
            <Trash2 aria-hidden />
            Permanently delete
          </Button>
        </footer>
      ) : (
        <footer className="prj-card__footer">
          <span className="prj-card__creator">
            <Avatar
              size="xs"
              name={project.creator_name}
              id={project.creator_email || project.creator_id}
            />
            <span className="prj-card__creator-name">{project.creator_name}</span>
          </span>
          <span className="prj-card__stamp" title={project.updated_at}>
            {updated ? `updated ${updated}` : '—'}
          </span>
        </footer>
      )}

      {isDeleted ? null : (
        <div className="prj-card__actions prj-card__above">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5"
                disabled={busy}
                aria-label={`Actions for ${project.name}`}
                data-testid={`project-card-menu-${project.id}`}
              >
                <Ellipsis aria-hidden />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  onSelect={() => onEdit(project)}
                >
                  <Pencil aria-hidden />
                  Edit project
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="tnt-menu__sep" />
                <DropdownMenu.Item
                  className={cn(MENU_ITEM_CLASS, 'prj-menu__item--danger')}
                  onSelect={() => onDelete(project)}
                >
                  <Trash2 aria-hidden />
                  Delete project
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </article>
  );
}

/** Props for {@link ProjectOrb}. */
interface ProjectOrbProps {
  /** What the orb scores — `Quality`, `Lint`, `Debt`. */
  label: string;
  /** The tooltip, which is also the button's title when it has one. */
  title: string;
  /** What opening it does. Absent for an orb with nothing behind it, which is not a button. */
  onClick?: () => void;
  /** The `<Ring>` itself. */
  children: React.ReactNode;
}

/**
 * One of the card's three orbs: the ring and the word under — beside — it.
 *
 * An orb with no score is a `<span>`, never a disabled button. "Not measured" is a fact about
 * the project, and a control that is present but refuses to do anything is a worse way of
 * saying it than not being a control at all — the `<Ring>` already prints an em dash and
 * announces itself as unscored.
 *
 * @param props See {@link ProjectOrbProps}.
 * @returns The orb.
 */
function ProjectOrb({ label, title, onClick, children }: ProjectOrbProps) {
  const content = (
    <>
      {children}
      <span className="prj-orb__label">{label}</span>
    </>
  );

  if (!onClick) {
    return (
      <span className="prj-orb" title={title}>
        {content}
      </span>
    );
  }

  return (
    <button type="button" className="prj-orb prj-orb--action" title={title} onClick={onClick}>
      {content}
    </button>
  );
}

export interface ProjectCreateTileProps {
  /** Open the create dialog. */
  onCreate: () => void;
}

/**
 * The dashed "New project" tile that closes the card grid.
 *
 * `build/projects.html` puts it last rather than first: the grid is a list of things that
 * exist, and the way to add one belongs after them — the page header's primary button is
 * where a reader who has decided already goes.
 *
 * @param props See {@link ProjectCreateTileProps}.
 * @returns The tile.
 */
export function ProjectCreateTile({ onCreate }: ProjectCreateTileProps) {
  return (
    <button
      type="button"
      className="prj-tile"
      onClick={onCreate}
      data-testid="projects-create-tile"
    >
      <EmptyStateArt icon={<Plus />} variant="compact" />
      <span className="prj-tile__title">New project</span>
      <span className="prj-tile__desc">Start blank, from a template, or design it with AI.</span>
    </button>
  );
}
