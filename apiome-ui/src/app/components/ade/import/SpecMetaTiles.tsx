'use client';

/**
 * The three preview tiles every intake shows once it has content (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` — *Detected format · Version · Syntax*, in
 * that order, on File, URL and Clipboard alike.
 *
 * Four panels drew this trio independently before, each with its own green/amber/red tinted
 * boxes; the tint is gone (a *detected format* is information, not a status) and only the glyph
 * carries the verdict, which is what keeps the row legible in the seven themes where a `-soft`
 * fill and `-fg` ink are not calibrated for each other.
 */

import * as React from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

import type { FileMetadataPreview } from '@/app/utils/openapi-analyzer';

/** The verdict a tile's glyph carries, or `none` for a tile that is only a value. */
type TileVerdict = 'ok' | 'warn' | 'danger' | 'none';

/** One tile. */
function MetaTile({
  label,
  value,
  verdict = 'none',
}: {
  label: string;
  value: React.ReactNode;
  verdict?: TileVerdict;
}) {
  return (
    <div className="imp-tile">
      <div className="imp-tile__label">{label}</div>
      <div className="imp-tile__value">
        {verdict === 'ok' ? <CheckCircle2 className="text-ok" aria-hidden /> : null}
        {verdict === 'warn' ? <AlertTriangle className="text-warn" aria-hidden /> : null}
        {verdict === 'danger' ? <AlertTriangle className="text-danger" aria-hidden /> : null}
        <span>{value}</span>
      </div>
    </div>
  );
}

export interface SpecMetaTilesProps {
  /** The metadata the intake extracted. */
  metadata: FileMetadataPreview;
}

/**
 * Format, version and syntax, read off an intake's metadata.
 *
 * @param props See {@link SpecMetaTilesProps}.
 * @returns The three-tile row.
 */
export function SpecMetaTiles({ metadata }: SpecMetaTilesProps) {
  return (
    <div className="imp-tiles">
      <MetaTile
        label="Detected format"
        value={metadata.formatDisplayName}
        verdict={metadata.formatSupported ? 'ok' : 'warn'}
      />
      <MetaTile label="Version" value={metadata.specVersion || metadata.version || 'N/A'} />
      <MetaTile
        label="Syntax"
        value={metadata.syntaxValid ? `Valid ${metadata.syntax.toUpperCase()}` : 'Invalid'}
        verdict={metadata.syntaxValid ? 'ok' : 'danger'}
      />
    </div>
  );
}

export default SpecMetaTiles;
