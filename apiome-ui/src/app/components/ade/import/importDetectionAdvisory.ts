/**
 * Advisory format detection for the Projects importer (FMT-1.1, #5412).
 *
 * The Projects importer analyzes with the local OpenAPI/Swagger/Arazzo analyzer, which recognizes
 * only that family. It used to compensate by refusing any file outside a hard-coded ten-extension
 * list — which made thirty-three registered adapters unreachable, and told a user with a perfectly
 * good `.tsp` nothing except that its extension was not on a list.
 *
 * The filename is no longer a gate. When the local analyzer cannot place a document, the bytes go
 * to `POST /api/import/detect` — the same registry-wide sniff the Catalog importer uses — and the
 * user is told what the file actually *is*, and where it can be imported. Content sniffing is the
 * authority; the extension was only ever a hint.
 */

/** The `detected` block of a `POST /api/import/detect` response. */
export interface DetectedFormat {
  format?: string | null;
  confidence?: number | null;
  reason?: string | null;
  source_key?: string | null;
  importable?: boolean | null;
}

/** The `POST /api/import/detect` response shape, as far as this advisory needs it. */
export interface DetectionResponse {
  matched?: boolean;
  detected?: DetectedFormat | null;
  ambiguous?: boolean;
}

/**
 * Turn a detector verdict into the sentence shown to the user.
 *
 * Pure, so the wording is unit-testable without a fetch.
 *
 * @param filename The file the user picked, named back to them.
 * @param detection The detector's response, or `null` when the call failed.
 * @returns The advisory sentence, or `null` when there is nothing useful to add — either the
 *   detector was unreachable or it recognized nothing, in which case the analyzer's own parse error
 *   is already the better message and a vague second line would only muddy it.
 */
export function describeDetectionVerdict(
  filename: string,
  detection: DetectionResponse | null,
): string | null {
  if (!detection || !detection.matched) return null;

  const detected = detection.detected;
  const format = typeof detected?.format === 'string' ? detected.format.trim() : '';
  if (!format) return null;

  const ambiguity = detection.ambiguous
    ? ' The content was ambiguous, so double-check the format before importing.'
    : '';

  if (detected?.importable) {
    return (
      `"${filename}" looks like ${format}, which this importer does not read — it handles ` +
      `OpenAPI, Swagger and Arazzo. Import ${format} from the Catalog importer instead.` +
      ambiguity
    );
  }

  return (
    `"${filename}" looks like ${format}, but no import source can read that format yet.` + ambiguity
  );
}

/**
 * Ask the detector what a document is, and phrase the answer for the user.
 *
 * Never throws and never rejects: this runs *after* an analysis has already failed, so a detector
 * that is down must leave the analyzer's own error standing rather than replacing it with a network
 * error the user can do nothing about.
 *
 * @param content The document's text, sent to the registry-wide sniffer.
 * @param filename The file's name, used as a detection hint and quoted in the message.
 * @returns The advisory sentence, or `null` when the detector added nothing.
 */
export async function detectAndDescribe(content: string, filename: string): Promise<string | null> {
  try {
    const res = await fetch('/api/import/detect', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content, filename }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as DetectionResponse;
    return describeDetectionVerdict(filename, data);
  } catch {
    return null;
  }
}
