'use client';

/**
 * The *Metadata* tab of the Create-new-project dialog (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Create New Project → Metadata — a
 * read-only reference view: the detected summary, the original `info` block, the spec context,
 * and the `externalDocs` when the file has one.
 *
 * ### What changed besides the paint
 *
 * The three JSON blocks were `<pre className="bg-gray-950 text-gray-100">` — one hue frozen
 * against every theme, no syntax highlighting, no way to copy, and no folding for a document
 * with a deep `info`. They are `ui/code`'s {@link JsonViewer} now, which is the block the rest
 * of the app already reads JSON in: themed, foldable, copyable, and clamped to a readable
 * number of lines with the remainder scrolling inside itself.
 *
 * The truncation and parse-error lines were `text-amber-700 dark:text-amber-300` sentences
 * floating between cards. They are `Alert`s, so a reader who is skimming sees that the panel
 * is qualified before they read the values it is qualifying.
 */

import { useMemo } from 'react';

import { Alert } from '@/app/components/ui/Alert';
import { Card, CardContent } from '@/app/components/ui/Card';
import { JsonViewer } from '@/app/components/ui/code';
import { extractRepositorySpecOriginalMetadata } from '@lib/project-draft-from-repository-spec';
import {
  formatMetadataCell,
  type ParsedRepositorySpecMetadata,
} from '@lib/repository-file-spec-metadata';
import { cn } from '@lib/utils';

/**
 * Pretty-print a value for the read-only viewer.
 *
 * @param value Any JSON-serialisable value from the parsed document.
 * @returns Indented JSON, the value's string form when it will not serialise, or an em dash.
 */
function formatMetadataJson(value: unknown): string {
  if (value == null) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface RepositoryImportSpecMetadataPanelProps {
  /** The loaded file's text. */
  content: string;
  /** Repository-relative path, used to pick the parser and shown in the summary. */
  path: string;
  /** The already-parsed summary, so the panel does not parse the file a second time. */
  specMetadata: ParsedRepositorySpecMetadata;
  /** True when the server capped the body — every count below is then a lower bound. */
  truncated?: boolean;
  /** Extra classes for the panel. */
  className?: string;
}

/**
 * Render the panel. See {@link RepositoryImportSpecMetadataPanelProps}.
 *
 * @returns The reference view: a standing note, the detected summary, and up to three JSON
 *   blocks lifted verbatim from the file.
 */
export default function RepositoryImportSpecMetadataPanel({
  content,
  path,
  specMetadata,
  truncated = false,
  className,
}: RepositoryImportSpecMetadataPanelProps) {
  const original = useMemo(
    () => extractRepositorySpecOriginalMetadata(content, path),
    [content, path]
  );

  const hasSpecContext = Object.keys(original.specContext).length > 0;
  const hasPayload = original.payload != null && Object.keys(original.payload).length > 0;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <Alert variant="info">
        This is a read-only view used only for reference. Values shown here come directly from
        the imported file and are not editable.
      </Alert>

      {truncated ? (
        <Alert variant="warn">
          File body is truncated; the metadata below reflects only the loaded portion.
        </Alert>
      ) : null}

      {original.parseError ? (
        <Alert variant="warn">Could not parse as YAML/JSON: {original.parseError}</Alert>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="repo-det-card__title">Detected summary</h3>
            <p className="repo-det-note">
              Client-side parse of <span className="mono">{path}</span>
            </p>
          </div>
          {specMetadata.format === 'unknown' && !specMetadata.parseError ? (
            <p className="repo-det-note">
              No recognised OpenAPI, Swagger, AsyncAPI, Arazzo, JSON Schema, or GraphQL SDL
              structure in this file.
            </p>
          ) : (
            <dl className="repo-file-kv">
              <dt>Spec</dt>
              <dd>{specMetadata.spec ?? '—'}</dd>
              <dt>Title</dt>
              <dd>{specMetadata.title ?? '—'}</dd>
              <dt>Version</dt>
              <dd className="mono">{specMetadata.version ?? '—'}</dd>
              <dt>Endpoints</dt>
              <dd className="mono">{formatMetadataCell(specMetadata.endpoints)}</dd>
              <dt>Components</dt>
              <dd className="mono">{formatMetadataCell(specMetadata.components)}</dd>
              <dt>Servers</dt>
              <dd className="mono">{formatMetadataCell(specMetadata.servers)}</dd>
            </dl>
          )}
        </CardContent>
      </Card>

      {hasSpecContext ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <h3 className="repo-det-card__title">Spec context</h3>
            <JsonViewer value={formatMetadataJson(original.specContext)} maxLines={12} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-3">
          <h3 className="repo-det-card__title">
            Original metadata
            {original.sectionLabel !== '—' ? (
              <span className="repo-det-note mono">({original.sectionLabel})</span>
            ) : null}
          </h3>
          {original.format === 'graphql' ? (
            <p className="repo-det-note">
              GraphQL SDL files do not expose a structured metadata block like OpenAPI{' '}
              <span className="mono">info</span>. Use the detected summary above, or switch to
              Form to enter the project details manually.
            </p>
          ) : hasPayload ? (
            <div data-testid="repository-import-spec-original-metadata">
              <JsonViewer value={formatMetadataJson(original.payload)} maxLines={20} />
            </div>
          ) : (
            <p className="repo-det-note">
              No metadata block was found in this file for reference.
            </p>
          )}
        </CardContent>
      </Card>

      {original.externalDocs && original.sectionLabel === 'info' ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <h3 className="repo-det-card__title">Original externalDocs</h3>
            <JsonViewer value={formatMetadataJson(original.externalDocs)} maxLines={12} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
