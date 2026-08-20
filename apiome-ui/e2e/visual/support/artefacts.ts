/**
 * Where the visual-parity harness writes what it found (HIVE-10.1, #5337).
 *
 * Each test writes its own route's verdict and images as it finishes, and the global
 * teardown composes whatever is on disk into one page per theme. Splitting it that way is
 * what lets the suite run in parallel: no test has to know about any other, and a run that
 * fails half way still publishes the half it measured.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ParityReport } from '../score';
import type { RouteArtefact, RouteImages } from '../report';
import type { ParityImages } from './harness';

/** The root of the published report, inside `apiome-ui/`. */
export const REPORT_ROOT = path.resolve(__dirname, '..', '..', '..', 'visual-parity-report');

/**
 * The directory one theme's artefacts live in.
 *
 * @param themeId The theme the run was pinned to (`light` for the `:root` default).
 * @returns The absolute directory path.
 */
export function themeDir(themeId: string): string {
  return path.join(REPORT_ROOT, themeId);
}

/**
 * Write one route's verdict, and its images when there are any.
 *
 * @param themeId The theme the run was pinned to.
 * @param report The verdict.
 * @param images The screenshots, or `null` when none were captured.
 * @returns The image file names, relative to the theme directory, or `null`.
 */
export function writeRouteArtefact(
  themeId: string,
  report: ParityReport,
  images: ParityImages | null
): RouteImages | null {
  const directory = themeDir(themeId);
  fs.mkdirSync(directory, { recursive: true });

  let names: RouteImages | null = null;
  if (images) {
    names = {
      mockup: `${report.id}-mockup.png`,
      app: `${report.id}-app.png`,
      diff: `${report.id}-diff.png`,
    };
    fs.writeFileSync(path.join(directory, names.mockup), images.mockup);
    fs.writeFileSync(path.join(directory, names.app), images.app);
    fs.writeFileSync(path.join(directory, names.diff), images.diff);
  }

  fs.writeFileSync(
    path.join(directory, `${report.id}.json`),
    `${JSON.stringify({ report, images: names }, null, 2)}\n`,
    'utf8'
  );
  return names;
}

/**
 * Read back every route artefact one theme wrote, in the order given.
 *
 * @param themeId The theme directory to read.
 * @param order The route ids, in the order the report should list them.
 * @returns One entry per artefact found; ids with no artefact are skipped.
 */
export function readRouteArtefacts(themeId: string, order: readonly string[]): RouteArtefact[] {
  const directory = themeDir(themeId);
  if (!fs.existsSync(directory)) return [];
  const artefacts: RouteArtefact[] = [];
  for (const id of order) {
    const file = path.join(directory, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    artefacts.push(JSON.parse(fs.readFileSync(file, 'utf8')) as RouteArtefact);
  }
  return artefacts;
}
