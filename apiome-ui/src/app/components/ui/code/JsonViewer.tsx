'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { Braces, Check, Copy } from 'lucide-react';
import { cn } from '../../../../../lib/utils';
import {
  CODE_BLOCK_FONT_SIZE,
  CODE_BLOCK_LINE_HEIGHT,
  CODE_BLOCK_PADDING,
} from './editorTypography';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export interface JsonViewerProps {
  /** Pretty-printed source to display. */
  value: string;
  /** Optional header label (e.g. "Input schema"). Omit to render the editor chrome-free. */
  label?: string;
  /**
   * Monaco language id used for syntax highlighting. Defaults to `json` — the viewer began as a
   * JSON-only block (MFI-28.7) but is format-neutral, so pass e.g. `graphql`, `protobuf` or
   * `yaml` to highlight other sources.
   */
  language?: string;
  /** Clamp the auto-sized editor to this many visible lines (content beyond it scrolls). */
  maxLines?: number;
  className?: string;
}

/**
 * `<JsonViewer>` — a read-only, syntax-highlighted code block backed by monaco-editor. Auto-sizes to
 * the content (clamped to `maxLines`), follows the app's light/dark theme, supports code folding for
 * deep documents, and offers one-click copy. Renders an optional slim header bar with the label.
 *
 * Format-neutral: it defaults to JSON (its original use for MCP capability schemas & catalog models)
 * but takes a `language` prop for any monaco-supported source. Promoted from `ui/mcp/McpJsonViewer`
 * to `ui/code` in MFI-28.7 (#4123); `ui/mcp` keeps a back-compat re-export.
 */
export function JsonViewer({ value, label, language = 'json', maxLines = 24, className }: JsonViewerProps) {
  const [isDark, setIsDark] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Follow the app theme switch (the `.dark` class on <html>) so Monaco re-themes live.
  React.useEffect(() => {
    const sync = () => setIsDark(document.documentElement.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const lineCount = value ? value.split('\n').length : 1;
  const height = Math.min(Math.max(lineCount, 3), maxLines) * CODE_BLOCK_LINE_HEIGHT + CODE_BLOCK_PADDING;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard unavailable (permissions / insecure context) — leave the button as-is.
    }
  };

  const copyButton = (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied' : 'Copy'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium transition-colors',
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-700/60 dark:hover:text-gray-200',
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700',
        className,
      )}
    >
      {label ? (
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 py-1 pl-3 pr-1.5 dark:border-gray-700 dark:bg-gray-900/60">
          <span className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
            <Braces className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
            {label}
          </span>
          {copyButton}
        </div>
      ) : null}
      <div className="relative bg-white dark:bg-[#1e1e1e]">
        {!label ? <div className="absolute right-1.5 top-1.5 z-10">{copyButton}</div> : null}
        <MonacoEditor
          height={height}
          language={language}
          theme={isDark ? 'vs-dark' : 'light'}
          value={value}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            lineNumbers: 'on',
            lineNumbersMinChars: 3,
            folding: true,
            fontSize: CODE_BLOCK_FONT_SIZE,
            lineHeight: CODE_BLOCK_LINE_HEIGHT,
            padding: { top: 8, bottom: 8 },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
            contextmenu: false,
            links: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
