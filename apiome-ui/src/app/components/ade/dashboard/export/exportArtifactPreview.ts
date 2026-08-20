/**
 * Emitted-artifact preview helpers (MFX-6.3, #3857).
 *
 * After the export emits via `POST /api/export/document`, the ExportDialog shows the
 * artifact in a preview card before the user downloads it (single file or zip). This
 * module holds the pure pieces of that card:
 *
 * - the {@link EmittedArtifact} shape the dialog captures from the emit response;
 * - client-side well-formedness validation ({@link validateEmittedArtifact}) — JSON and
 *   YAML documents are re-parsed in the browser; formats without a client-side parser
 *   (e.g. `.proto`, `.graphql`) skip the check rather than fake it;
 * - the preview status badge ({@link buildArtifactBadge}) — the mockup's
 *   "valid · round-trip OK" chip. The "valid" half comes from the client-side parse; the
 *   round-trip half comes from the fidelity engine's per-construct loss report (MFX-2.5):
 *   a clean report predicts a lossless re-import, a lossy one predicts degradation. The
 *   badge hint spells out both bases, and the empirical (server-side) round-trip lands
 *   with MFX-5.3/6.4.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly —
 * mirroring `./exportFidelityPreview.ts`.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import { parse as parseYaml } from 'yaml';
import type { LossinessReport } from './exportFidelityPreview';

/** The emitted export document as captured from `POST /api/export/document` (MFX-6.3). */
export interface EmittedArtifact {
  /** The download filename, from the response's `Content-Disposition` header. */
  filename: string;
  /** The document's media type, from the response's `Content-Type` header ('' when absent). */
  mediaType: string;
  /** The document text itself. Emitted artifacts are always textual (JSON/YAML/SDL/proto). */
  text: string;
}

/** Which client-side well-formedness check applies to an emitted artifact. */
export type ArtifactSyntax = 'json' | 'yaml' | 'none';

/** The outcome of the client-side well-formedness check on an emitted artifact. */
export interface ArtifactValidation {
  /** The syntax the artifact was checked as (`none` when no client-side parser applies). */
  syntax: ArtifactSyntax;
  /** Whether a check ran at all — false for formats without a client-side parser. */
  checked: boolean;
  /** Whether the artifact parsed cleanly. Only meaningful when `checked` is true. */
  valid: boolean;
  /** The parse error message when the artifact failed to parse, else null. */
  error: string | null;
}

/** JSON-family filename extensions (`.avsc` is Avro's JSON schema format). */
const JSON_EXTENSIONS = ['.json', '.avsc'];

/** YAML filename extensions. */
const YAML_EXTENSIONS = ['.yaml', '.yml'];

/**
 * Decide which client-side well-formedness check applies to an emitted artifact, from its
 * media type (preferred) or filename extension (fallback).
 *
 * @param filename The download filename (e.g. `petstore.json`).
 * @param mediaType The response's `Content-Type` (e.g. `application/json`), '' when absent.
 * @returns The syntax to check as, or `none` when no client-side parser applies.
 */
