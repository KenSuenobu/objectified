/**
 * Render tests for the bundle explorer (MFX-43.2, #4362) and its problem markers (MFX-43.3, #4363).
 *
 * The explorer must: skip the tree/tabs for a single-file bundle; show the tree, tabs, and viewer
 * for a multi-file one; open a file from the tree into the viewer and add it to the tab strip; and
 * resolve each file's highlight language registry-driven. For MFX-43.3 it must set Monaco markers
 * for the active file's located findings only, list them in a problems panel with two-way
 * problem ↔ line navigation, and honour an external "open this problem" request.
 *
 * Monaco is stubbed with a spy harness (exposed via `jest.requireMock`) whose fake editor/monaco
 * instances are handed to `onMount`, so marker/reveal behaviour asserts against jest spies and the
 * assertions never depend on the real editor loading.
 */

jest.mock('@monaco-editor/react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  type MouseHandler = (event: { target?: { position?: { lineNumber?: number } } }) => void;
  const mouseHandlers: MouseHandler[] = [];
  const model = { getLineCount: () => 1000, isDisposed: () => false };
  /** The MFX-43.5 find action, so "Find" can assert it opened Monaco's own widget. */
  const findAction = { run: jest.fn() };
  const editor = {
    getModel: () => model,
    getAction: jest.fn(() => findAction),
    revealLineInCenter: jest.fn(),
    setPosition: jest.fn(),
    focus: jest.fn(),
    onMouseDown: (handler: MouseHandler) => {
      mouseHandlers.push(handler);
      return { dispose: () => undefined };
    },
    createDecorationsCollection: jest.fn(() => ({ clear: jest.fn(), set: jest.fn() })),
  };
  const monaco = { editor: { setModelMarkers: jest.fn() } };
  const harness = {
    editor,
    monaco,
    findAction,
    /** Simulate a click on an editor line (what Monaco reports via onMouseDown). */
    fireLineClick: (lineNumber: number) => {
      mouseHandlers.forEach((handler) => handler({ target: { position: { lineNumber } } }));
    },
    reset: () => {
      mouseHandlers.length = 0;
      findAction.run.mockClear();
      editor.revealLineInCenter.mockClear();
      editor.setPosition.mockClear();
      editor.focus.mockClear();
      editor.createDecorationsCollection.mockClear();
      monaco.editor.setModelMarkers.mockClear();
    },
  };
  function MockMonaco(props: {
    value?: string;
    language?: string;
    options?: { wordWrap?: string; folding?: boolean };
    onMount?: (ed: typeof editor, m: typeof monaco) => void;
  }) {
    // Mount-once like the real editor: hand the fake instances to onMount exactly one time.
    React.useEffect(() => {
      props.onMount?.(editor, monaco);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div
        data-testid="mock-monaco"
        data-language={props.language}
        data-wordwrap={props.options?.wordWrap}
        data-folding={String(props.options?.folding)}
      >
        {props.value}
      </div>
    );
  }
  return { __esModule: true, default: MockMonaco, __harness: harness };
});

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BundleExplorer } from '../src/app/components/ade/dashboard/export/BundleExplorer';
import {
  collectLocatedProblems,
  PROBLEM_MARKER_OWNER,
} from '../src/app/components/ade/dashboard/export/exportProblemMarkers';
import {
  buildBundleManifest,
  countFindingsByFile,
} from '../src/app/components/ade/dashboard/export/exportBundle';
import { VIEWER_INLINE_FILE_CAP_BYTES } from '../src/app/components/ade/dashboard/export/exportViewerGuards';
import {
  ENTITY_LINE_CLASS,
  type ExportManifestEntity,
} from '../src/app/components/ade/dashboard/export/exportPreviewManifest';

