'use client';

/**
 * The OpenAPI spec viewer (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Spec viewer — the JSON / YAML segmented
 * switch over the code, then the two export cards (`VersionExportPanel`: best-fidelity and
 * lossy targets, recent exports), and Close · Copy · Download in the footer with the file
 * name beside Download.
 *
 * The spec is built by the screen (`buildOpenApiSpecJsonForVersion`) and handed in as text;
 * this owns the two renderings, the clipboard and the download — three things that read only
 * the text, the format and the names, and so belong beside them rather than in the screen.
 *
 * The editor is Monaco through `useHiveMonacoTheme`, so the code block follows the reader's
 * theme instead of the `vs-dark` the screen this replaces forced in every appearance.
 */

import * as React from 'react';
import dynamic from 'next/dynamic';
import { Copy, Download, FileJson2 } from 'lucide-react';
import { toast } from 'sonner';
import YAML from 'yaml';

import { Button } from '@/app/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/app/components/ui/Dialog';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';
import { useHiveMonacoTheme } from '@/app/components/ui/code/monacoHiveTheme';
import VersionExportPanel from '@/app/components/ade/dashboard/export/VersionExportPanel';

import { VersionDialogHead } from './VersionDialogChrome';
import { versionLabel, type Version } from './versionsModel';

/** The two renderings the viewer offers, in tab order. */
export const SPEC_FORMATS = ['json', 'yaml'] as const;

export type SpecFormat = (typeof SPEC_FORMATS)[number];

const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <LoadingState className="ver-spec__loading" minHeightClassName="min-h-0" spinnerSize="md" message="Loading editor…" />
  ),
});

export interface SpecViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The revision being viewed, or `null`. */
  version: Version | null;
  /** The owning project's name, for the description. */
  projectName?: string;
  /** The owning project's slug, for the download file name. */
  projectSlug?: string;
  /** The spec, as JSON text. */
  spec: string;
  /** True while the spec is being built. */
  loading: boolean;
  format: SpecFormat;
  onFormatChange: (next: SpecFormat) => void;
  /** Bumped when a new export lands, so the recent-exports card re-reads. */
  recentExportsRefresh: number;
}

/**
 * The spec in the chosen rendering.
 *
 * @param spec The JSON text.
 * @param format The rendering.
 * @returns The text to show, copy or download.
 */
export function renderSpec(spec: string, format: SpecFormat): string {
  if (format === 'json') return spec;
  return YAML.stringify(JSON.parse(spec || '{}'));
}

/**
 * The file name a download is saved as — `payments-api-2-3-1-openapi.json`.
 *
 * @param projectSlug The project's slug, or `undefined`.
 * @param versionId The version label, or `undefined`.
 * @param format The rendering.
 * @returns The file name.
 */
export function specDownloadName(
  projectSlug: string | undefined,
  versionId: string | undefined,
  format: SpecFormat
): string {
  const slug = projectSlug || 'api';
  const version = versionId?.replace(/\./g, '-') || '1-0-0';
  return `${slug}-${version}-openapi.${format === 'json' ? 'json' : 'yaml'}`;
}

/**
 * Render the dialog. See {@link SpecViewerDialogProps}.
 *
 * @returns The dialog.
 */
export default function SpecViewerDialog({
  open,
  onOpenChange,
  version,
  projectName,
  projectSlug,
  spec,
  loading,
  format,
  onFormatChange,
  recentExportsRefresh,
}: SpecViewerDialogProps) {
  const monaco = useHiveMonacoTheme();
  const fileName = specDownloadName(projectSlug, version?.version_id, format);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(renderSpec(spec, format));
    toast.success('Copied to clipboard!');
  };

  const handleDownload = () => {
    const content = renderSpec(spec, format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="ver-dialog" data-testid="spec-viewer-dialog">
        <VersionDialogHead
          icon={<FileJson2 />}
          tone="ok"
          title="OpenAPI 3.1.0 specification"
          description={
            version ? `${projectName ?? 'Project'} — ${versionLabel(version)}` : 'Specification'
          }
        />

        <div className="ver-dialog__body">
          <Segmented
            value={format}
            onValueChange={(next) => onFormatChange(next as SpecFormat)}
            size="sm"
            aria-label="Specification format"
            className="ver-spec__format"
          >
            {SPEC_FORMATS.map((entry) => (
              <SegmentedItem key={entry} value={entry} data-testid={`spec-format-tab-${entry}`}>
                {entry.toUpperCase()}
              </SegmentedItem>
            ))}
          </Segmented>

          <div className="ver-spec__editor" data-testid="spec-viewer-editor">
            {loading ? (
              <LoadingState className="ver-spec__loading" minHeightClassName="min-h-0" spinnerSize="md" message="Loading specification..." />
            ) : (
              <Editor
                height="100%"
                language={format}
                value={renderSpec(spec, format)}
                theme={monaco.theme}
                beforeMount={monaco.beforeMount}
                options={{ readOnly: true, minimap: { enabled: true }, fontSize: CODE_EDITOR_FONT_SIZE }}
              />
            )}
          </div>

          {/* Version-scoped export entry point (MFX-6.5, #3859): the fidelity pre-summary
              (best-fidelity vs lossy targets for this source) + this version's recent exports,
              rendered on the version view before the ExportDialog opens. */}
          {version ? (
            <VersionExportPanel
              artifact={version.project_id}
              version={version.id}
              artifactLabel={projectName}
              active={open}
              refreshToken={recentExportsRefresh}
            />
          ) : null}
        </div>

        <DialogFooter className="ver-dialog__footer">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="outline" onClick={() => void handleCopy()} disabled={loading} data-testid="spec-viewer-copy">
            <Copy aria-hidden />
            Copy
          </Button>
          <Button onClick={handleDownload} disabled={loading} data-testid="spec-viewer-download">
            <Download aria-hidden />
            Download
            <span className="ver-spec__filename mono">{fileName}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
