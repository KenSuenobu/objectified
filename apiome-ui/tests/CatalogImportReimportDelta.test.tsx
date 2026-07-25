/**
 * CatalogImportReimportDelta — the pre-commit re-import delta (IXH-3.4, #5106).
 *
 * Covers the acceptance criteria on the component:
 *  1. **clean skip** — a null delta (first-time import) renders nothing at all;
 *  2. **explicit no-op** — matching fingerprint stated, with a "Skip this import" exit;
 *  3. **grouped by kind** — entries grouped per entity family with counted, symbol-carrying
 *     change chips (+ / − / Δ — never colour alone), and drill-down to the entity;
 *  4. **honest grading** — severity badges + rationale when the classifier annotated;
 *     an explicit "not graded" statement when it did not (never implied safety), and a
 *     "structural baseline" note when the grade is not from a format-specific pack.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest } from '@jest/globals';

import { CatalogImportReimportDelta } from '../src/app/components/ade/dashboard/catalog/CatalogImportReimportDelta';
import type { ImportReimportDelta } from '../src/app/utils/import-preview-manifest';

function buildDelta(overrides: Partial<ImportReimportDelta> = {}): ImportReimportDelta {
  return {
    target_item_id: 'item-1',
    target_item_name: 'Orders',
    target_item_slug: 'orders',
    current_version_record_id: 'rev-1',
    noop: false,
    candidate_fingerprint: 'fp-candidate-abcdef123456',
    current_fingerprint: 'fp-current-abcdef123456',
    entries: [
      { entity: 'type', key: 'Customer', change: 'added', severity: null },
      {
        entity: 'operation',
        key: 'Query.orders',
        change: 'removed',
        severity: 'breaking',
        rule_id: 'removed-entity',
        rationale: 'Removing an operation breaks existing callers.',
      },
      {
        entity: 'type',
        key: 'Order',
        change: 'changed',
        severity: 'dangerous',
        rationale: 'A field was removed from the type.',
      },
    ],
    counts: { added: 1, removed: 1, changed: 1 },
    counts_by_entity: { type: { added: 1, changed: 1 }, operation: { removed: 1 } },
    classifier: 'graphql-inspector',
    classifier_format_pack: true,
    overall_severity: 'breaking',
    severity_counts: { breaking: 1, dangerous: 1 },
    ...overrides,
  };
}

function renderDelta(
  delta: ImportReimportDelta | null,
  handlers: { onSkipCommit?: jest.Mock; onRevealEntity?: jest.Mock } = {},
) {
  return render(
    <CatalogImportReimportDelta
      delta={delta}
      onSkipCommit={handlers.onSkipCommit as unknown as (() => void) | undefined}
      onRevealEntity={handlers.onRevealEntity as unknown as ((key: string) => void) | undefined}
    />,
  );
}

describe('CatalogImportReimportDelta — clean skip and no-op', () => {
  it('renders nothing at all for a first-time import (null delta)', () => {
    const { container } = renderDelta(null);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('import-reimport-delta')).not.toBeInTheDocument();
  });

  it('reports an identical re-import as an explicit no-op with the matching fingerprint', () => {
    const onSkipCommit = jest.fn();
    renderDelta(
      buildDelta({
        noop: true,
        entries: [],
        counts: { added: 0, removed: 0, changed: 0 },
        candidate_fingerprint: 'fp-same-1234567890ab',
        current_fingerprint: 'fp-same-1234567890ab',
      }),
      { onSkipCommit },
    );
    const banner = screen.getByTestId('import-reimport-noop');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('identical to the current revision');
    expect(banner).toHaveTextContent('fp-same-1234');
    expect(banner).toHaveTextContent('empty revision');

    fireEvent.click(screen.getByTestId('import-reimport-skip'));
    expect(onSkipCommit).toHaveBeenCalledTimes(1);
    // A no-op has no change chips to mislead with.
    expect(screen.queryByTestId('import-reimport-counts')).not.toBeInTheDocument();
  });

  it('names the target item the delta was computed against', () => {
    renderDelta(buildDelta());
    expect(screen.getByTestId('import-reimport-delta')).toHaveTextContent('against Orders');
  });
});

describe('CatalogImportReimportDelta — grouped changes', () => {
  it('groups entries by entity family with counted, symbol-carrying change chips', () => {
    renderDelta(buildDelta());

    const counts = screen.getByTestId('import-reimport-counts');
    expect(counts).toHaveTextContent('+');
    expect(counts).toHaveTextContent('added');
    expect(counts).toHaveTextContent('−');
    expect(counts).toHaveTextContent('removed');
    expect(counts).toHaveTextContent('Δ');
    expect(counts).toHaveTextContent('changed');

    // Families render in presentation order: Operations before Types.
    const operations = screen.getByTestId('import-reimport-family-operation');
    expect(operations).toHaveTextContent('Operations');
    expect(within(operations).getAllByTestId('import-reimport-entry')).toHaveLength(1);
    const types = screen.getByTestId('import-reimport-family-type');
    expect(types).toHaveTextContent('Types');
    expect(within(types).getAllByTestId('import-reimport-entry')).toHaveLength(2);
    expect(
      operations.compareDocumentPosition(types) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('collapses and re-expands a family disclosure', () => {
    renderDelta(buildDelta());
    const types = screen.getByTestId('import-reimport-family-type');
    const toggle = within(types).getByRole('button', { name: /types/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(types).queryAllByTestId('import-reimport-entry')).toHaveLength(0);
  });

  it('drills down to an added/changed entity, but not to a removed one', () => {
    const onRevealEntity = jest.fn();
    renderDelta(buildDelta(), { onRevealEntity });

    fireEvent.click(screen.getByRole('button', { name: 'Customer' }));
    expect(onRevealEntity).toHaveBeenCalledWith('Customer');

    // A removed entity no longer exists in the candidate tree — no reveal button.
    const operations = screen.getByTestId('import-reimport-family-operation');
    expect(within(operations).queryByTestId('import-reimport-reveal')).not.toBeInTheDocument();
    expect(operations).toHaveTextContent('Query.orders');
  });
});

describe('CatalogImportReimportDelta — honest grading', () => {
  it('shows severity badges and rationale where the classifier annotated', () => {
    renderDelta(buildDelta());
    const severities = screen.getAllByTestId('import-reimport-severity');
    expect(severities.map((badge) => badge.textContent)).toEqual(
      expect.arrayContaining(['breaking', 'dangerous']),
    );
    expect(screen.getByTestId('import-reimport-delta')).toHaveTextContent(
      'Removing an operation breaks existing callers.',
    );
    const classifierLine = screen.getByTestId('import-reimport-classifier');
    expect(classifierLine).toHaveTextContent('Graded by graphql-inspector');
    expect(classifierLine).toHaveTextContent('worst change');
    expect(classifierLine).toHaveTextContent('breaking');
    expect(classifierLine).not.toHaveTextContent('structural baseline');
  });

  it('notes when the grade comes from the structural baseline, not a format pack', () => {
    renderDelta(buildDelta({ classifier: 'builtin', classifier_format_pack: false }));
    expect(screen.getByTestId('import-reimport-classifier')).toHaveTextContent(
      'structural baseline',
    );
  });

  it('says plainly when changes are not graded, rather than implying safety', () => {
    renderDelta(
      buildDelta({
        classifier: null,
        overall_severity: null,
        severity_counts: {},
        entries: buildDelta().entries.map((entry) => ({
          ...entry,
          severity: null,
          rule_id: null,
          rationale: null,
        })),
      }),
    );
    const classifierLine = screen.getByTestId('import-reimport-classifier');
    expect(classifierLine).toHaveTextContent('not graded for breaking risk');
    expect(classifierLine).toHaveTextContent('no classifier verdict is available');
    expect(screen.queryAllByTestId('import-reimport-severity')).toHaveLength(0);
  });
});
