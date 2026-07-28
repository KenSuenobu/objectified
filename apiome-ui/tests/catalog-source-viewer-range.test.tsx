/**
 * Raw-source range highlighting in the catalog Source & Code viewer (CPDO-2.2, #4798).
 *
 * CPDO-2.1 could send the viewer a *line*, which is the best a copybook analyzer can offer. An X12
 * interchange is routinely written on a single line, so a line jump reveals the whole file and
 * points at nothing. The X12 scan records exact offsets, so the viewer selects those characters.
 *
 * The property under test is that the range is a **refinement** and never a replacement: the line
 * is revealed first, so a viewer that cannot select — the offline `<pre>` fallback, or an editor
 * build without the selection API — still lands the reader somewhere real rather than nowhere.
 */

// A Monaco stub that records the editor calls under test and hands back a model whose
// `getPositionAt` does the real offset → line/column arithmetic over the rendered text.
const editorCalls: {
  revealLineInCenter: jest.Mock;
  setPosition: jest.Mock;
  setSelection: jest.Mock;
  revealRangeInCenter: jest.Mock;
} = {
  revealLineInCenter: jest.fn(),
  setPosition: jest.fn(),
  setSelection: jest.fn(),
  revealRangeInCenter: jest.fn(),
};

/** Whether the stubbed editor exposes a model — false models the offline/limited editor. */
let editorHasModel = true;

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: function MockMonacoEditor({
    value,
    onMount,
  }: {
    value?: string;
    onMount?: (editor: unknown) => void;
  }) {
    const text = value ?? '';
    const editor = {
      ...editorCalls,
      getModel: () =>
        editorHasModel
          ? {
              getPositionAt: (offset: number) => {
                const before = text.slice(0, offset);
                const lines = before.split('\n');
                return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
              },
            }
          : null,
    };
    // `onMount` fires once, as the real editor does.
    React.useEffect(() => {
      onMount?.(editor);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="mock-monaco">{text}</div>;
  },
}));

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CatalogSourceViewer } from '../src/app/components/ade/dashboard/catalog/CatalogSourceViewer';
import { X12_SCANNED_SOURCE } from './helpers/payload-analysis-fixture';

const SOURCE_HREF = '/api/catalog/item-1/source';

/** The BEG segment of the shared X12 fixture — the range every case below selects. */
const BEG = 'BEG*00*NE*PO-0002**20260116';
const BEG_RANGE = { offset: X12_SCANNED_SOURCE.indexOf(BEG), length: BEG.length };

function mockSourceFetch(text: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    text: async () => text,
    json: async () => ({}),
  }) as unknown as typeof fetch;
}

function renderViewer(overrides: Partial<React.ComponentProps<typeof CatalogSourceViewer>> = {}) {
  return render(
    <CatalogSourceViewer
      sourceHref={SOURCE_HREF}
      sourceFormat="edix12"
      resolvedSource={undefined}
      downloadable
      hasContent
      sourceUri={null}
      active
      highlightOrigin="format-analysis"
      {...overrides}
    />,
  );
}

beforeEach(() => {
  // The stub's recorders live at module scope, so their history is cleared per test.
  jest.clearAllMocks();
  editorHasModel = true;
  mockSourceFetch(X12_SCANNED_SOURCE);
});

afterEach(() => jest.restoreAllMocks());

describe('range highlighting', () => {
  it('selects exactly the characters the construct was read from', async () => {
    renderViewer({ highlightLine: 4, highlightRange: BEG_RANGE, highlightLabel: 'Segment BEG' });
    await screen.findByTestId('mock-monaco');

    // The viewer both reveals on mount and re-reveals when the request changes, because the editor
    // may not exist yet when the effect first runs; every call must select the same range.
    expect(editorCalls.setSelection).toHaveBeenCalled();
    const selection = editorCalls.setSelection.mock.calls[0][0];
    expect(selection).toEqual({
      startLineNumber: 4,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: BEG.length + 1,
    });
    expect(editorCalls.revealRangeInCenter).toHaveBeenCalledWith(selection);
  });

  it('reveals the line first, so a range that cannot be selected still lands somewhere real', async () => {
    editorHasModel = false;
    renderViewer({ highlightLine: 4, highlightRange: BEG_RANGE });
    await screen.findByTestId('mock-monaco');

    expect(editorCalls.revealLineInCenter).toHaveBeenCalledWith(4);
    expect(editorCalls.setSelection).not.toHaveBeenCalled();
  });

  it('re-selects when a second construct is followed, without remounting the editor', async () => {
    const { rerender } = renderViewer({ highlightLine: 4, highlightRange: BEG_RANGE });
    await screen.findByTestId('mock-monaco');

    const po1 = 'PO1*2*20*EA*9.99';
    rerender(
      <CatalogSourceViewer
        sourceHref={SOURCE_HREF}
        sourceFormat="edix12"
        resolvedSource={undefined}
        downloadable
        hasContent
        sourceUri={null}
        active
        highlightOrigin="format-analysis"
        highlightLine={6}
        highlightRange={{ offset: X12_SCANNED_SOURCE.indexOf(po1), length: po1.length }}
      />,
    );

    const calls = editorCalls.setSelection.mock.calls;
    expect(calls[calls.length - 1][0].startLineNumber).toBe(6);
    // One fetch: the source was not re-requested for the second construct.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when no range and no line are requested', async () => {
    renderViewer();
    await screen.findByTestId('mock-monaco');

    expect(editorCalls.setSelection).not.toHaveBeenCalled();
    expect(editorCalls.revealLineInCenter).not.toHaveBeenCalled();
    expect(screen.queryByTestId('catalog-detail-source-highlight')).not.toBeInTheDocument();
  });
});

describe('the highlight note', () => {
  it('names the construct and the exact range it selected', async () => {
    renderViewer({ highlightLine: 4, highlightRange: BEG_RANGE, highlightLabel: 'Segment BEG' });

    const note = await screen.findByTestId('catalog-detail-source-highlight');
    expect(note).toHaveTextContent('Format details construct');
    expect(note).toHaveTextContent('Segment BEG');
    expect(note).toHaveTextContent(`selecting ${BEG.length} characters from offset ${BEG_RANGE.offset}`);
    expect(note).toHaveTextContent('on line 4');
  });

  it('still describes a line-only jump the way it always did', async () => {
    renderViewer({ highlightLine: 12, focusSourcePath: 'claim.cpy' });

    const note = await screen.findByTestId('catalog-detail-source-highlight');
    expect(note).toHaveTextContent('claim.cpy');
    expect(note).toHaveTextContent('highlighting line 12');
    expect(note).not.toHaveTextContent('selecting');
  });

  it('describes a range that carries no line without inventing one', async () => {
    renderViewer({ highlightRange: BEG_RANGE, highlightLabel: 'Segment BEG' });

    const note = await screen.findByTestId('catalog-detail-source-highlight');
    expect(note).toHaveTextContent(`selecting ${BEG.length} characters from offset ${BEG_RANGE.offset}`);
    expect(note).not.toHaveTextContent('on line');
  });
});
