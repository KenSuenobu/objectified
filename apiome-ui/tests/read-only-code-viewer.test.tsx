/**
 * Render tests for the shared read-only Monaco viewer (MFX-43.1, #4361).
 *
 * The viewer must render its text read-only in Monaco with the given language, match the app
 * dark/light theme, forward its word-wrap and overlay, and expose stable test ids. Monaco is stubbed
 * with a lightweight component that echoes the props under test so the assertions never depend on the
 * real editor (or its web workers) loading.
 */

// Stub `@monaco-editor/react` with a component that surfaces the props under test.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({
    value,
    language,
    theme,
    height,
    options,
  }: {
    value?: string;
    language?: string;
    theme?: string;
    height?: string | number;
    options?: {
      wordWrap?: string;
      readOnly?: boolean;
      folding?: boolean;
      occurrencesHighlight?: string;
      bracketPairColorization?: { enabled?: boolean };
    };
  }) => (
    <div
      data-testid="mock-monaco"
      data-language={language}
      data-theme={theme}
      data-height={String(height)}
      data-wordwrap={options?.wordWrap}
      data-readonly={String(options?.readOnly)}
      data-folding={String(options?.folding)}
      data-occurrences={options?.occurrencesHighlight}
      data-brackets={String(options?.bracketPairColorization?.enabled)}
    >
      {value}
    </div>
  ),
}));

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReadOnlyCodeViewer } from '../src/app/components/ade/dashboard/export/ReadOnlyCodeViewer';

const PROTO = 'syntax = "proto3";\nmessage Order { string id = 1; }';

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('ReadOnlyCodeViewer (MFX-43.1)', () => {
  it('renders the text read-only in Monaco with the given language', async () => {
    render(<ReadOnlyCodeViewer value={PROTO} language="protobuf" />);

    const editor = await screen.findByTestId('mock-monaco');
    expect(editor).toHaveTextContent('syntax = "proto3"');
    expect(editor).toHaveAttribute('data-language', 'protobuf');
    expect(editor).toHaveAttribute('data-readonly', 'true');
    // Word-wrap is off by default (specs read horizontally).
    expect(editor).toHaveAttribute('data-wordwrap', 'off');
  });

  it('tags the container with the language for assertions and defaults its test id', async () => {
    render(<ReadOnlyCodeViewer value="scalar JSON" language="graphql" />);

    const container = await screen.findByTestId('read-only-code-editor');
    expect(container).toHaveAttribute('data-language', 'graphql');
  });

  it('honours custom test ids and an overlay control', async () => {
    render(
      <ReadOnlyCodeViewer
        value={PROTO}
        language="protobuf"
        editorTestId="export-artifact-editor"
        overlay={<button data-testid="my-overlay">Copy</button>}
      />,
    );

    expect(await screen.findByTestId('export-artifact-editor')).toBeInTheDocument();
    expect(screen.getByTestId('my-overlay')).toBeInTheDocument();
  });

  it('forwards word-wrap when requested', async () => {
    render(<ReadOnlyCodeViewer value={PROTO} language="protobuf" wordWrap="on" />);

    const editor = await screen.findByTestId('mock-monaco');
    expect(editor).toHaveAttribute('data-wordwrap', 'on');
  });

  it('uses the vs (light) theme by default', async () => {
    render(<ReadOnlyCodeViewer value={PROTO} language="protobuf" />);

    const editor = await screen.findByTestId('mock-monaco');
    expect(editor).toHaveAttribute('data-theme', 'vs');
  });

  it('matches the app dark theme when the html carries the dark class', async () => {
    document.documentElement.classList.add('dark');
    render(<ReadOnlyCodeViewer value={PROTO} language="protobuf" />);

    const editor = await screen.findByTestId('mock-monaco');
    expect(editor).toHaveAttribute('data-theme', 'vs-dark');
  });

  it('passes a concrete pixel height into Monaco (not a nested 100%)', async () => {
    render(<ReadOnlyCodeViewer value={PROTO} language="protobuf" />);

    const host = await screen.findByTestId('read-only-code-editor');
    const editor = await screen.findByTestId('mock-monaco');
    // Host + Monaco both get 360px — nested height:100% collapsed the editor to ~10px.
    expect(host).toHaveStyle({ height: '360px' });
    expect(editor).toHaveAttribute('data-height', '360');
    expect(editor).toHaveTextContent('syntax = "proto3"');
  });

  it('folds by default and honours the caller’s folding toggle (MFX-43.5)', async () => {
    const { rerender } = render(<ReadOnlyCodeViewer value={PROTO} language="protobuf" />);
    expect(await screen.findByTestId('mock-monaco')).toHaveAttribute('data-folding', 'true');

    rerender(<ReadOnlyCodeViewer value={PROTO} language="protobuf" folding={false} />);
    expect(screen.getByTestId('mock-monaco')).toHaveAttribute('data-folding', 'false');
  });

  it('keeps the rich editor features for an ordinary document (MFX-43.5)', async () => {
    render(<ReadOnlyCodeViewer value={PROTO} language="protobuf" />);

    const editor = await screen.findByTestId('mock-monaco');
    expect(editor).toHaveAttribute('data-occurrences', 'singleFile');
    expect(editor).toHaveAttribute('data-brackets', 'true');
  });

  it('drops the whole-model extras for a large document (MFX-43.5)', async () => {
    // 200 KB — past the heavy-feature threshold, so the per-model extras come off.
    render(<ReadOnlyCodeViewer value={'x'.repeat(200 * 1024)} language="json" />);

    const editor = await screen.findByTestId('mock-monaco');
    expect(editor).toHaveAttribute('data-occurrences', 'off');
    expect(editor).toHaveAttribute('data-brackets', 'false');
  });
});
