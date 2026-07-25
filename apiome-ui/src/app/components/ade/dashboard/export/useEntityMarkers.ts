'use client';

/**
 * useEntityMarkers — wires manifest entities onto a mounted Monaco viewer (IXH-4.1, #5109).
 *
 * The two-way half of the structural artifact explorer that lives inside the code viewer.
 * Given the **active file's** located entities and text it:
 *
 *  - decorates the selected entity's declaration line (whole-line highlight,
 *    {@link decorationsForEntity}), re-applying on selection/text change and clearing on
 *    unmount;
 *  - listens for editor clicks and resolves the clicked line to the innermost located
 *    entity ({@link entityAtLine}), reporting it through `onEntityLineClick` — the
 *    code → entity direction;
 *  - applies an external {@link EntityRevealRequest} — once per nonce, as soon as the
 *    entity's file is the active document — by scrolling its declaration line to center
 *    (the entity → code direction), queued until mount when the editor chunk is loading.
 *
 * Deliberately a sibling of `useProblemMarkers` rather than an extension of it: problems
 * and entities are different concerns with different owners, and both hooks compose on
 * one viewer by chaining their `onMount` handlers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  decorationsForEntity,
  entityAtLine,
  normalizedLocationFile,
  type EntityRevealRequest,
  type ExportManifestEntity,
} from './exportPreviewManifest';

export interface UseEntityMarkersOptions {
  /** The active file's located entities (already filtered to the active document). */
  entities: ExportManifestEntity[];
  /** The active file's bundle path (client-normalized), for click resolution. */
  activeFile: string | null;
  /** The active file's text — decorations are clamped against it. */
  text: string;
  /** The selected entity, or null; decorates its line when it lives in the active file. */
  selectedEntity?: ExportManifestEntity | null;
  /** Called when the user clicks an editor line that resolves to a located entity. */
  onEntityLineClick?: (entity: ExportManifestEntity) => void;
  /** An external "reveal this entity" request (a tree click); applied once per nonce. */
  reveal?: EntityRevealRequest | null;
}

export interface EntityMarkersHandle {
  /** Chain into `ReadOnlyCodeViewer`'s `onMount` — captures the editor + click listener. */
  onEditorMount: OnMount;
  /** Scroll an entity's declaration line to center (entity → code). */
  reveal: (entity: ExportManifestEntity) => void;
}

/**
 * Keep a Monaco viewer's entity decoration, click-through, and reveals in sync with the
 * active file's manifest entities.
 */
export function useEntityMarkers({
  entities,
  activeFile,
  text,
  selectedEntity = null,
  onEntityLineClick,
  reveal = null,
}: UseEntityMarkersOptions): EntityMarkersHandle {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  /** A reveal requested before the editor chunk mounted; applied on mount. */
  const pendingRevealRef = useRef<ExportManifestEntity | null>(null);
  /** The last external reveal nonce applied, so a request runs exactly once. */
  const handledRevealNonceRef = useRef<number | null>(null);
  const [mounted, setMounted] = useState(false);

  // The click listener registers once but must see current values — refs, synced in an
  // effect (never during render), keep it current without re-subscribing.
  const entitiesRef = useRef(entities);
  const activeFileRef = useRef(activeFile);
  const onEntityLineClickRef = useRef(onEntityLineClick);
  useEffect(() => {
    entitiesRef.current = entities;
    activeFileRef.current = activeFile;
    onEntityLineClickRef.current = onEntityLineClick;
  });

  const applyReveal = useCallback((entity: ExportManifestEntity) => {
    const ed = editorRef.current;
    if (!ed || entity.location?.line == null) return;
    const lineCount = ed.getModel()?.getLineCount() ?? entity.location.line;
    const line = Math.min(Math.max(1, entity.location.line), Math.max(1, lineCount));
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
  }, []);

  const onEditorMount = useCallback<OnMount>(
    (ed) => {
      editorRef.current = ed;
      ed.onMouseDown((event) => {
        const line = event.target?.position?.lineNumber;
        const file = activeFileRef.current;
        if (typeof line !== 'number' || !file) return;
        const hit = entityAtLine(entitiesRef.current, file, line);
        if (hit) onEntityLineClickRef.current?.(hit);
      });
      setMounted(true);
      const pending = pendingRevealRef.current;
      if (pending) {
        pendingRevealRef.current = null;
        applyReveal(pending);
      }
    },
    [applyReveal],
  );

  const revealNow = useCallback(
    (entity: ExportManifestEntity) => {
      if (!editorRef.current) {
        pendingRevealRef.current = entity;
        return;
      }
      applyReveal(entity);
    },
    [applyReveal],
  );

  // Re-apply the selected entity's line decoration whenever selection or document change.
  // Only a selection living in the active file decorates — no cross-file highlights.
  useEffect(() => {
    const ed = editorRef.current;
    if (!mounted || !ed) return undefined;
    const inActiveFile =
      selectedEntity != null &&
      activeFile != null &&
      normalizedLocationFile(selectedEntity) === activeFile;
    decorationsRef.current?.clear();
    decorationsRef.current = ed.createDecorationsCollection(
      decorationsForEntity(inActiveFile ? selectedEntity : null, text),
    );
    return () => {
      decorationsRef.current?.clear();
      decorationsRef.current = null;
    };
  }, [mounted, selectedEntity, activeFile, text]);

  // Apply an external reveal once per nonce, as soon as its entity's file is active (the
  // caller switches the active file; this effect re-runs when `activeFile` follows).
  useEffect(() => {
    if (!mounted || !reveal || reveal.nonce === handledRevealNonceRef.current) return;
    const file = normalizedLocationFile(reveal.entity);
    if (file == null || reveal.entity.location?.line == null) {
      // Nothing to scroll to — mark handled so a later legitimate request still fires.
      handledRevealNonceRef.current = reveal.nonce;
      return;
    }
    if (activeFile !== file) return; // The entity's file is not active (yet) — stay pending.
    handledRevealNonceRef.current = reveal.nonce;
    applyReveal(reveal.entity);
  }, [mounted, reveal, activeFile, applyReveal]);

  return { onEditorMount, reveal: revealNow };
}

export default useEntityMarkers;
