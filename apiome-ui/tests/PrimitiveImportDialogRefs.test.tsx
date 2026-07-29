/**
 * `$ref` resolution reporting in the Primitives import wizard's source step.
 *
 * Drives the whole path through the dialog: the registry is fetched, refs in the detected types are
 * resolved against it, over-walking refs are repaired, unresolvable ones are warned about, and the
 * document sent for review carries the repaired refs rather than the originals.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import PrimitiveImportDialog from '../src/app/ade/dashboard/primitives/PrimitiveImportDialog';

const REGISTRY_BASE = 'https://api.apiome.app/types/';

/** The tenant registry the wizard resolves against. */
const REGISTRY_PRIMITIVES = [
  { schema_id: `${REGISTRY_BASE}std/v0/types/uri`, namespace: 'std/v0/types', name: 'uri' },
  { schema_id: `${REGISTRY_BASE}std/v0/types/email`, namespace: 'std/v0/types', name: 'email' },
];

function mockRegistryFetch(primitives: unknown[] = REGISTRY_PRIMITIVES) {
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url === '/api/primitives') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, primitives }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ success: true, review: { types: [] } }) });
  }) as unknown as typeof fetch;
}

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

/** A document whose ref walks up one level too far — the reported case. */
const OVER_WALKING_DOC = {
  $defs: {
    position: {
      $id: `${REGISTRY_BASE}tenant/acme/v1/types/position`,
      type: 'object',
      properties: { href: { $ref: '../../../../../std/v0/types/uri' } },
    },
  },
};

const setNamespace = (value: string) =>
  fireEvent.change(screen.getByLabelText(/target namespace/i), { target: { value } });

beforeEach(() => {
  window.localStorage.clear();
  mockRegistryFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PrimitiveImportDialog — $ref resolution', () => {
  it('resolves a correctly-written ref and reports it under the detected types', async () => {
    renderWith({
      $defs: { position: { properties: { href: { $ref: '../../../../std/v0/types/uri' } } } },
    });
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-resolution')).toBeInTheDocument());

    expect(screen.getByTestId('ref-resolved-summary')).toHaveTextContent('Resolved 1 $ref');
    expect(screen.getByTestId('ref-resolved-../../../../std/v0/types/uri')).toHaveTextContent(
      'std/v0/types/uri',
    );
    expect(screen.queryByTestId('ref-repaired-summary')).not.toBeInTheDocument();
  });

  it('repairs a ref that walks up past the registry root, and says it rewrote it', async () => {
    renderWith(OVER_WALKING_DOC);
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-resolution')).toBeInTheDocument());

    expect(screen.getByTestId('ref-resolved-summary')).toHaveTextContent('Resolved 1 $ref');
    expect(screen.getByTestId('ref-repaired-summary')).toHaveTextContent('1 rewritten to resolve');

    const row = screen.getByTestId('ref-resolved-../../../../../std/v0/types/uri');
    expect(row).toHaveAttribute('data-status', 'repaired');
    expect(row).toHaveTextContent('std/v0/types/uri');
    expect(row).toHaveTextContent('../../../../std/v0/types/uri');
  });

  it('warns about a ref that matches nothing, stating that resolution was attempted', async () => {
    renderWith({
      $defs: { position: { properties: { x: { $ref: '../../../../std/v0/types/missing' } } } },
    });
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-unresolved')).toBeInTheDocument());

    const warning = screen.getByTestId('ref-unresolved');
    expect(warning).toHaveTextContent('Unresolved $ref');
    expect(warning).toHaveTextContent(/could not be resolved/i);
    expect(warning).toHaveTextContent(/looked up in the registry and in this document/i);
    expect(warning).toHaveTextContent(/either do not exist/i);
    expect(screen.getByTestId('ref-unresolved-../../../../std/v0/types/missing')).toHaveTextContent(
      /no type matching "std\/v0\/types\/missing"/i,
    );
  });

  it('recommends importing the missing refs first', async () => {
    renderWith({
      $defs: { position: { properties: { x: { $ref: '../../../../std/v0/types/missing' } } } },
    });
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-unresolved')).toBeInTheDocument());

    expect(screen.getByTestId('ref-unresolved-recommendation')).toHaveTextContent(
      'Recommendation: import these refs into the namespace before importing this schema.',
    );
  });

  it('renders one warning icon, not two', async () => {
    renderWith({
      $defs: { position: { properties: { x: { $ref: '../../../../std/v0/types/missing' } } } },
    });
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-unresolved')).toBeInTheDocument());

    // `Alert` supplies the variant's icon itself; a second one passed as a child showed "!" twice.
    const icons = screen.getByTestId('ref-unresolved').querySelectorAll('svg');
    expect(icons).toHaveLength(1);
  });

  it('titles the warning in the singular for exactly one ref', async () => {
    renderWith({
      $defs: { position: { properties: { x: { $ref: '../../../../std/v0/types/missing' } } } },
    });
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-unresolved')).toBeInTheDocument());

    expect(screen.getByText('Unresolved $ref')).toBeInTheDocument();
  });

  it('resolves against a sibling arriving in the same import', async () => {
    renderWith({
      $defs: {
        money: { properties: { amount: { $ref: './decimal' } } },
        decimal: { type: 'string' },
      },
    });
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-resolution')).toBeInTheDocument());

    expect(screen.getByTestId('ref-resolved-./decimal')).toHaveTextContent('(in this import)');
  });

  it('says nothing about a document with no cross-type references', async () => {
    renderWith({ $defs: { plain: { type: 'string' } } });

    await waitFor(() => expect(screen.getByTestId('detected-types')).toBeInTheDocument());
    expect(screen.queryByTestId('ref-resolution')).not.toBeInTheDocument();
  });

  it('leaves an external reference out of both the resolved and unresolved counts', async () => {
    renderWith({
      $defs: { thing: { properties: { x: { $ref: 'https://json-schema.org/draft/2020-12/schema' } } } },
    });
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('detected-types')).toBeInTheDocument());
    expect(screen.queryByTestId('ref-resolution')).not.toBeInTheDocument();
  });

  it('re-resolves when the target namespace changes, since that is what refs resolve against', async () => {
    renderWith(OVER_WALKING_DOC);
    setNamespace('tenant/acme/v1/types');

    await waitFor(() =>
      expect(screen.getByTestId('ref-resolved-../../../../../std/v0/types/uri')).toHaveTextContent(
        '../../../../std/v0/types/uri',
      ),
    );

    // A shallower namespace needs a shallower repair.
    setNamespace('tenant/acme');
    await waitFor(() =>
      expect(screen.getByTestId('ref-resolved-../../../../../std/v0/types/uri')).toHaveTextContent(
        '../../std/v0/types/uri',
      ),
    );
  });

  it('sends the repaired refs for review, not the originals', async () => {
    renderWith(OVER_WALKING_DOC);
    setNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(screen.getByTestId('ref-repaired-summary')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find(
        ([url]) => url === '/api/primitives/import/review',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      const sent = body.schema.$defs.position.properties.href.$ref;
      expect(sent).toBe('../../../../std/v0/types/uri');
    });
  });

  it('degrades to this document only when the registry cannot be loaded', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    renderWith(OVER_WALKING_DOC);
    setNamespace('tenant/acme/v1/types');

    // Nothing known to match against, so the ref is reported rather than silently repaired.
    await waitFor(() => expect(screen.getByTestId('ref-unresolved')).toBeInTheDocument());
  });
});
