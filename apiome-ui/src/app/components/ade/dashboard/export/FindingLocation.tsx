/**
 * FindingLocation — the one-line "file · pointer · line:col · rule" location under a Verify
 * finding, shared by the validation lens (MFX-42.2) and the lint lens (MFX-42.3).
 *
 * Renders only the location parts the validator/linter actually supplied, joined by a middle dot,
 * in a monospace, muted style. Returns null when nothing is known so callers can drop it without
 * an empty row. The same file/line/column carried here is what MFX-43.3 turns into Monaco
 * line markers, so keep the fields lossless.
 */

export interface FindingLocationProps {
  /** File within a multi-file bundle the finding is in, when applicable. */
  file?: string | null;
  /** JSON-pointer path into the emitted document, when provided. */
  path?: string | null;
  /** 1-based line number, when the tool reports a location. */
  line?: number | null;
  /** 1-based column number, when the tool reports a location. */
  column?: number | null;
  /** Validator/linter rule id or keyword that fired, when available. */
  rule?: string | null;
}

/**
 * The compact location line for a finding. Emits `file · path · line:col · rule` from whichever
 * parts are present; renders nothing when the finding carries no location at all.
 */
export function FindingLocation({ file, path, line, column, rule }: FindingLocationProps) {
  const parts: string[] = [];
  if (file) parts.push(file);
  if (path) parts.push(path);
  if (typeof line === 'number') parts.push(typeof column === 'number' ? `${line}:${column}` : `line ${line}`);
  if (rule) parts.push(rule);
  if (parts.length === 0) return null;
  return (
    <div className="xstd-finding__location" data-testid="verify-finding-location">
      {parts.join(' · ')}
    </div>
  );
}

export default FindingLocation;
