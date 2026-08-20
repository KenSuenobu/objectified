/**
 * Round-trip comparison envelope + presentation + issue-report helpers (IXH-4.4, #5112).
 *
 * The Export Studio's round-trip action answers "is this export honest?" empirically: the
 * server emits the source revision, re-imports the artifact through the matching import
 * adapter, diffs the re-imported canonical model against the source, and reconciles every
 * difference against the fidelity report (`POST /api/export/roundtrip`, the same loop the
 * IXH-1.7 conformance matrix runs in CI). This module mirrors that response field-for-field
 * so it deserialises directly, and adds the pure logic the panel needs:
 *
 *  - verdict presentation (`pass` / `fail` / `unsupported`) stated in words + glyph before
 *    colour (the Studio's house rule: meaning is never encoded by colour alone);
 *  - labels for the difference groups — differences the fidelity report explains are
 *    **expected**; unexplained differences and over-claims flag a fidelity bug;
 *  - the one-click issue-report builder for unexplained differences: a prefilled GitHub
 *    new-issue URL carrying the reproduction coordinates (source/target/options with
 *    credential-shaped option keys stripped, fingerprints, component versions) and **no
 *    source bytes**.
 *
 * Everything here is pure (no React, no fetch) so it unit-tests directly — mirroring
 * `./exportVerify.ts` and `./exportFidelityPreview.ts`.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import type { LossItem } from './exportFidelityPreview';
import { stripSecretOptions } from './exportStudioUrlState';

/**
 * The round-trip verdict, in the IXH-1.7 matrix's vocabulary (mirrors Python
 * `MatrixCellStatus`; the on-demand endpoint returns only the first three).
 */
export type RoundtripStatus = 'pass' | 'fail' | 'unsupported' | 'skipped' | 'xfail';

/** How one canonical entity differed after the round-trip (mirrors Python `DiffChangeKind`). */
export type RoundtripChangeKind = 'added' | 'removed' | 'changed';

/** One empirical difference between the source and the re-imported model. */
export interface RoundtripDiffEntry {
  /** The entity granularity: `root` / `service` / `operation` / `type` / `channel`. */
  entity: string;
  /** The entity's stable canonical key (empty string for the artifact root). */
  key: string;
  /** How it differed: added / removed / changed. */
  change: RoundtripChangeKind;
}

/** One explained difference: the diff entry paired with the fidelity finding covering it. */
export interface RoundtripMatchedDiff {
  /** The empirical difference. */
  entry: RoundtripDiffEntry;
  /** The fidelity finding that explains it (same shape as the fidelity report's items). */
  finding: LossItem;
}

/** The `POST /api/export/roundtrip` response (mirrors REST `ExportRoundtripResponse`). */
export interface ExportRoundtripResponse {
  /** The artifact (project) id the round-trip ran for. */
  artifact: string;
  /** The version selector as requested (label, UUID, or null for latest). */
  version?: string | null;
  /** The resolved revision record id. */
  version_record_id: string;
  /** The resolved revision's version label, e.g. `"1.2.0"`. */
  version_label?: string | null;
  /** The resolved target format key (e.g. `openapi-3.1`). */
  target: string;
  /** The resolved emitter registry key (e.g. `openapi`). */
  emit_key: string;
  /** The import adapter that re-imported the artifact; null when the comparison was skipped. */
  adapter_key?: string | null;
  /** The verdict: pass / fail / unsupported. */
  status: RoundtripStatus;
  /** Why a non-pass verdict happened (skip explanation, re-import failure, unexplained keys). */
  reason?: string | null;
  /** Total empirical differences between the source and the re-import. */
  diff_count: number;
  /** Differences the fidelity report explains (expected loss). */
  matched_count: number;
  /** Each explained difference paired with its finding. */
  matched: RoundtripMatchedDiff[];
  /** Differences no fidelity finding accounts for — a fidelity bug worth reporting. */
  unexplained: RoundtripDiffEntry[];
  /** `ok` findings whose construct empirically changed or vanished (over-claimed preservation). */
  overclaims: LossItem[];
  /** `drop` findings in the fidelity report. */
  loss_drop: number;
  /** `approx` findings in the fidelity report. */
  loss_approx: number;
  /** `synth` findings in the fidelity report. */
  loss_synth: number;
  /** `ok` findings in the fidelity report. */
  loss_ok: number;
  /** Deterministic fingerprint of the source canonical model (no source content). */
  source_fingerprint: string;
  /** Fingerprint of the re-imported model; equals the source's for a byte-honest loop. */
  reimported_fingerprint?: string | null;
  /** The emitter implementation version. */
  emitter_version: string;
  /** The apiome-rest package version that ran the loop. */
  apiome_version: string;
  /** The capability-registry snapshot version. */
  registry_version: string;
}