/** The spy harness the Monaco mock exposes (fake editor/monaco + line-click simulation). */
const { __harness: monacoHarness } = jest.requireMock('@monaco-editor/react') as {
  __harness: {
    editor: {
      revealLineInCenter: jest.Mock;
      setPosition: jest.Mock;
      createDecorationsCollection: jest.Mock;
    };
    monaco: { editor: { setModelMarkers: jest.Mock } };
    findAction: { run: jest.Mock };
    fireLineClick: (lineNumber: number) => void;
    reset: () => void;
  };
};

beforeEach(() => monacoHarness.reset());

const emptyCounts = countFindingsByFile([], []);

const multiManifest = buildBundleManifest([
  { path: 'petstore.proto', text: 'syntax = "proto3";' },
  { path: 'com/example/User.avsc', text: '{"type":"record","name":"User"}' },
]);

describe('BundleExplorer (MFX-43.2)', () => {
  it('skips the tree and tabs for a single-file bundle', async () => {
    const single = buildBundleManifest([{ path: 'openapi.yaml', text: 'openapi: 3.1.0' }]);
    render(<BundleExplorer manifest={single} countsByPath={emptyCounts} targetKey="openapi" />);

    expect(screen.getByTestId('bundle-explorer')).toHaveAttribute('data-multi', 'false');
    expect(screen.queryByTestId('bundle-tree')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bundle-file-tabs')).not.toBeInTheDocument();
    // The one file is shown in the viewer, YAML-highlighted (registry-driven).
    expect(await screen.findByTestId('bundle-file-editor')).toHaveAttribute('data-language', 'yaml');
  });

  it('shows the tree, tabs, and viewer for a multi-file bundle', async () => {
    render(<BundleExplorer manifest={multiManifest} countsByPath={emptyCounts} targetKey="protobuf" />);

    expect(screen.getByTestId('bundle-explorer')).toHaveAttribute('data-multi', 'true');
    expect(screen.getByTestId('bundle-tree')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-file-tabs')).toBeInTheDocument();
    // The primary file opens first, protobuf-highlighted.
    const editor = await screen.findByTestId('bundle-file-editor');
    expect(editor).toHaveAttribute('data-language', 'protobuf');
    expect(editor).toHaveTextContent('syntax = "proto3"');
  });

  it('opens a file from the tree into the viewer and adds a tab', async () => {
    render(<BundleExplorer manifest={multiManifest} countsByPath={emptyCounts} targetKey="protobuf" />);

    // Only the primary is tabbed to start.
    expect(screen.queryByTestId('bundle-tab-com/example/User.avsc')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('bundle-tree-file-com/example/User.avsc'));

    // The viewer now shows the .avsc (its own language), and a tab appeared for it.
    const editor = await screen.findByTestId('bundle-file-editor');
    expect(editor).toHaveTextContent('"name":"User"');
    expect(screen.getByTestId('bundle-tab-com/example/User.avsc')).toHaveAttribute('data-active', 'true');
  });

  it('closes the active tab and falls back to a neighbour', async () => {
    render(<BundleExplorer manifest={multiManifest} countsByPath={emptyCounts} targetKey="protobuf" />);
    // Open the second file so two tabs exist, with the second active.
    fireEvent.click(screen.getByTestId('bundle-tree-file-com/example/User.avsc'));
    expect(screen.getByTestId('bundle-tab-com/example/User.avsc')).toHaveAttribute('data-active', 'true');

    // Close the active tab → focus falls back to the remaining primary.
    fireEvent.click(screen.getByTestId('bundle-tab-close-com/example/User.avsc'));
    expect(screen.queryByTestId('bundle-tab-com/example/User.avsc')).not.toBeInTheDocument();
    expect(screen.getByTestId('bundle-tab-petstore.proto')).toHaveAttribute('data-active', 'true');
    expect(await screen.findByTestId('bundle-file-editor')).toHaveTextContent('syntax = "proto3"');
  });
});

describe('BundleExplorer — problem markers (MFX-43.3)', () => {
  const markerManifest = buildBundleManifest([
    { path: 'petstore.proto', text: 'syntax = "proto3";\npackage example;\nmessage Pet {}' },
    { path: 'google/protobuf/timestamp.proto', text: 'message Timestamp {}' },
  ]);

  /** Two located problems on the primary, one on the import, one location-less (never marked). */
  const problems = collectLocatedProblems(
    [{ message: 'Field number 0 is not allowed.', file: 'petstore.proto', line: 3, column: 9, keyword: 'buf.field-number' }],
    [
      { severity: 'warning', rule: 'proto-style', message: 'Prefer explicit package.', file: 'petstore.proto', line: 2 },
      { severity: 'info', rule: 'naming', message: 'Consider a suffix.', file: 'google/protobuf/timestamp.proto', line: 1 },
      { severity: 'error', rule: 'no-loc', message: 'Location-less lint.', file: 'petstore.proto' },
    ],
  );

  it('sets markers and gutter decorations for the active file only — nothing fabricated', () => {
    render(
      <BundleExplorer
        manifest={markerManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        problems={problems}
      />,
    );

    // The primary's two located problems become markers under the verify owner; the
    // location-less lint finding and the other file's problem are absent.
    const calls = monacoHarness.monaco.editor.setModelMarkers.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, owner, markers] = calls[calls.length - 1];
    expect(owner).toBe(PROBLEM_MARKER_OWNER);
    expect(markers).toHaveLength(2);
    expect(markers.map((m: { severity: number }) => m.severity).sort()).toEqual([4, 8]);
    expect(markers.map((m: { startLineNumber: number }) => m.startLineNumber).sort()).toEqual([2, 3]);
    // Gutter decorations ride along on the same lines.
    expect(monacoHarness.editor.createDecorationsCollection).toHaveBeenCalled();

    // The problems panel lists the same two problems.
    expect(screen.getByTestId('verify-problems-count')).toHaveTextContent('2');
    expect(screen.getByTestId('verify-problem-validation-0')).toBeInTheDocument();
    expect(screen.queryByTestId('verify-problem-lint-1')).not.toBeInTheDocument(); // other file
    expect(screen.queryByTestId('verify-problem-lint-2')).not.toBeInTheDocument(); // no location
  });

  it('re-marks when switching files, leaving unfiled problems list-only in a multi-file bundle', () => {
    render(
      <BundleExplorer
        manifest={markerManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        problems={problems}
      />,
    );
    fireEvent.click(screen.getByTestId('bundle-tree-file-google/protobuf/timestamp.proto'));

    const calls = monacoHarness.monaco.editor.setModelMarkers.mock.calls;
    const [, , markers] = calls[calls.length - 1];
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ severity: 2, startLineNumber: 1 });
    expect(screen.getByTestId('verify-problem-lint-1')).toBeInTheDocument();
  });

  it('clicking a problem row reveals its line and highlights the row (finding → editor)', () => {
    render(
      <BundleExplorer
        manifest={markerManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        problems={problems}
      />,
    );

    fireEvent.click(screen.getByTestId('verify-problem-validation-0'));
    expect(monacoHarness.editor.revealLineInCenter).toHaveBeenCalledWith(3);
    expect(monacoHarness.editor.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 9 });
    expect(screen.getByTestId('verify-problem-validation-0')).toHaveAttribute('data-selected', 'true');
  });

  it('clicking a marked editor line highlights its problem row (marker → finding)', () => {
    render(
      <BundleExplorer
        manifest={markerManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        problems={problems}
      />,
    );

    act(() => monacoHarness.fireLineClick(2));
    expect(screen.getByTestId('verify-problem-lint-0')).toHaveAttribute('data-selected', 'true');

    // A line with no problem changes nothing.
    act(() => monacoHarness.fireLineClick(1));
    expect(screen.getByTestId('verify-problem-lint-0')).toHaveAttribute('data-selected', 'true');
  });

  it('honours an external reveal request: opens the file, reveals the line, selects the row', () => {
    const target = problems.find((p) => p.id === 'lint-1')!;
    render(
      <BundleExplorer
        manifest={markerManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        problems={problems}
        reveal={{ problem: target, nonce: 1 }}
      />,
    );

    // The import file was opened (tab + viewer), its problem selected and revealed.
    expect(screen.getByTestId('bundle-tab-google/protobuf/timestamp.proto')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('bundle-file-editor')).toHaveTextContent('message Timestamp');
    expect(screen.getByTestId('verify-problem-lint-1')).toHaveAttribute('data-selected', 'true');
    expect(monacoHarness.editor.revealLineInCenter).toHaveBeenCalledWith(1);
  });
});

describe('BundleExplorer — manifest entities (IXH-4.1)', () => {
  const entityManifest = buildBundleManifest([
    { path: 'petstore.proto', text: 'syntax = "proto3";\npackage example;\nmessage Pet {}' },
    { path: 'google/protobuf/timestamp.proto', text: 'message Timestamp {}' },
  ]);

  function entity(overrides: Partial<ExportManifestEntity>): ExportManifestEntity {
    return {
      key: 'Entity',
      name: 'Entity',
      entity_kind: 'type',
      parent_key: null,
      order: 0,
      description: null,
      deprecated: false,
      status: 'retained',
      reason: null,
      severity: 'info',
      detail: 'carried faithfully',
      target_mapping: null,
      emitted: true,
      location: null,
      aggregated: false,
      reported: true,
      native_name: null,
      native_id: null,
      source_location: null,
      ...overrides,
    };
  }

  const manifestEntities: ExportManifestEntity[] = [
    entity({
      key: 'Pet',
      name: 'Pet',
      entity_kind: 'type',
      order: 0,
      location: { file: 'petstore.proto', line: 3, pointer: null },
    }),
    entity({
      key: 'Timestamp',
      name: 'Timestamp',
      entity_kind: 'type',
      order: 1,
      location: { file: 'google/protobuf/timestamp.proto', line: 1, pointer: null },
    }),
  ];

  it('resolves a clicked editor line to its entity (code → entity)', () => {
    const onEntityLineClick = jest.fn();
    render(
      <BundleExplorer
        manifest={entityManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        manifestEntities={manifestEntities}
        onEntityLineClick={onEntityLineClick}
      />,
    );

    // A click at/below the declaration resolves to the active file's entity.
    act(() => monacoHarness.fireLineClick(3));
    expect(onEntityLineClick).toHaveBeenCalledWith(expect.objectContaining({ key: 'Pet' }));

    // A line above every declaration in the active file resolves to nothing.
    onEntityLineClick.mockClear();
    act(() => monacoHarness.fireLineClick(1));
    expect(onEntityLineClick).not.toHaveBeenCalled();
  });

  it('honours an entity reveal: opens the entity’s bundle file and scrolls its line (entity → code)', () => {
    render(
      <BundleExplorer
        manifest={entityManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        manifestEntities={manifestEntities}
        selectedEntityKey="Timestamp"
        entityReveal={{ entity: manifestEntities[1], nonce: 1 }}
      />,
    );

    // The nested file became active (tab + viewer) and its declaration line was revealed.
    expect(screen.getByTestId('bundle-tab-google/protobuf/timestamp.proto')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('bundle-file-editor')).toHaveTextContent('message Timestamp');
    expect(monacoHarness.editor.revealLineInCenter).toHaveBeenCalledWith(1);
  });

  it('decorates the selected entity’s declaration line in the active file only', () => {
    render(
      <BundleExplorer
        manifest={entityManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        manifestEntities={manifestEntities}
        selectedEntityKey="Pet"
      />,
    );

    const decorationCalls = monacoHarness.editor.createDecorationsCollection.mock.calls;
    const entityDecorations = decorationCalls
      .flatMap((call) => call[0] as { options?: { className?: string } }[])
      .filter((decoration) => decoration?.options?.className === ENTITY_LINE_CLASS);
    expect(entityDecorations).toHaveLength(1);
    expect(entityDecorations[0]).toMatchObject({
      range: { startLineNumber: 3, endLineNumber: 3 },
      options: { isWholeLine: true },
    });
  });
});

/** A file of `bytes` ASCII bytes, newline-delimited. */
function textOfBytes(bytes: number): string {
  const line = `${'x'.repeat(63)}\n`;
  return line.repeat(Math.ceil(bytes / 64)).slice(0, bytes);
}

describe('BundleExplorer — large-output guards + viewer actions (MFX-43.5)', () => {
  /** Capture what `downloadBlob` handed the browser. */
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

  it('mounts the standard viewer actions, including the bundle download', () => {
    const onDownloadBundle = jest.fn();
    render(
      <BundleExplorer
        manifest={multiManifest}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        onDownloadBundle={onDownloadBundle}
      />,
    );

    for (const action of ['copy', 'download-file', 'download-bundle', 'wrap', 'folding', 'find']) {
      expect(screen.getByTestId(`bundle-${action}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('bundle-download-bundle'));
    expect(onDownloadBundle).toHaveBeenCalledTimes(1);
  });

  it('omits the bundle download when the host offers none', () => {
    render(<BundleExplorer manifest={multiManifest} countsByPath={emptyCounts} targetKey="protobuf" />);
    expect(screen.queryByTestId('bundle-download-bundle')).not.toBeInTheDocument();
  });

  it('downloads the open file under its own basename', () => {
    const { created, names } = captureDownload();
    render(<BundleExplorer manifest={multiManifest} countsByPath={emptyCounts} targetKey="protobuf" />);

    // Open the nested file, then download it: the name is the basename, not the bundle path.
    fireEvent.click(screen.getByTestId('bundle-tree-file-com/example/User.avsc'));
    fireEvent.click(screen.getByTestId('bundle-download-file'));
    expect(names).toEqual(['User.avsc']);
    expect(created[0].size).toBe('{"type":"record","name":"User"}'.length);
  });

  it('drives wrap and folding into the viewer and opens the find widget', () => {
    render(<BundleExplorer manifest={multiManifest} countsByPath={emptyCounts} targetKey="protobuf" />);
    expect(screen.getByTestId('mock-monaco')).toHaveAttribute('data-wordwrap', 'off');

    fireEvent.click(screen.getByTestId('bundle-wrap'));
    expect(screen.getByTestId('mock-monaco')).toHaveAttribute('data-wordwrap', 'on');
    fireEvent.click(screen.getByTestId('bundle-folding'));
    expect(screen.getByTestId('mock-monaco')).toHaveAttribute('data-folding', 'false');

    fireEvent.click(screen.getByTestId('bundle-find'));
    expect(monacoHarness.findAction.run).toHaveBeenCalledTimes(1);
  });

  it('keeps a huge bundle responsive: the giant file is navigable but never rendered', () => {
    const huge = buildBundleManifest([
      { path: 'petstore.proto', text: 'syntax = "proto3";' },
      { path: 'giant.json', text: textOfBytes(VIEWER_INLINE_FILE_CAP_BYTES + 4_096) },
    ]);
    render(<BundleExplorer manifest={huge} countsByPath={emptyCounts} targetKey="protobuf" />);

    // The bundle says up front that something loads on demand.
    expect(screen.getByTestId('bundle-budget-notice')).toHaveTextContent('1 of 2 files');
    // The primary file is inline as always.
    expect(screen.getByTestId('bundle-file-editor')).toHaveTextContent('syntax = "proto3"');

    // Opening the giant shows the guard panel — nothing reached Monaco.
    fireEvent.click(screen.getByTestId('bundle-tree-file-giant.json'));
    expect(screen.queryByTestId('bundle-file-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('bundle-deferred')).toHaveAttribute('data-reason', 'file-cap');
    // …but it is still copyable and downloadable in full.
    expect(screen.getByTestId('bundle-copy')).toBeEnabled();
    expect(screen.getByTestId('bundle-download-file')).toBeEnabled();
  });

  it('loads a deferred file into the viewer as an explicit head slice', () => {
    const text = textOfBytes(VIEWER_INLINE_FILE_CAP_BYTES + 4_096);
    const huge = buildBundleManifest([
      { path: 'petstore.proto', text: 'syntax = "proto3";' },
      { path: 'giant.json', text },
    ]);
    render(<BundleExplorer manifest={huge} countsByPath={emptyCounts} targetKey="protobuf" />);

    fireEvent.click(screen.getByTestId('bundle-tree-file-giant.json'));
    fireEvent.click(screen.getByTestId('bundle-load'));

    const editor = screen.getByTestId('bundle-file-editor');
    expect(editor.textContent?.length ?? 0).toBeLessThan(text.length);
    expect(screen.getByTestId('bundle-truncated')).toHaveTextContent(/Showing the first 128\.0 KB/);
  });

  it('holds back the files past the inline budget, then loads one when asked', () => {
    // Five 500 KB files: each under the per-file cap, but together past the 2 MB bundle budget.
    const big = textOfBytes(500 * 1024);
    const bundle = buildBundleManifest(
      ['a', 'b', 'c', 'd', 'e'].map((name) => ({ path: `${name}.json`, text: big })),
    );
    render(<BundleExplorer manifest={bundle} countsByPath={emptyCounts} targetKey="openapi" />);

    expect(screen.getByTestId('bundle-budget-notice')).toHaveTextContent('1 of 5 files');
    // The fifth file overflows the budget: it defers for the budget, not for its own size.
    fireEvent.click(screen.getByTestId('bundle-tree-file-e.json'));
    const panel = screen.getByTestId('bundle-deferred');
    expect(panel).toHaveAttribute('data-reason', 'bundle-budget');

    // Asking for it renders the whole file — a budget deferral is not a truncation.
    fireEvent.click(screen.getByTestId('bundle-load'));
    expect(screen.getByTestId('bundle-file-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('bundle-truncated')).not.toBeInTheDocument();
  });

  it('says nothing about budgets for an ordinary bundle', () => {
    render(<BundleExplorer manifest={multiManifest} countsByPath={emptyCounts} targetKey="protobuf" />);
    expect(screen.queryByTestId('bundle-budget-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bundle-deferred')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bundle-truncated')).not.toBeInTheDocument();
  });
});

describe('BundleExplorer — guarded files still answer a finding (MFX-43.5 × MFX-43.3)', () => {
  it('loads a held-back file when a Verify lens asks to open a finding in it', () => {
    const huge = buildBundleManifest([
      { path: 'petstore.proto', text: 'syntax = "proto3";' },
      { path: 'giant.json', text: textOfBytes(VIEWER_INLINE_FILE_CAP_BYTES + 4_096) },
    ]);
    const problems = collectLocatedProblems(
      [{ message: 'Bad field.', file: 'giant.json', line: 3 }],
      [],
    );
    render(
      <BundleExplorer
        manifest={huge}
        countsByPath={emptyCounts}
        targetKey="protobuf"
        problems={problems}
        reveal={{ problem: problems[0], nonce: 1 }}
      />,
    );

    // The lens click opened the guarded file rather than answering with the "load this" panel.
    expect(screen.queryByTestId('bundle-deferred')).not.toBeInTheDocument();
    expect(screen.getByTestId('bundle-file-editor')).toBeInTheDocument();
    // …as an explicit head slice, since the file is past the per-file cap.
    expect(screen.getByTestId('bundle-truncated')).toBeInTheDocument();
  });
});
