'use client';

/**
 * The File intake (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` §File — a dashed drop zone that tints in
 * `--accent-soft` while a file is over it, the accepted-extension hint under the browse button,
 * a one-line file row with its size and a *Remove file* link, and the preview card with the
 * three tiles plus the title/description pair.
 *
 * It was ~200 lines inside `ImportDialog`'s render function, which is why the unsupported-format
 * and parse-error notices there were hand-built tinted boxes rather than the shared `Alert` the
 * rest of the app uses for exactly those two sentences.
 */

import * as React from 'react';
import { FileCode, Upload } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Card } from '@/app/components/ui/Card';
import { Spinner } from '@/app/components/ui/Spinner';
import { cn } from '@lib/utils';
import type { FileMetadataPreview } from '@/app/utils/openapi-analyzer';

import { IMPORT_FILE_EXTENSIONS, IMPORT_WIZARD_COPY } from './importWizardModel';
import { SpecMetaTiles } from './SpecMetaTiles';

export interface FileIntakePanelProps {
  /** The chosen file, or `null` before one is picked. */
  file: File | null;
  /** Its metadata once extracted; `null` for a ZIP, which is only read at Analyze. */
  metadata: FileMetadataPreview | null;
  /** Metadata extraction is in flight. */
  loading: boolean;
  /** A file was dragged over the zone. */
  dragging: boolean;
  onDragEnter: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  /** A file was chosen through the picker. */
  onPick: (file: File) => void;
  /** The *Remove file* link. */
  onRemove: () => void;
}

/** `1024`-based size, to one decimal — the unit the mockup's file row shows. */
function formatSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

/**
 * The drop zone, the file row and the preview card.
 *
 * The zone is a `<label>` wrapping a visually-hidden file input, so the whole surface is the
 * picker for a pointer *and* the input stays reachable by keyboard and named to a screen reader
 * — which a `<div role="button">` with a nested label was not.
 *
 * @param props See {@link FileIntakePanelProps}.
 * @returns The File intake.
 */
export function FileIntakePanel({
  file,
  metadata,
  loading,
  dragging,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onPick,
  onRemove,
}: FileIntakePanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <label
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn('imp-drop', dragging && 'imp-drop--over')}
      >
        <input
          type="file"
          className="sr-only"
          accept={IMPORT_FILE_EXTENSIONS.join(',')}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked) onPick(picked);
          }}
        />
        <span className="tnt-icon-tile imp-drop__glyph" data-tone="accent" aria-hidden>
          <Upload />
        </span>
        <span className="text-sm font-semibold text-fg">{IMPORT_WIZARD_COPY.dropTitle}</span>
        <span className="text-xs text-fg-muted">or</span>
        <span className="imp-drop__browse">{IMPORT_WIZARD_COPY.dropBrowse}</span>
        <span className="text-xs text-fg-muted">{IMPORT_WIZARD_COPY.dropExtensions}</span>
      </label>

      {file ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <FileCode className="size-[var(--icon-dense)] text-ok" aria-hidden />
          <span className="font-semibold text-fg">{file.name}</span>
          <span className="text-fg-muted">{formatSize(file.size)}</span>
          <button
            type="button"
            onClick={onRemove}
            className="text-sm font-medium text-danger hover:underline"
          >
            Remove file
          </button>
          {!metadata && !loading ? (
            <span className="ms-auto text-xs text-fg-muted">{IMPORT_WIZARD_COPY.zipNote}</span>
          ) : null}
        </div>
      ) : null}

      {file ? (
        <Card variant="flat" className="p-[var(--card-pad)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-fg">{IMPORT_WIZARD_COPY.filePreview}</span>
            {loading ? (
              <span className="flex items-center gap-2 text-xs text-fg-muted">
                <Spinner size="sm" />
                {IMPORT_WIZARD_COPY.analyzingFile}
              </span>
            ) : null}
          </div>

          {metadata ? (
            <div className="mt-3 flex flex-col gap-3">
              {!metadata.formatSupported && metadata.format !== 'unknown' ? (
                <Alert variant="warn">
                  <span className="font-semibold">Format not available for import</span> — the
                  detected format {metadata.formatDisplayName} is not yet supported for import.
                  Currently supported formats: OpenAPI 3.x, Swagger 2.x, JSON Schema, Arazzo, RAML,
                  AsyncAPI, GraphQL, Protobuf, Thrift, Avro, and Postman.
                </Alert>
              ) : null}

              {!metadata.syntaxValid ? (
                <Alert variant="danger">
                  <span className="font-semibold">File parse error</span> —{' '}
                  {metadata.parseError || 'Unable to parse file content'}
                </Alert>
              ) : null}

              <SpecMetaTiles metadata={metadata} />

              {metadata.title || metadata.description ? (
                <dl className="grid gap-4 sm:grid-cols-2">
                  {metadata.title ? (
                    <div>
                      <dt className="imp-tile__label">Title</dt>
                      <dd className="mt-1 text-sm font-medium text-fg">{metadata.title}</dd>
                    </div>
                  ) : null}
                  {metadata.description ? (
                    <div>
                      <dt className="imp-tile__label">Description</dt>
                      <dd className="mt-1 line-clamp-3 text-sm text-fg-muted">
                        {metadata.description}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </div>
          ) : loading ? null : (
            <p className="mt-3 text-sm text-fg-muted">{IMPORT_WIZARD_COPY.zipNote}</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}

export default FileIntakePanel;