export function detectArtifactSyntax(filename: string, mediaType: string): ArtifactSyntax {
  const media = (mediaType || '').toLowerCase();
  if (media.includes('json')) return 'json';
  if (media.includes('yaml')) return 'yaml';
  const name = (filename || '').toLowerCase();
  if (JSON_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'json';
  if (YAML_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'yaml';
  return 'none';
}

/**
 * Run the client-side well-formedness check on an emitted artifact: JSON documents must
 * `JSON.parse`, YAML documents must parse with the `yaml` package. Formats without a
 * client-side parser are reported as unchecked — the badge then makes no "valid" claim
 * instead of faking one.
 *
 * @param artifact The emitted artifact to check.
 * @returns The check outcome (syntax, whether it ran, validity, and any parse error).
 */
export function validateEmittedArtifact(artifact: EmittedArtifact): ArtifactValidation {
  const syntax = detectArtifactSyntax(artifact.filename, artifact.mediaType);
  if (syntax === 'none') {
    return { syntax, checked: false, valid: false, error: null };
  }
  try {
    if (syntax === 'json') {
      JSON.parse(artifact.text);
    } else {
      parseYaml(artifact.text);
    }
    return { syntax, checked: true, valid: true, error: null };
  } catch (e) {
    return {
      syntax,
      checked: true,
      valid: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The visual tone of the preview status badge. */
export type ArtifactBadgeTone = 'green' | 'amber' | 'red' | 'neutral';

/**
 * The badge tone → the shared vocabulary (HIVE-8.3, #5329).
 *
 * The four words here predate the vocabulary and name *hues*; the four on the right name
 * *meanings*. Keeping the pair rather than renaming the domain type is deliberate: the tone is
 * derived from parse + fidelity facts across three branches above, and renaming it would churn
 * every one of them to say nothing new.
 */
export const ARTIFACT_BADGE_TONE: Readonly<Record<ArtifactBadgeTone, StatusTone>> = {
  green: 'ok',
  amber: 'warn',
  red: 'danger',
  neutral: 'neutral',
};

/** The preview card's status badge: tone + chip label + the explanatory hint line. */
export interface ArtifactBadge {
  /** Visual tone: green = clean, amber = lossy, red = invalid, neutral = nothing to claim. */
  tone: ArtifactBadgeTone;
  /** The chip text (e.g. `valid · round-trip OK`). */
  label: string;
  /** One-line explanation of what the badge is based on, shown under the preview. */
  hint: string;
}

/**
 * Whether the fidelity report predicts a clean round-trip — no construct dropped,
 * approximated, or synthesized (only OK entries).
 *
 * @param report The per-construct loss report from the dry-run preview (MFX-2.5).
 * @returns True when every construct is carried faithfully.
 */
export function reportPredictsCleanRoundTrip(report: LossinessReport): boolean {
  const counts = report.kind_counts || {};
  return (counts.drop || 0) + (counts.approx || 0) + (counts.synth || 0) === 0;
}

/** Uppercase display name for a checked syntax (e.g. `JSON`). */
function syntaxLabel(syntax: ArtifactSyntax): string {
  return syntax.toUpperCase();
}

/**
 * Build the preview card's status badge (the mockup's "valid · round-trip OK" chip) from
 * the client-side check and the fidelity engine's loss report:
 *
 * - a failed parse is a red `invalid JSON`/`invalid YAML` — never downloadable-looking;
 * - a clean report reads `round-trip OK` (green), a lossy one `lossy round-trip` (amber),
 *   prefixed with `valid · ` when the client-side parse ran and passed;
 * - with neither a parser nor a report there is nothing honest to claim: neutral `emitted`.
 *
 * The hint always states the basis of each claim so the badge never overpromises — the
 * round-trip half is the engine's *prediction* until the server-side empirical round-trip
 * (MFX-5.3/6.4) lands.
 *
 * @param validation The client-side well-formedness outcome.
 * @param report The per-construct loss report from the dry-run preview, or null when the
 *   preview fetch failed or has not loaded.
 * @returns The badge tone, chip label, and explanatory hint.
 */
export function buildArtifactBadge(
  validation: ArtifactValidation,
  report: LossinessReport | null,
): ArtifactBadge {
  if (validation.checked && !validation.valid) {
    return {
      tone: 'red',
      label: `invalid ${syntaxLabel(validation.syntax)}`,
      hint: `The document failed to parse as ${syntaxLabel(validation.syntax)}: ${
        validation.error || 'unknown parse error'
      }`,
    };
  }

  const parseHint = validation.checked
    ? `Parsed in the browser as well-formed ${syntaxLabel(validation.syntax)}.`
    : 'This format has no client-side parser, so no validity claim is made here.';

  if (!report) {
    return {
      tone: validation.checked ? 'green' : 'neutral',
      label: validation.checked ? 'valid' : 'emitted',
      hint: `${parseHint} The fidelity report was unavailable for this export.`,
    };
  }

  const clean = reportPredictsCleanRoundTrip(report);
  const roundTripLabel = clean ? 'round-trip OK' : 'lossy round-trip';
  const roundTripHint = clean
    ? 'The fidelity engine predicts a clean round-trip — every construct is carried faithfully.'
    : 'The fidelity engine predicts this export degrades some constructs — review the fidelity report.';

  return {
    tone: clean ? 'green' : 'amber',
    label: validation.checked ? `valid · ${roundTripLabel}` : roundTripLabel,
    hint: `${parseHint} ${roundTripHint}`,
  };
}

/**
 * The UTF-8 byte length of a text document (what the saved file will weigh).
 *
 * @param text The document text.
 * @returns The encoded byte count.
 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Format a byte count for the preview meta line (`312 B`, `4.2 KB`, `1.3 MB`).
 *
 * @param bytes A non-negative byte count.
 * @returns The human-readable size.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Derive the zip download's filename from the emitted document's filename by swapping
 * the extension (`petstore.proto` → `petstore.zip`).
 *
 * @param filename The emitted document's filename.
 * @returns The `.zip` filename for the bundled download.
 */
export function zipFilenameFor(filename: string): string {
  const name = filename || 'export';
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return `${stem || 'export'}.zip`;
}
