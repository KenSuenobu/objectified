'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronsDownUp,
  Copy,
  Download,
  FileArchive,
  Search,
  WrapText,
} from 'lucide-react';
import { cn } from '@lib/utils';
import { downloadBlob } from './exportDownload';

/** The file the actions act on; null while nothing is open (an empty bundle selection). */
export interface ViewerActionFile {
  /** The download filename / clipboard subject, e.g. `petstore.proto`. */
  name: string;
  /** The file's text. Empty while the file is deferred — copy/download then act on nothing. */
  text: string;
  /** The file's media type, used for the download blob; falls back to `text/plain`. */
  mediaType?: string;
}

export interface ViewerActionsBarProps {
  /** The active file. Copy/download are disabled when it is null or has no loaded text. */
  file: ViewerActionFile | null;
  /** Whether long lines soft-wrap in the viewer. */
  wordWrap: boolean;
  /** Toggle soft wrapping. */
  onWordWrapChange: (wordWrap: boolean) => void;
  /** Whether code folding is enabled in the viewer. */
  folding: boolean;
  /** Toggle code folding. */
  onFoldingChange: (folding: boolean) => void;
  /**
   * Open the editor's find widget. Omitted (or undefined) while no editor is mounted — the offline
   * `<pre>` fallback and a deferred file have nothing to search — which disables the action.
   */
  onFind?: (() => void) | null;
  /** Download the whole bundle as a `.zip`; omitted on single-document surfaces. */
  onDownloadBundle?: (() => void) | null;
  /** `data-testid` prefix so the two host surfaces expose distinct ids. */
  testIdPrefix: string;
  className?: string;
}

/**
 * ViewerActionsBar — the standard viewer actions shared by every export viewer surface
 * (MFX-43.5, #4365).
 *
 * One toolbar, mounted by both the single-document preview card (MFX-6.3) and the bundle explorer
 * (MFX-43.2), so the actions behave identically on every file type the registry can emit:
 * **copy file**, **download file**, **download bundle** (bundles only), **wrap**, **folding**, and
 * **find in file**. Copy and download read the text the caller hands them, so a file the viewer is
 * only showing the head of still copies and downloads *in full* — the guard bounds what Monaco
 * renders, never what the user can take away.
 *
 * The toggles are `aria-pressed` buttons rather than checkboxes: they act on the viewer immediately
 * and have no form semantics.
 */
export function ViewerActionsBar({
  file,
  wordWrap,
  onWordWrapChange,
  folding,
  onFoldingChange,
  onFind,
  onDownloadBundle,
  testIdPrefix,
  className,
}: ViewerActionsBarProps) {
  const [copied, setCopied] = useState(false);
  const hasContent = Boolean(file && file.text.length > 0);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyFile = useCallback(async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.text);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / denied permission) — leave the button unchanged.
    }
  }, [file]);

  const downloadFile = useCallback(() => {
    if (!file) return;
    downloadBlob(new Blob([file.text], { type: file.mediaType || 'text/plain' }), file.name);
  }, [file]);

  return (
    <div
      data-testid={`${testIdPrefix}-actions`}
      role="toolbar"
      aria-label="Viewer actions"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      <ActionButton
        testId={`${testIdPrefix}-copy`}
        label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied to clipboard' : 'Copy this file to the clipboard'}
        icon={copied ? Check : Copy}
        onClick={() => void copyFile()}
        disabled={!hasContent}
        tone={copied ? 'success' : 'default'}
      />
      <ActionButton
        testId={`${testIdPrefix}-download-file`}
        label="Download file"
        title={file ? `Download ${file.name}` : 'Download this file'}
        icon={Download}
        onClick={downloadFile}
        disabled={!hasContent}
      />
      {onDownloadBundle && (
        <ActionButton
          testId={`${testIdPrefix}-download-bundle`}
          label="Download .zip"
          title="Download every file in this bundle as a .zip"
          icon={FileArchive}
          onClick={onDownloadBundle}
        />
      )}
      <span className="xstd-viewer-sep" aria-hidden />
      <ActionButton
        testId={`${testIdPrefix}-wrap`}
        label="Wrap"
        title={wordWrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
        icon={WrapText}
        onClick={() => onWordWrapChange(!wordWrap)}
        pressed={wordWrap}
      />
      <ActionButton
        testId={`${testIdPrefix}-folding`}
        label="Folding"
        title={folding ? 'Turn code folding off' : 'Turn code folding on'}
        icon={ChevronsDownUp}
        onClick={() => onFoldingChange(!folding)}
        pressed={folding}
      />
      <ActionButton
        testId={`${testIdPrefix}-find`}
        label="Find"
        title="Find in this file"
        icon={Search}
        onClick={() => onFind?.()}
        disabled={!onFind || !hasContent}
      />
    </div>
  );
}

interface ActionButtonProps {
  testId: string;
  label: string;
  title: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  onClick: () => void;
  disabled?: boolean;
  /** Set for the toggles, which report their state through `aria-pressed`. */
  pressed?: boolean;
  tone?: 'default' | 'success';
}

/**
 * One toolbar button. Toggles pass `pressed`; momentary actions leave it undefined.
 *
 * The visible text is the accessible name — no `aria-label` — so the buttons read as what they
 * say ("Download file"), stay distinct from the surrounding surfaces' own download actions (which
 * name the file), and keep the tooltip free to carry the longer explanation.
 */
function ActionButton({
  testId,
  label,
  title,
  icon: Icon,
  onClick,
  disabled = false,
  pressed,
  tone = 'default',
}: ActionButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      // One shape for all three states: `aria-pressed` and `data-tone` carry the difference,
      // which is what lets the copied-confirmation and the toggled-on state be the same chip.
      className="xstd-chip"
      data-tone={tone === 'success' ? 'ok' : undefined}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}

export default ViewerActionsBar;
