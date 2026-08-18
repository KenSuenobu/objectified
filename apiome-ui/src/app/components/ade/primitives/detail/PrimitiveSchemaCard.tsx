'use client';

/**
 * The JSON Schema pane of the primitive-detail page (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §JSON Schema — the card head with the
 * dialect in its title, Copy and Download beside it, and a read-only viewer sized to the
 * document.
 *
 * ### Two things changed and one did not
 *
 * The mockup draws the schema in a `code--dark` `<pre>`. That is a black box on a page the
 * reader may have asked to be pale, and it is also where a reader folds a 400-line document —
 * so the pane stays the shared {@link ReadOnlyCodeViewer}, now asking for the Hive palette
 * rather than Monaco's `vs-dark`. The pane's *box* is a `rem` length from
 * {@link schemaPaneHeight}, which is what makes it follow the font-scale preference; Monaco's
 * own type remains the documented pixel exemption `ui/code/editorTypography.ts` owns.
 *
 * What did not change is the file: Copy writes the same bytes Download saves, both through the
 * caller's one handler, so the clipboard and the disk can never disagree.
 */

import * as React from 'react';
import { Braces, Check, Copy, Download } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/app/components/ui/Card';
import { ReadOnlyCodeViewer } from '@/app/components/ade/dashboard/export/ReadOnlyCodeViewer';
import { exportFileName } from '@/app/ade/dashboard/primitives/primitiveDetailModel';

import { DEFAULT_DRAFT, copyButtonState, schemaPaneHeight } from './primitiveDetailView';

export interface PrimitiveSchemaCardProps {
  /** The type's name — the viewer's document label and the download's filename. */
  name: string;
  /** The dialect the row declares, for the card's title. */
  draft?: string;
  /** The schema, already pretty-printed — the same string Copy and Download hand over. */
  json: string;
  /** Whether the last clipboard write succeeded. */
  copied: boolean;
  /** Whether it threw — an insecure context, or a denied permission. */
  copyFailed: boolean;
  /** Write {@link json} to the clipboard. */
  onCopy: () => void;
  /** Save {@link json} as `<slug>.schema.json`. */
  onDownload: () => void;
}

/**
 * Render the card. See {@link PrimitiveSchemaCardProps}.
 *
 * @returns The head with its two actions, and the schema pane under it.
 */
export default function PrimitiveSchemaCard({
  name,
  draft,
  json,
  copied,
  copyFailed,
  onCopy,
  onDownload,
}: PrimitiveSchemaCardProps) {
  const copy = copyButtonState(copied, copyFailed);
  const fileName = exportFileName(name);

  return (
    <Card data-testid="primitive-detail-schema">
      <CardHeader className="pd-head">
        {/* `h2` rather than `CardTitle`'s `h3`: the page's `h1` is the type's name, and these
            cards are its top-level sections. */}
        <h2 className="prm-panel-head__title">
          <Braces aria-hidden />
          JSON Schema ({draft ?? DEFAULT_DRAFT})
        </h2>
        <div className="pd-head__actions" role="group" aria-label="JSON Schema actions">
          {/* The visible text is the accessible name — no `aria-label` — which leaves the
              tooltip free for the longer sentence. */}
          <Button
            variant="outline"
            size="sm"
            data-testid="primitive-detail-schema-copy"
            title={copy.title}
            onClick={onCopy}
          >
            {copy.acknowledged && copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copy.label}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="primitive-detail-schema-download"
            title={`Download ${fileName}`}
            onClick={onDownload}
          >
            <Download aria-hidden />
            Download
          </Button>
        </div>
      </CardHeader>

      <CardBody>
        <ReadOnlyCodeViewer
          value={json}
          language="json"
          theme="hive"
          height={schemaPaneHeight(json)}
          documentLabel={`${name} JSON Schema`}
          className="pd-viewer"
          editorTestId="primitive-detail-schema-editor"
          fallbackTestId="primitive-detail-schema-fallback"
        />
      </CardBody>
    </Card>
  );
}
