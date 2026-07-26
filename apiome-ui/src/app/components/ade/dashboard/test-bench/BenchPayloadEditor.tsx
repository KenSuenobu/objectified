'use client';

/**
 * BenchPayloadEditor (IXH-5.3, #5115).
 *
 * The Test Bench's payload editor: Monaco in JSON mode with validation findings applied as
 * inline markers (`setModelMarkers` under {@link BENCH_MARKER_OWNER}), plus a **Synthetic**
 * badge whenever the current content came from the IXH-5.2 generator — the label travels with
 * the payload, not just with the chip that loaded it.
 *
 * The editor exposes one imperative capability to the bench: `reveal(range)` scrolls/focuses a
 * finding's anchored range, which is how a click in the findings list lands on the offending
 * value.
 */

import dynamic from 'next/dynamic';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import type { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  BENCH_MARKER_OWNER,
  type BenchMarker,
  type EditorRange,
} from '@/app/utils/schema-test-bench';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

/** What the bench can ask the editor to do. */
export interface BenchPayloadEditorHandle {
  /** Scroll the range into view, place the cursor on it, and focus the editor. */
  reveal: (range: EditorRange) => void;
}

export interface BenchPayloadEditorProps {
  /** The payload text (controlled). */
  value: string;
  /** Called on every edit. */
  onChange: (value: string) => void;
  /** Inline markers for the current findings (empty clears them). */
  markers: BenchMarker[];
  /** Whether the current content is a generated payload (shows the Synthetic badge). */
  synthetic: boolean;
  /** Editor language — `json` unless the selected schema validates XML documents. */
  language?: 'json' | 'xml';
  /** Editor height in pixels. */
  height?: number;
}

/**
 * Render the payload editor. Markers are (re)applied whenever they or the model change, and
 * cleared on unmount so a stale model never keeps old squiggles.
 */
export const BenchPayloadEditor = forwardRef<BenchPayloadEditorHandle, BenchPayloadEditorProps>(
  function BenchPayloadEditor(
    { value, onChange, markers, synthetic, language = 'json', height = 320 },
    ref,
  ) {
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<Monaco | null>(null);

    const applyMarkers = useCallback((next: BenchMarker[]) => {
      const monaco = monacoRef.current;
      const model = editorRef.current?.getModel();
      if (!monaco || !model) return;
      monaco.editor.setModelMarkers(
        model,
        BENCH_MARKER_OWNER,
        next.map((marker) => ({
          severity: marker.severity,
          message: marker.message,
          startLineNumber: marker.startLine,
          startColumn: marker.startColumn,
          endLineNumber: marker.endLine,
          endColumn: marker.endColumn,
        })),
      );
    }, []);

    useEffect(() => {
      applyMarkers(markers);
    }, [markers, applyMarkers]);

    useEffect(
      () => () => {
        // Clear our owner's markers on unmount; the model may outlive this mount.
        const monaco = monacoRef.current;
        const model = editorRef.current?.getModel();
        if (monaco && model) monaco.editor.setModelMarkers(model, BENCH_MARKER_OWNER, []);
      },
      [],
    );

    useImperativeHandle(
      ref,
      () => ({
        reveal: (range: EditorRange) => {
          const ed = editorRef.current;
          if (!ed) return;
          ed.revealLineInCenter(range.startLine);
          ed.setPosition({ lineNumber: range.startLine, column: range.startColumn });
          ed.focus();
        },
      }),
      [],
    );

    return (
      <div className="relative overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        {synthetic ? (
          <span
            data-testid="test-bench-synthetic-badge"
            className="absolute right-2 top-2 z-10 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-800 dark:bg-violet-900/50 dark:text-violet-300"
            title="This payload was generated from the schema (IXH-5.2); it is not real data."
          >
            Synthetic
          </span>
        ) : null}
        <Editor
          height={height}
          language={language}
          value={value}
          onChange={(next) => onChange(next ?? '')}
          onMount={(ed, monaco) => {
            editorRef.current = ed;
            monacoRef.current = monaco;
            applyMarkers(markers);
          }}
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            tabSize: 2,
            wordWrap: 'on',
            ariaLabel: 'Payload editor',
          }}
        />
      </div>
    );
  },
);
