'use client';

/**
 * "Pick up where you left off" (HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/home/overview.html` §"Continue where you left off" and its Notes —
 * "cards derived from recent activity (project · latest version · lifecycle · quality score
 * from stored lint report)".
 *
 * This is the section that answers the ticket's problem statement: the overview used to tell a
 * reader what they had and give them nowhere to go. Each card is one project's newest revision
 * with the four facts that decide whether it is the thing to open next — what state it is in
 * (the lifecycle badge), how big it is, how healthy it is, and how long ago it was touched.
 *
 * **The card is one anchor, not a card containing one.** `cardVariants` is applied to the
 * `<Link>` itself rather than nesting a link inside a `<Card>` div: a card whose hover lift and
 * whose click target are two different elements has a dead border, and a nested anchor makes
 * the accessible name of the "card" and of the link disagree.
 *
 * The quality ring reads `versions.quality_score` as stored. Nothing here lints — #5259 made
 * the Versions list stored-first exactly so that drawing a score costs no lint run, and an
 * unscored revision draws the unscored ring rather than triggering one.
 */

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { cardVariants } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Ring } from '@/app/components/ui/metrics';
import { cn } from '@lib/utils';
import { CONTINUE_PROJECT_LIMIT, type ContinueProject } from '@lib/db/dashboard-home-model';
import { PANEL, revisionMetaLine, statusWord, touchedPhrase } from './homeModel';

/** Where the section's trailing link goes. */
const PROJECTS_HREF = '/ade/dashboard/projects';

/** The Versions list, which is where a project's revisions are actually worked on. */
const VERSIONS_HREF = '/ade/dashboard/versions';

/**
 * The href of one card.
 *
 * `projectId` is the parameter the Versions list already reads to preselect a project (it is
 * how the Projects list and the catalog drill into it), so the card lands the reader on the
 * revision it just described rather than on a list they have to search.
 *
 * @param projectId The project's record id.
 * @returns The Versions route, scoped to that project.
 */
export function continueCardHref(projectId: string): string {
  return `${VERSIONS_HREF}?projectId=${encodeURIComponent(projectId)}`;
}

/** Props for {@link ContinueCard}. */
interface ContinueCardProps {
  /** The project and its newest revision. */
  project: ContinueProject;
}

/**
 * One project card.
 *
 * @param props See {@link ContinueCardProps}.
 * @returns An anchor styled as a hoverable card.
 */
function ContinueCard({ project }: ContinueCardProps) {
  return (
    <Link
      href={continueCardHref(project.projectId)}
      data-project={project.projectId}
      className={cn(cardVariants({ hover: true, link: true }), 'home-continue__card')}
    >
      <span className="home-continue__top">
        <Badge status={project.status}>{statusWord(project.status)}</Badge>
        {project.tenantName ? (
          <span className="home-continue__tenant">{project.tenantName}</span>
        ) : null}
      </span>
      <span className="home-continue__name">{project.projectName}</span>
      <span className="home-continue__meta mono">
        {revisionMetaLine(project.versionLabel, project.classCount, project.propertyCount)}
      </span>
      <span className="home-continue__foot">
        <span className="home-continue__quality">
          <Ring
            score={project.qualityScore}
            grade={project.qualityGrade}
            size="sm"
            label={`Quality score for ${project.projectName}`}
          />
          <span className="home-continue__quality-label">Quality</span>
        </span>
        <span className="home-continue__touched">
          {touchedPhrase(project.touchedKind, project.touchedAt)}
        </span>
      </span>
    </Link>
  );
}

/** One loading card: the four bands a loaded card draws, at their real heights. */
function ContinueSkeleton() {
  return (
    <div className={cn(cardVariants(), 'home-continue__card')} aria-hidden>
      <span className="home-continue__top">
        <Skeleton className="h-4 w-16 rounded-full" />
      </span>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-4/5" />
      <span className="home-continue__foot">
        <Skeleton className="size-[1.875rem] rounded-full" />
        <Skeleton className="h-3 w-20" />
      </span>
    </div>
  );
}

/** Props for {@link ContinueWorking}. */
export interface ContinueWorkingProps {
  /** Up to {@link CONTINUE_PROJECT_LIMIT} projects, most recently touched first. */
  projects: readonly ContinueProject[];
  /** True until the first load resolves. */
  loading: boolean;
}

/**
 * Draw the section.
 *
 * A reader with no projects still gets it, as an {@link EmptyState} that teaches the next step —
 * `DESIGN.md` §1.5 asks empty states to teach, and this is where a first-run reader looks for
 * what to do. The section is never *absent*: a section that disappears is what left the right
 * half of the old grid blank.
 *
 * @param props See {@link ContinueWorkingProps}.
 * @returns The section, its skeletons, or its empty state.
 */
export function ContinueWorking({ projects, loading }: ContinueWorkingProps) {
  return (
    <section className="home-section" aria-labelledby="home-continue-title">
      <div className="home-section__title">
        <h2 id="home-continue-title">{PANEL.continue.title}</h2>
        <Link href={PROJECTS_HREF} className="home-section__link">
          All projects
          <ArrowRight aria-hidden />
        </Link>
      </div>

      {loading ? (
        <div className="home-continue">
          {Array.from({ length: CONTINUE_PROJECT_LIMIT }, (_, index) => (
            <ContinueSkeleton key={index} />
          ))}
        </div>
      ) : projects.length > 0 ? (
        <div className="home-continue">
          {projects.map((project) => (
            <ContinueCard key={project.projectId} project={project} />
          ))}
        </div>
      ) : (
        <EmptyState
          brand
          surface
          variant="compact"
          title="No projects yet"
          description="Create a project or import a spec, and the work you were last in shows up here."
        />
      )}
    </section>
  );
}

export default ContinueWorking;
