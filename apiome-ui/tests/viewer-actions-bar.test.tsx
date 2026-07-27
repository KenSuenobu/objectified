/**
 * Render tests for the shared viewer actions bar (MFX-43.5, #4365).
 *
 * The bar is the "actions work on every file type" half of the ticket: copy file, download file,
 * download bundle, wrap, folding, and find-in-file, mounted identically by the single-document
 * preview card and the bundle explorer. It must act on the text it is handed (so a partially
 * rendered file still copies and downloads *whole*), report its toggles through `aria-pressed`,
 * and disable what cannot work rather than failing silently.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ViewerActionsBar } from '../src/app/components/ade/dashboard/export/ViewerActionsBar';

const FILE = { name: 'petstore.proto', text: 'syntax = "proto3";', mediaType: 'text/plain' };

/** Render the bar with sensible defaults; override any prop. */
function renderBar(props: Partial<React.ComponentProps<typeof ViewerActionsBar>> = {}) {
  const onWordWrapChange = jest.fn();
  const onFoldingChange = jest.fn();
  const utils = render(
    <ViewerActionsBar
      file={FILE}
      wordWrap={false}
      onWordWrapChange={onWordWrapChange}
      folding
      onFoldingChange={onFoldingChange}
      testIdPrefix="viewer"
      {...props}
    />,
  );
  return { ...utils, onWordWrapChange, onFoldingChange };
}

/** Capture what `downloadBlob` handed the browser, by spying on the anchor click + object URL. */
function captureDownload() {
  const created: Blob[] = [];
  const names: string[] = [];
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = jest.fn((blob: Blob) => {
    created.push(blob);
    return 'blob:mock';
  });
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn();
  jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
  return { created, names };
}

afterEach(() => jest.restoreAllMocks());

describe('ViewerActionsBar — standard actions (MFX-43.5)', () => {
  it('renders one toolbar with every standard action', () => {
    renderBar({ onFind: jest.fn(), onDownloadBundle: jest.fn() });
    const bar = screen.getByTestId('viewer-actions');
    expect(bar).toHaveAttribute('role', 'toolbar');
    for (const action of ['copy', 'download-file', 'download-bundle', 'wrap', 'folding', 'find']) {
      expect(screen.getByTestId(`viewer-${action}`)).toBeInTheDocument();
    }
  });

  it('omits the bundle download on a single-document surface', () => {
    renderBar();
    expect(screen.queryByTestId('viewer-download-bundle')).not.toBeInTheDocument();
  });

  it('copies the file text and confirms it', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderBar();

    fireEvent.click(screen.getByTestId('viewer-copy'));
    await waitFor(() => expect(screen.getByTestId('viewer-copy')).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith('syntax = "proto3";');
  });

  it('survives a clipboard the browser refuses', async () => {
    const writeText = jest.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderBar();

    fireEvent.click(screen.getByTestId('viewer-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // No confirmation is claimed for a copy that did not happen.
    expect(screen.getByTestId('viewer-copy')).toHaveTextContent('Copy');
  });

  it('downloads the file under its own name and media type', () => {
    const { created, names } = captureDownload();
    renderBar();

    fireEvent.click(screen.getByTestId('viewer-download-file'));
    expect(names).toEqual(['petstore.proto']);
    expect(created[0].type).toBe('text/plain');
  });

  it('downloads a file with no media type as plain text', () => {
    const { created } = captureDownload();
    renderBar({ file: { name: 'schema.avsc', text: '{}' } });

    fireEvent.click(screen.getByTestId('viewer-download-file'));
    expect(created[0].type).toBe('text/plain');
  });

  it('takes the whole file even when the viewer is only showing part of it', () => {
    const { created } = captureDownload();
    // The host hands the bar the full text; the guard only bounds what Monaco renders.
    renderBar({ file: { name: 'huge.json', text: 'the-whole-thing', mediaType: 'application/json' } });

    fireEvent.click(screen.getByTestId('viewer-download-file'));
    expect(created[0].size).toBe('the-whole-thing'.length);
  });

  it('toggles wrap and folding through aria-pressed', () => {
    const { onWordWrapChange, onFoldingChange } = renderBar();
    const wrap = screen.getByTestId('viewer-wrap');
    const folding = screen.getByTestId('viewer-folding');

    expect(wrap).toHaveAttribute('aria-pressed', 'false');
    expect(folding).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(wrap);
    expect(onWordWrapChange).toHaveBeenCalledWith(true);
    fireEvent.click(folding);
    expect(onFoldingChange).toHaveBeenCalledWith(false);
  });

  it('opens the find widget through the host', () => {
    const onFind = jest.fn();
    renderBar({ onFind });
    fireEvent.click(screen.getByTestId('viewer-find'));
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it('disables find when no editor can be searched', () => {
    renderBar({ onFind: null });
    expect(screen.getByTestId('viewer-find')).toBeDisabled();
  });

  it('disables the content actions when nothing is open', () => {
    renderBar({ file: null, onFind: jest.fn() });
    expect(screen.getByTestId('viewer-copy')).toBeDisabled();
    expect(screen.getByTestId('viewer-download-file')).toBeDisabled();
    expect(screen.getByTestId('viewer-find')).toBeDisabled();
    // The toggles still work — they are about the viewer, not the file.
    expect(screen.getByTestId('viewer-wrap')).toBeEnabled();
  });

  it('names its buttons by their visible text, not a hidden label', () => {
    renderBar({ onDownloadBundle: jest.fn() });
    // The surrounding surfaces have their own "Download <filename>" actions; these must stay
    // distinct so a query for one never matches the other.
    expect(screen.getByRole('button', { name: 'Download file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download petstore\.proto/i })).not.toBeInTheDocument();
  });
});