/** How a verdict is presented: the meaning in words and a glyph before any colour. */
export interface RoundtripStatusPresentation {
  /** Short verdict label (e.g. `Round trip verified`). */
  label: string;
  /** A one-line sentence stating what the verdict means for this artifact. */
  sentence: string;
  /** A text glyph reinforcing the verdict (never the only signal). */
  glyph: string;
  /**
   * The verdict banner's tone (colour arrives last, after words + glyph).
   *
   * HIVE-8.3 (#5329): a tone name rather than the four Tailwind palette triples this used to
   * carry, so the banner follows all nine themes through `ui/Alert`.
   */
  tone: StatusTone;
}

/**
 * Present a round-trip verdict (words + glyph first, colour last — the house rule).
 *
 * @param response The settled round-trip response.
 * @returns The banner label, sentence, glyph, and classes for the verdict.
 */
export function roundtripStatusPresentation(
  response: ExportRoundtripResponse,
): RoundtripStatusPresentation {
  switch (response.status) {
    case 'pass':
      return response.diff_count === 0
        ? {
            label: 'Round trip verified',
            sentence:
              'The emitted artifact re-imported to an identical canonical model — no differences at all.',
            glyph: '✓',
            tone: 'ok',
          }
        : {
            label: 'Round trip verified',
            sentence:
              'Every difference between the source and the re-imported artifact is explained by the fidelity report.',
            glyph: '✓',
            tone: 'ok',
          };
    case 'unsupported':
      return {
        label: 'Comparison skipped',
        sentence:
          response.reason ??
          'No import adapter can re-import this format, so the round trip cannot be closed.',
        glyph: '−',
        tone: 'neutral',
      };
    default:
      return {
        label: 'Fidelity report incomplete',
        sentence:
          'The round trip found differences the fidelity report does not account for — likely a fidelity bug worth reporting.',
        glyph: '✗',
        tone: 'danger',
      };
  }
}

/** Human label for a diff change kind (e.g. `Removed`). */
export function changeKindLabel(change: RoundtripChangeKind): string {
  switch (change) {
    case 'added':
      return 'Added';
    case 'removed':
      return 'Removed';
    default:
      return 'Changed';
  }
}

/**
 * The tone per diff change kind (colour after the label, never instead of it).
 *
 * HIVE-8.3 (#5329) replaced the three Tailwind palette pairs this returned with vocabulary
 * tones, so a "Removed" here is the same rose as a dropped construct in the manifest tree.
 */
export function changeKindTone(change: RoundtripChangeKind): StatusTone {
  switch (change) {
    case 'added':
      return 'violet';
    case 'removed':
      return 'rose';
    default:
      return 'accent';
  }
}

/** Render one diff entry as `entity key` prose (the root entity has an empty key). */
export function diffEntryLabel(entry: RoundtripDiffEntry): string {
  return entry.key === '' ? 'artifact root' : `${entry.entity} ${entry.key}`;
}

/**
 * One line summarising a settled round trip for the panel's status region — e.g.
 * `3 differences · 3 explained by the fidelity report` or
 * `4 differences · 2 unexplained · 1 over-claim`.
 */
export function summarizeRoundtrip(response: ExportRoundtripResponse): string {
  if (response.status === 'unsupported') return 'Comparison skipped.';
  if (response.diff_count === 0 && response.overclaims.length === 0) {
    return 'No differences — the re-imported model is identical to the source.';
  }
  const parts = [`${response.diff_count} difference${response.diff_count === 1 ? '' : 's'}`];
  if (response.matched_count > 0) {
    parts.push(`${response.matched_count} explained by the fidelity report`);
  }
  if (response.unexplained.length > 0) {
    parts.push(`${response.unexplained.length} unexplained`);
  }
  if (response.overclaims.length > 0) {
    parts.push(
      `${response.overclaims.length} over-claim${response.overclaims.length === 1 ? '' : 's'}`,
    );
  }
  return parts.join(' · ');
}

/** Where round-trip fidelity bugs are filed. */
export const ROUNDTRIP_ISSUE_BASE = 'https://github.com/apiome/apiome/issues/new';

/**
 * GitHub caps a `/issues/new` URL well below 8 KiB; beyond it the prefill is dropped
 * entirely. The body is clipped (with a note) before encoding so the link always works.
 */
