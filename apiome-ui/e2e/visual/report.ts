/**
 * The artefact the harness publishes (HIVE-10.1, #5337).
 *
 * #5337 asks for a report a reviewer can eyeball, and for CI to publish diff images. Both are
 * built here as strings, so `tests/visual-parity-report.test.ts` can assert what a reviewer
 * will actually see without opening a browser.
 *
 * The page is deliberately self-contained — no stylesheet, no script, no font — because it is
 * uploaded as a CI artefact and read from a file system where nothing else is fetchable.
 */

import { DIMENSION_IDS, type ParityReport } from './score';

/** The three images published beside one route's verdict. */
export interface RouteImages {
  /** File name of the mockup screenshot. */
  mockup: string;
  /** File name of the app screenshot. */
  app: string;
  /** File name of the difference of the two. */
  diff: string;
}

/** One route's verdict and the images that go with it. */
export interface RouteArtefact {
  /** The verdict. */
  report: ParityReport;
  /** The images, or `null` when screenshots were not captured. */
  images: RouteImages | null;
}

/** Escape text for HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a fraction as a percentage. */
function percent(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

/**
 * The stylesheet of the report page.
 *
 * Written against `prefers-color-scheme` rather than the product's token layer: this page is
 * read outside the app, where none of those tokens exist.
 */
const REPORT_CSS = `
:root { color-scheme: light dark; --ok: #15803d; --bad: #b91c1c; --line: #d4d4d8; --muted: #52525b; }
@media (prefers-color-scheme: dark) {
  :root { --ok: #4ade80; --bad: #f87171; --line: #3f3f46; --muted: #a1a1aa; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2.5rem 0 .5rem; }
p.lede { margin: 0 0 2rem; color: var(--muted); max-width: 70ch; }
table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
th, td { border-bottom: 1px solid var(--line); padding: .4rem .6rem; text-align: left; vertical-align: top; }
th { font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pass { color: var(--ok); font-weight: 600; }
.fail { color: var(--bad); font-weight: 600; }
ul.detail { margin: .25rem 0 0; padding-left: 1.1rem; color: var(--muted); }
figure { margin: 0; }
figcaption { color: var(--muted); font-size: .85em; padding-bottom: .25rem; }
.shots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0 0; }
.shots img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
.scroll { overflow-x: auto; }
`;

/**
 * The per-route section of the report.
 *
 * @param artefact One route's verdict and images.
 * @returns The HTML for that route.
 */
function routeSection(artefact: RouteArtefact): string {
  const { report, images } = artefact;
  const rows = DIMENSION_IDS.map((id) => {
    const dimension = report.dimensions.find((entry) => entry.id === id);
    if (!dimension) return '';
    const detail =
      dimension.detail.length === 0
        ? ''
        : `<ul class="detail">${dimension.detail
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join('')}</ul>`;
    return `<tr><td>${escapeHtml(dimension.label)}${detail}</td><td class="num">${percent(
      dimension.weight
    )}</td><td class="num">${percent(dimension.score)}</td></tr>`;
  }).join('');

  const shots = images
    ? `<div class="shots">
    <figure><figcaption>Mockup</figcaption><img src="${escapeHtml(
      images.mockup
    )}" alt="The ${escapeHtml(report.id)} mockup" /></figure>
    <figure><figcaption>App</figcaption><img src="${escapeHtml(
      images.app
    )}" alt="The ${escapeHtml(report.id)} app page" /></figure>
    <figure><figcaption>Difference</figcaption><img src="${escapeHtml(
      images.diff
    )}" alt="The difference between the two" /></figure>
  </div>`
    : '';

  const notes =
    report.notes.length === 0
      ? ''
      : `<ul class="detail">${report.notes
          .map((note) => `<li>${escapeHtml(note)}</li>`)
          .join('')}</ul>`;

  return `<section id="${escapeHtml(report.id)}">
  <h2>${escapeHtml(report.id)} — <span class="${report.passed ? 'pass' : 'fail'}">${percent(
    report.score
  )}</span></h2>
  <p class="lede">${escapeHtml(report.mockup)} vs ${escapeHtml(report.subject)} — gate ${percent(
    report.gate
  )}</p>
  <div class="scroll"><table>
    <thead><tr><th>Dimension</th><th class="num">Weight</th><th class="num">Score</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${notes}
  ${shots}
</section>`;
}

/**
 * The whole report page.
 *
 * @param artefacts Every route that was measured, in route-map order.
 * @param options.title The page title.
 * @param options.theme The theme the run was pinned to, for the lede.
 * @returns A self-contained HTML document.
 */
export function parityReportHtml(
  artefacts: readonly RouteArtefact[],
  options: { title?: string; theme?: string | null } = {}
): string {
  const title = options.title ?? 'Visual parity against the mockups';
  const passed = artefacts.filter((artefact) => artefact.report.passed).length;
  const summaryRows = artefacts
    .map(
      (artefact) =>
        `<tr><td><a href="#${escapeHtml(artefact.report.id)}">${escapeHtml(
          artefact.report.id
        )}</a></td><td>${escapeHtml(artefact.report.mockup)}</td><td class="num">${percent(
          artefact.report.score
        )}</td><td class="${artefact.report.passed ? 'pass' : 'fail'}">${
          artefact.report.passed ? 'PASS' : 'FAIL'
        }</td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="lede">${passed} of ${artefacts.length} routes clear the gate${
    options.theme ? `, measured in the ${escapeHtml(options.theme)} theme` : ''
  }. Each score is a weighted comparison of the app and the mockup in design-token space; the
images beside it are the two pages and their difference, for the eye.</p>
<div class="scroll"><table>
  <thead><tr><th>Route</th><th>Mockup</th><th class="num">Score</th><th>Verdict</th></tr></thead>
  <tbody>${summaryRows}</tbody>
</table></div>
${artefacts.map(routeSection).join('\n')}
</body>
</html>`;
}

/**
 * The run's summary as GitHub-flavoured Markdown, for a CI job summary.
 *
 * @param reports Every verdict, in route-map order.
 * @returns The Markdown table.
 */
export function parityMarkdownSummary(reports: readonly ParityReport[]): string {
  const lines = ['### Visual parity against the mockups', '', '| Route | Score | Verdict |', '|---|---:|---|'];
  for (const report of reports) {
    lines.push(
      `| \`${report.id}\` | ${percent(report.score)} | ${report.passed ? 'pass' : '**fail**'} |`
    );
  }
  const passed = reports.filter((report) => report.passed).length;
  lines.push('', `${passed} of ${reports.length} routes clear the gate.`);
  return lines.join('\n');
}
