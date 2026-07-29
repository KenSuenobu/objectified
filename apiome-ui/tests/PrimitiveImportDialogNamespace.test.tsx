/**
 * "Extract from Target" in the Primitives import wizard's Options.
 *
 * The button fills the Target namespace from the `$id`s the loaded document declares, so these
 * tests drive it through the real dialog: load a source, click, and assert the field.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// The paste tab's Monaco editor is irrelevant here; stub it to a plain textarea.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import PrimitiveImportDialog from '../src/app/ade/dashboard/primitives/PrimitiveImportDialog';

const REGISTRY_DOC = {
  $defs: {
    money: { $id: 'https://api.apiome.app/types/tenant/acme/v1/types/money', type: 'object' },
    decimal: { $id: 'https://api.apiome.app/types/tenant/acme/v1/types/decimal', type: 'string' },
  },
};

function renderDialog(document: Record<string, unknown> | null) {
  return render(
    <PrimitiveImportDialog
      onClose={jest.fn()}
      onComplete={jest.fn()}
      onMessage={jest.fn()}
      initialSource={
        document
          ? { sourceKind: 'json-schema', sourceMethod: 'paste', document, label: 'types.json' }
          : null
      }
    />,
  );
}

const namespaceInput = () => screen.getByLabelText(/target namespace/i) as HTMLInputElement;
const extractButton = () => screen.getByTestId('extract-target-namespace');
const autoCheckbox = () => screen.getByTestId('auto-extract-target-namespace') as HTMLInputElement;

beforeEach(() => {
  window.localStorage.clear();
});

describe('PrimitiveImportDialog — Extract from Target', () => {
  it('offers the button in Options, next to the Target namespace field', () => {
    renderDialog(REGISTRY_DOC);

    expect(screen.getByText('Options')).toBeInTheDocument();
    expect(extractButton()).toHaveTextContent('Extract from Target');
  });

  it('fills the Target namespace from the document’s $id when clicked', () => {
    renderDialog(REGISTRY_DOC);

    expect(namespaceInput().value).toBe('');

    fireEvent.click(extractButton());

    expect(namespaceInput().value).toBe('tenant/acme/v1/types');
    expect(screen.getByTestId('target-namespace-notice')).toHaveTextContent(/extracted tenant\/acme\/v1\/types/i);
  });

  it('extracts a foreign registry’s namespace, not just apiome-mounted ids', () => {
    renderDialog({
      $defs: {
        position: { $id: 'https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position' },
      },
    });

    fireEvent.click(extractButton());

    expect(namespaceInput().value).toBe('self/v1/schemas/api/schemas');
  });

  it('is disabled until a document is loaded, since there is nothing to read from', () => {
    renderDialog(null);
    expect(extractButton()).toBeDisabled();
  });

  it('leaves a typed namespace alone and explains when the document declares none', () => {
    renderDialog({ $defs: { a: { type: 'string' } } });

    fireEvent.change(namespaceInput(), { target: { value: 'hand/typed/ns' } });
    fireEvent.click(extractButton());

    // Nothing was found, so the reader's own value survives rather than being blanked.
    expect(namespaceInput().value).toBe('hand/typed/ns');
    expect(screen.getByTestId('target-namespace-notice')).toHaveTextContent(/declares no \$id/i);
  });

  it('states when a document spans several namespaces instead of silently picking one', () => {
    renderDialog({
      $defs: {
        a: { $id: 'https://api.apiome.app/types/std/v0/types/a' },
        b: { $id: 'https://api.apiome.app/types/std/v0/types/b' },
        c: { $id: 'https://api.apiome.app/types/tenant/acme/v1/types/c' },
      },
    });

    fireEvent.click(extractButton());

    expect(namespaceInput().value).toBe('std/v0/types');
    expect(screen.getByTestId('target-namespace-notice')).toHaveTextContent(
      /also declares tenant\/acme\/v1\/types/i,
    );
  });

  it('drops a stale notice when a different document is parsed', () => {
    render(
      <PrimitiveImportDialog
        onClose={jest.fn()}
        onComplete={jest.fn()}
        onMessage={jest.fn()}
        initialSource={{
          sourceKind: 'json-schema',
          sourceMethod: 'paste',
          text: JSON.stringify(REGISTRY_DOC),
          document: REGISTRY_DOC,
          label: 'types.json',
        }}
      />,
    );

    fireEvent.click(extractButton());
    expect(screen.getByTestId('target-namespace-notice')).toBeInTheDocument();

    // Re-parsing replaces the document the notice described, so the notice goes with it.
    fireEvent.click(screen.getByRole('button', { name: 'Parse' }));
    expect(screen.queryByTestId('target-namespace-notice')).not.toBeInTheDocument();
  });
});

describe('PrimitiveImportDialog — always extract namespace automatically', () => {
  it('offers the checkbox in Options, off by default', () => {
    renderDialog(REGISTRY_DOC);

    expect(screen.getByText('Always extract namespace automatically')).toBeInTheDocument();
    expect(autoCheckbox()).not.toBeChecked();
    // Off means nothing has happened without asking.
    expect(namespaceInput().value).toBe('');
  });

  it('extracts immediately when switched on with a document already loaded', () => {
    renderDialog(REGISTRY_DOC);

    fireEvent.click(autoCheckbox());

    expect(namespaceInput().value).toBe('tenant/acme/v1/types');
  });

  it('persists the preference and applies it to the next document without a click', () => {
    const { unmount } = renderDialog(REGISTRY_DOC);
    fireEvent.click(autoCheckbox());
    unmount();

    // A fresh wizard reads the standing preference and extracts on load.
    renderDialog({
      $defs: { position: { $id: 'https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position' } },
    });

    expect(autoCheckbox()).toBeChecked();
    expect(namespaceInput().value).toBe('self/v1/schemas/api/schemas');
  });

  it('switching it back off is remembered too', () => {
    const { unmount } = renderDialog(REGISTRY_DOC);
    fireEvent.click(autoCheckbox());
    fireEvent.click(autoCheckbox());
    unmount();

    renderDialog(REGISTRY_DOC);

    expect(autoCheckbox()).not.toBeChecked();
    expect(namespaceInput().value).toBe('');
  });

  it('does not overwrite a namespace typed after the extraction', () => {
    renderDialog(REGISTRY_DOC);
    fireEvent.click(autoCheckbox());
    expect(namespaceInput().value).toBe('tenant/acme/v1/types');

    // The reader overrides it; automatic must not fight them while the same document is loaded.
    fireEvent.change(namespaceInput(), { target: { value: 'my/own/ns' } });
    expect(namespaceInput().value).toBe('my/own/ns');

    // An unrelated option change re-renders without re-extracting.
    fireEvent.click(screen.getByLabelText(/map recognized formats/i));
    expect(namespaceInput().value).toBe('my/own/ns');
  });

  it('leaves the manual button working while the preference is on', () => {
    renderDialog(REGISTRY_DOC);
    fireEvent.click(autoCheckbox());

    fireEvent.change(namespaceInput(), { target: { value: 'my/own/ns' } });
    fireEvent.click(extractButton());

    expect(namespaceInput().value).toBe('tenant/acme/v1/types');
  });
});

