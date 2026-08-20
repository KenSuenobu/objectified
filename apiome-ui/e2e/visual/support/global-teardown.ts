/**
 * Composing the published report once every route has been measured (HIVE-10.1, #5337).
 *
 * Runs after the whole suite, reads the per-route artefacts each test wrote, and writes one
 * self-contained page per theme plus a machine-readable summary. When it runs inside GitHub
 * Actions it also appends the summary table to the job summary, so the verdict is visible
 * without downloading the artefact.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parityMarkdownSummary, parityReportHtml } from '../report';
import { PARITY_ROUTES } from '../routes';
import { REPORT_ROOT, readRouteArtefacts, themeDir } from './artefacts';

/**
 * Compose the report for every theme that produced artefacts.
 *
 * @returns Nothing; it writes files.
 */
export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(REPORT_ROOT)) return;
  const order = PARITY_ROUTES.map((route) => route.id);
  const themes = fs
    .readdirSync(REPORT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const markdown: string[] = [];
  for (const theme of themes) {
    const artefacts = readRouteArtefacts(theme, order);
    if (artefacts.length === 0) continue;
    const directory = themeDir(theme);
    fs.writeFileSync(
      path.join(directory, 'index.html'),
      parityReportHtml(artefacts, {
        title: `Visual parity against the mockups (${theme})`,
        theme,
      }),
      'utf8'
    );
    const reports = artefacts.map((artefact) => artefact.report);
    fs.writeFileSync(
      path.join(directory, 'summary.json'),
      `${JSON.stringify(reports, null, 2)}\n`,
      'utf8'
    );
    markdown.push(parityMarkdownSummary(reports).replace(
      '### Visual parity against the mockups',
      `### Visual parity against the mockups — ${theme}`
    ));
  }

  if (markdown.length === 0) return;
  const summary = `${markdown.join('\n\n')}\n`;
  fs.writeFileSync(path.join(REPORT_ROOT, 'summary.md'), summary, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}`);
  }
}