export const ISSUE_BODY_MAX_LENGTH = 5_000;

/** The inputs the issue report is built from. */
export interface RoundtripIssueInput {
  /** The settled (failing) round-trip response. */
  response: ExportRoundtripResponse;
  /** The chosen target's human label (e.g. `OpenAPI 3.1`). */
  targetLabel: string;
  /** The non-default option overrides the run was configured with, or null. */
  options?: Record<string, unknown> | null;
}

/** A prefilled issue report: the title/body and the URL that carries them. */
export interface RoundtripIssueReport {
  /** The issue title. */
  title: string;
  /** The issue body (Markdown), before URL encoding. */
  body: string;
  /** The prefilled GitHub new-issue URL. */
  url: string;
  /** Option keys withheld from the report because they look like credentials. */
  redactedOptionKeys: string[];
}

/**
 * Build the one-click issue report for a failed round trip (IXH-4.4 acceptance: unexplained
 * differences offer an issue-report path carrying the reproduction inputs).
 *
 * The reproduction block is coordinates, not content: artifact/revision ids, target and
 * adapter keys, the non-default options (credential-shaped keys stripped and named as
 * withheld), the model fingerprints, and the component versions. No source bytes, option
 * secrets, or emitted content ever ride in the URL.
 *
 * @param input The failing response + the target's label + the configured options.
 * @returns The prefilled report; `url` opens GitHub's new-issue form with it.
 */
export function buildRoundtripIssueReport(input: RoundtripIssueInput): RoundtripIssueReport {
  const { response, targetLabel } = input;
  const { safe, redacted } = stripSecretOptions(input.options ?? null);
  const title = `Round-trip fidelity gap: ${response.emit_key} leaves ${
    response.unexplained.length > 0
      ? `${response.unexplained.length} difference${response.unexplained.length === 1 ? '' : 's'} unexplained`
      : `${response.overclaims.length} over-claim${response.overclaims.length === 1 ? '' : 's'}`
  }`;

  const lines: string[] = [
    '### What happened',
    '',
    `An on-demand round-trip comparison (Export Studio, IXH-4.4) of an export to **${targetLabel}** ` +
      'found differences the fidelity report does not account for.',
    '',
    '### Unexplained differences',
    '',
  ];
  if (response.unexplained.length > 0) {
    for (const entry of response.unexplained) {
      lines.push(`- ${changeKindLabel(entry.change)} ${diffEntryLabel(entry)}`);
    }
  } else {
    lines.push('- (none — see over-claims)');
  }
  if (response.overclaims.length > 0) {
    lines.push('', '### Over-claimed preservation', '');
    for (const item of response.overclaims) {
      lines.push(`- \`${item.construct}\` was reported preserved (ok) but changed or vanished`);
    }
  }
  if (response.reason) {
    lines.push('', '### Reported reason', '', '```', response.reason, '```');
  }
  lines.push(
    '',
    '### Reproduction coordinates',
    '',
    `- Target: \`${response.target}\` (emit key \`${response.emit_key}\`)`,
    `- Re-import adapter: \`${response.adapter_key ?? 'n/a'}\``,
    `- Artifact id: \`${response.artifact}\``,
    `- Revision: \`${response.version_record_id}\`${
      response.version_label ? ` (version ${response.version_label})` : ''
    }`,
    `- Options: ${safe ? `\`${JSON.stringify(safe)}\`` : 'target defaults'}${
      redacted.length > 0 ? ` (withheld credential-shaped keys: ${redacted.join(', ')})` : ''
    }`,
    `- Source fingerprint: \`${response.source_fingerprint}\``,
    `- Re-imported fingerprint: \`${response.reimported_fingerprint ?? 'n/a'}\``,
    `- Versions: apiome-rest \`${response.apiome_version}\`, emitter \`${response.emitter_version}\`, registry \`${response.registry_version}\``,
    '',
    '_Reported from the Export Studio round-trip comparison. No source content is included._',
  );

  let body = lines.join('\n');
  if (body.length > ISSUE_BODY_MAX_LENGTH) {
    body = `${body.slice(0, ISSUE_BODY_MAX_LENGTH)}\n\n_(clipped — full detail available by re-running the round trip)_`;
  }
  const url = `${ROUNDTRIP_ISSUE_BASE}?title=${encodeURIComponent(title)}&labels=${encodeURIComponent(
    'export,diff',
  )}&body=${encodeURIComponent(body)}`;
  return { title, body, url, redactedOptionKeys: redacted };
}
