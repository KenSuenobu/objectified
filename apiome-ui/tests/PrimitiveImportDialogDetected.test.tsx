/**
 * The detected-types panel in the Primitives import wizard's source step.
 *
 * It replaced a bare "Detected N types" count: the panel names every type found and marks each
 * valid or invalid against draft 2020-12, so the reader can see *what* was picked up and whether it
 * is well-formed without advancing to the review step.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import PrimitiveImportDialog from '../src/app/ade/dashboard/primitives/PrimitiveImportDialog';

function renderWith(document: Record<string, unknown>) {
  return render(
    <PrimitiveImportDialog
      onClose={jest.fn()}
      onComplete={jest.fn()}
      onMessage={jest.fn()}
      initialSource={{ sourceKind: 'json-schema', sourceMethod: 'paste', document, label: 'types.json' }}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('PrimitiveImportDialog — detected types', () => {
  it('names each detected type instead of only counting them', () => {
    renderWith({
      $defs: {
        money: { type: 'object', properties: { amount: { type: 'string' } } },
        decimal: { type: 'string' },
      },
    });

    const panel = screen.getByTestId('detected-types');
    expect(within(panel).getByText('money')).toBeInTheDocument();
    expect(within(panel).getByText('decimal')).toBeInTheDocument();

    // The old blurb told the reader nothing they could act on.
    expect(screen.queryByText(/continue to review conflicts before importing/i)).not.toBeInTheDocument();
  });

  it('marks a well-formed schema valid', () => {
    renderWith({ $defs: { money: { type: 'object' } } });

    expect(screen.getByTestId('detected-type-money')).toHaveAttribute('data-valid', 'true');
    expect(screen.getByText('All valid')).toBeInTheDocument();
  });

  it('marks a malformed schema invalid and shows the reason', () => {
    renderWith({ $defs: { broken: { type: 'not-a-type' } } });

    const row = screen.getByTestId('detected-type-broken');
    expect(row).toHaveAttribute('data-valid', 'false');
    expect(row).toHaveTextContent(/\/type/);
    expect(screen.getByTestId('detected-invalid-count')).toHaveTextContent('1 invalid');
  });

  it('reports a mixed document per type, not as one verdict', () => {
    renderWith({
      $defs: {
        good: { type: 'string' },
        bad: { type: 'string', minLength: 'three' },
      },
    });

    expect(screen.getByTestId('detected-type-good')).toHaveAttribute('data-valid', 'true');
    expect(screen.getByTestId('detected-type-bad')).toHaveAttribute('data-valid', 'false');
    expect(screen.getByTestId('detected-invalid-count')).toHaveTextContent('1 invalid');
  });

  it('keeps a type whose $ref cannot be resolved marked valid', () => {
    // Resolution is the server's job; the panel only answers "is this a well-formed schema".
    renderWith({ $defs: { money: { type: 'object', properties: { a: { $ref: './decimal' } } } } });

    expect(screen.getByTestId('detected-type-money')).toHaveAttribute('data-valid', 'true');
  });

  it('caps a large document and states how many are not listed', () => {
    const $defs: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) {
      $defs[`type${i}`] = { type: 'string' };
    }
    renderWith({ $defs });

    // 12 listed, the rest summarized — and the summary says they are still imported.
    expect(screen.getByTestId('detected-type-type11')).toBeInTheDocument();
    expect(screen.queryByTestId('detected-type-type12')).not.toBeInTheDocument();
    expect(screen.getByTestId('detected-types-truncated')).toHaveTextContent('+8 more');
    expect(screen.getByTestId('detected-types-truncated')).toHaveTextContent(/all 20 are imported/i);
  });

  it('shows nothing when the document has no definitions', () => {
    renderWith({ $defs: {} });

    expect(screen.queryByTestId('detected-types')).not.toBeInTheDocument();
  });

  describe('untyped-schema advisory', () => {
    it('cautions a type that declares no type, without marking it invalid', () => {
      renderWith({ $defs: { anything: { title: 'Anything', examples: [1, 'two'] } } });

      const row = screen.getByTestId('detected-type-anything');
      expect(row).toHaveAttribute('data-valid', 'true');
      expect(screen.getByTestId('detected-type-warning-anything')).toHaveTextContent(
        'No type was specified in the JSON Schema: this might lead to erroneous behavior',
      );
      // An advisory is not a verdict — the panel still reports the type as well-formed.
      expect(screen.getByText('All valid')).toBeInTheDocument();
      expect(screen.getByTestId('detected-warning-count')).toHaveTextContent(
        '1 without a declared type',
      );
    });

    it('stays quiet when the shape can be read without a declared type', () => {
      // `properties` is an object, an `enum` carries its values' type, a `$ref` names another
      // type — none of these are a guess, so none of them earn a caution.
      renderWith({
        $defs: {
          fromProperties: { properties: { a: { type: 'string' } } },
          fromEnum: { enum: ['a', 'b'] },
          fromRef: { $ref: './money' },
        },
      });

      expect(screen.queryByTestId('detected-type-warning-fromProperties')).not.toBeInTheDocument();
      expect(screen.queryByTestId('detected-type-warning-fromEnum')).not.toBeInTheDocument();
      expect(screen.queryByTestId('detected-type-warning-fromRef')).not.toBeInTheDocument();
      expect(screen.queryByTestId('detected-warning-count')).not.toBeInTheDocument();
    });
  });
});
