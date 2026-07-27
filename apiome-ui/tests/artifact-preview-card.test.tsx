/**
 * Render tests for the emitted-artifact preview card (MFX-6.3), now backed by the shared read-only
 * viewer and the registry-driven language resolver (MFX-43.1, #4361).
 *
 * The card must resolve its highlight language registry-driven — the emitter key when known, else the
 * artifact's own media type / filename — and keep the stable test ids the export dialog relies on.
 * Monaco is stubbed so the assertions never depend on the real editor loading.
 */

jest.mock('@monaco-editor/react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const findAction = { run: jest.fn() };
  // The marker hooks (MFX-43.3 / IXH-4.1) decorate the editor on mount, so the fake needs the
  // handles they touch as well as the `getAction` the MFX-43.5 find action uses.
  const editor = {
    getAction: jest.fn(() => findAction),
    getModel: () => ({ getLineCount: () => 1000, isDisposed: () => false }),
    revealLineInCenter: jest.fn(),
    setPosition: jest.fn(),
    focus: jest.fn(),
    onMouseDown: () => ({ dispose: () => undefined }),
    createDecorationsCollection: jest.fn(() => ({ clear: jest.fn(), set: jest.fn() })),
  };
  const monaco = { editor: { setModelMarkers: jest.fn() } };
  const harness = { editor, findAction, reset: () => findAction.run.mockClear() };
  function MockMonaco({
    value,
    language,
    options,
    onMount,
  }: {
    value?: string;
    language?: string;
    options?: { wordWrap?: string; folding?: boolean };
    onMount?: (ed: typeof editor, m: typeof monaco) => void;
  }) {
    React.useEffect(() => {
      onMount?.(editor, monaco);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div
        data-testid="mock-monaco"
        data-language={language}
        data-wordwrap={options?.wordWrap}
        data-folding={String(options?.folding)}
      >
        {value}
      </div>
    );
  }
  return { __esModule: true, default: MockMonaco, __harness: harness };
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ArtifactPreviewCard } from '../src/app/components/ade/dashboard/export/ArtifactPreviewCard';
import type { EmittedArtifact } from '../src/app/components/ade/dashboard/export/exportArtifactPreview';
import { VIEWER_INLINE_FILE_CAP_BYTES } from '../src/app/components/ade/dashboard/export/exportViewerGuards';

const { __harness: monacoHarness } = jest.requireMock<{
  __harness: { findAction: { run: jest.Mock }; reset: () => void };
}>('@monaco-editor/react');

function renderCard(artifact: EmittedArtifact, targetKey?: string | null) {
  return render(<ArtifactPreviewCard artifact={artifact} report={null} targetKey={targetKey} />);
}

describe('ArtifactPreviewCard language resolution (MFX-43.1)', () => {
  it('keeps its stable test ids and the copy control', async () => {
    renderCard({ filename: 'api.proto', mediaType: 'text/plain', text: 'syntax = "proto3";' }, 'protobuf');

    expect(await screen.findByTestId('export-artifact-preview')).toBeInTheDocument();
    expect(screen.getByTestId('export-artifact-editor')).toBeInTheDocument();
    expect(screen.getByTestId('export-artifact-copy')).toBeInTheDocument();
  });

  it('trusts a known emitter key over the artifact bytes/headers', async () => {
    renderCard({ filename: 'api.proto', mediaType: 'text/plain', text: 'syntax = "proto3";' }, 'protobuf');

    expect(await screen.findByTestId('export-artifact-editor')).toHaveAttribute(
      'data-language',
      'protobuf',
    );
  });

  it('types an unknown emitter from the artifact media type (registry-driven)', async () => {
    renderCard(
      { filename: 'schema.txt', mediaType: 'application/graphql', text: 'type Query { a: Int }' },
      null,
    );

    expect(await screen.findByTestId('export-artifact-editor')).toHaveAttribute(
      'data-language',
      'graphql',
    );
  });

  it('types an unknown emitter from the filename when the media type is silent', async () => {
    renderCard({ filename: 'service.wsdl', mediaType: '', text: '<definitions/>' }, null);

    expect(await screen.findByTestId('export-artifact-editor')).toHaveAttribute('data-language', 'xml');
  });

  it('refines a JSON-or-YAML emitter from the emitted bytes', async () => {
    renderCard(
      { filename: 'openapi.yaml', mediaType: 'application/yaml', text: 'openapi: 3.1.0\ninfo:' },
      'openapi',
    );

    expect(await screen.findByTestId('export-artifact-editor')).toHaveAttribute('data-language', 'yaml');
  });
});

/** A document of `bytes` ASCII bytes, newline-delimited. */
function textOfBytes(bytes: number): string {
  const line = `${'x'.repeat(63)}\n`;
  return line.repeat(Math.ceil(bytes / 64)).slice(0, bytes);
}

describe('ArtifactPreviewCard — large-output guards + actions (MFX-43.5)', () => {
  beforeEach(() => monacoHarness.reset());

  it('mounts the standard viewer actions beside the document', () => {
    renderCard({ filename: 'api.proto', mediaType: 'text/plain', text: 'syntax = "proto3";' }, 'protobuf');

    expect(screen.getByTestId('export-artifact-actions')).toBeInTheDocument();
    for (const action of ['copy', 'download-file', 'wrap', 'folding', 'find']) {
      expect(screen.getByTestId(`export-artifact-${action}`)).toBeInTheDocument();
    }
    // A single document has no bundle to download.
    expect(screen.queryByTestId('export-artifact-download-bundle')).not.toBeInTheDocument();
  });

  it('drives wrap and folding into the editor', () => {
    renderCard({ filename: 'api.proto', mediaType: 'text/plain', text: 'syntax = "proto3";' }, 'protobuf');
    const editor = screen.getByTestId('mock-monaco');
    expect(editor).toHaveAttribute('data-wordwrap', 'off');
    expect(editor).toHaveAttribute('data-folding', 'true');

    fireEvent.click(screen.getByTestId('export-artifact-wrap'));
    expect(screen.getByTestId('mock-monaco')).toHaveAttribute('data-wordwrap', 'on');

    fireEvent.click(screen.getByTestId('export-artifact-folding'));
    expect(screen.getByTestId('mock-monaco')).toHaveAttribute('data-folding', 'false');
  });

  it('opens Monaco’s own find widget', () => {
    renderCard({ filename: 'api.proto', mediaType: 'text/plain', text: 'syntax = "proto3";' }, 'protobuf');
    fireEvent.click(screen.getByTestId('export-artifact-find'));
    expect(monacoHarness.findAction.run).toHaveBeenCalledTimes(1);
  });

  it('keeps a deliberately huge document out of the editor until asked', () => {
    const text = textOfBytes(VIEWER_INLINE_FILE_CAP_BYTES + 4_096);
    renderCard({ filename: 'huge.json', mediaType: 'application/json', text }, 'openapi');

    // Nothing was handed to Monaco — the editor is not even mounted.
    expect(screen.queryByTestId('export-artifact-editor')).not.toBeInTheDocument();
    const panel = screen.getByTestId('export-artifact-deferred');
    expect(panel).toHaveAttribute('data-reason', 'file-cap');
    expect(panel).toHaveTextContent(/huge\.json is 516\.0 KB — too large to render whole/);
    // Copy and download still work on the whole document.
    expect(screen.getByTestId('export-artifact-copy')).toBeEnabled();
    expect(screen.getByTestId('export-artifact-download-file')).toBeEnabled();
    // …and find has nothing to search yet.
    expect(screen.getByTestId('export-artifact-find')).toBeDisabled();
  });

  it('shows an explicitly truncated head once the user asks for it', () => {
    const text = textOfBytes(VIEWER_INLINE_FILE_CAP_BYTES + 4_096);
    renderCard({ filename: 'huge.json', mediaType: 'application/json', text }, 'openapi');

    fireEvent.click(screen.getByTestId('export-artifact-load'));

    // The editor holds a slice, and the truncation is stated — never a silent cut.
    const editor = screen.getByTestId('mock-monaco');
    expect(editor.textContent?.length ?? 0).toBeLessThan(text.length);
    expect(screen.getByTestId('export-artifact-truncated')).toHaveTextContent(
      /Showing the first 128\.0 KB of 516\.0 KB/,
    );
    expect(screen.getByTestId('export-artifact-meta')).toHaveAttribute('data-truncated', 'true');
    expect(screen.getByTestId('export-artifact-truncated-download')).toBeInTheDocument();
  });

  it('says nothing about truncation for an ordinary document', () => {
    renderCard({ filename: 'api.proto', mediaType: 'text/plain', text: 'syntax = "proto3";' }, 'protobuf');
    expect(screen.queryByTestId('export-artifact-truncated')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-artifact-deferred')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-artifact-meta')).toHaveAttribute('data-truncated', 'false');
  });
});
