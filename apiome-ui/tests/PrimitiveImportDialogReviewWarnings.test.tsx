/**
 * The review step's per-type advisories in the Primitives import wizard.
 *
 * The review endpoint reports non-blocking `warnings` beside each type's classification — a type
 * that declares no `type` of its own imports fine, but the reader should see that it will accept
 * any instance before committing it. These assert the caution is rendered on the row it belongs
 * to, and that it does not read as an error: the type stays selectable.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import PrimitiveImportDialog from '../src/app/ade/dashboard/primitives/PrimitiveImportDialog';

const UNTYPED = 'No type was specified in the JSON Schema: this might lead to erroneous behavior';

/** One reviewed type, with the fields the row reads. */
function reviewType(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    status: 'new',
    valid: true,
    validation_errors: [],
    warnings: [],
    error: null,
    schema_id: `https://acme.test/types/${name}`,
    existing_id: null,
    ref_count: 0,
    unresolved_refs: [],
    allowed_resolutions: [],
    ...overrides,
  };
}

function mockReview(
  types: Array<ReturnType<typeof reviewType>>,
  summaryOverrides: Record<string, unknown> = {},
) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/import/review')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          review: {
            status: 'review',
            source_kind: 'json-schema',
            source_label: 'request.json',
            target_namespace: null,
            warnings: [],
            summary: {
              new: types.length,
              identical: 0,
              conflict: 0,
              invalid: 0,
              warnings: types.filter(
                (t) =>
                  ((t.warnings as unknown[] | undefined)?.length ?? 0) > 0 ||
                  ((t.unresolved_refs as unknown[] | undefined)?.length ?? 0) > 0,
              ).length,
              total: types.length,
              ...summaryOverrides,
            },
            types,
          },
        }),
      };
    }
    // The wizard also loads the tenant's existing types for `$ref` resolution.
    return { ok: true, json: async () => ({ success: true, primitives: [] }) };
  }) as unknown as typeof fetch;
}

/** Render the wizard on a document and advance it to the review step. */
async function renderReview(document: Record<string, unknown>) {
  render(
    <PrimitiveImportDialog
      onClose={jest.fn()}
      onComplete={jest.fn()}
      onMessage={jest.fn()}
      initialSource={{
        sourceKind: 'json-schema',
        sourceMethod: 'paste',
        document,
        label: 'request.json',
      }}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /continue to review/i }));
  await waitFor(() => expect(screen.getByText(/total/i)).toBeInTheDocument());
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PrimitiveImportDialog — review step advisories', () => {
  it('shows the untyped-schema caution on the type it belongs to', async () => {
    mockReview([reviewType('request', { warnings: [UNTYPED] })]);
    await renderReview({ $defs: { request: { title: 'Request', examples: [42] } } });

    expect(screen.getByTestId('review-type-warning-request')).toHaveTextContent(UNTYPED);
  });

  it('leaves a cautioned type selected — an advisory does not block the import', async () => {
    mockReview([reviewType('request', { warnings: [UNTYPED] })]);
    await renderReview({ $defs: { request: { title: 'Request' } } });

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.getByRole('button', { name: /^import/i })).toBeEnabled();
  });

  it('says nothing for a type the server raised no advisory on', async () => {
    mockReview([reviewType('money')]);
    await renderReview({ $defs: { money: { type: 'object' } } });

    expect(screen.queryByTestId('review-type-warning-money')).not.toBeInTheDocument();
  });

  describe('the summarized warning total', () => {
    it('sits between conflict and identical when something is cautioned', async () => {
      mockReview([
        reviewType('request', { warnings: [UNTYPED] }),
        reviewType('position', { unresolved_refs: [{ relative_ref: './missing' }] }),
        reviewType('money'),
      ]);
      await renderReview({ $defs: { money: { type: 'object' } } });

      expect(screen.getByTestId('review-warning-count')).toHaveTextContent('2 warnings');
      // Order: new, conflict, warnings, identical.
      const badges = screen.getByTestId('review-warning-count').parentElement;
      expect(badges?.textContent).toMatch(/new.*conflict.*2 warnings.*identical/s);
    });

    it('counts an unresolved $ref as a warning', async () => {
      mockReview([reviewType('position', { unresolved_refs: [{ relative_ref: './missing' }] })]);
      await renderReview({ $defs: { position: { type: 'object' } } });

      expect(screen.getByTestId('review-warning-count')).toHaveTextContent('1 warning');
    });

    it('is absent entirely when nothing is cautioned', async () => {
      mockReview([reviewType('money')]);
      await renderReview({ $defs: { money: { type: 'object' } } });

      expect(screen.queryByTestId('review-warning-count')).not.toBeInTheDocument();
    });

    it('falls back to the reviewed types when the summary omits the count', async () => {
      // An older service does not send `summary.warnings`; the badge must still agree with the
      // cautions rendered on the rows below it.
      mockReview([reviewType('request', { warnings: [UNTYPED] })], { warnings: undefined });
      await renderReview({ $defs: { request: { title: 'Request' } } });

      expect(screen.getByTestId('review-warning-count')).toHaveTextContent('1 warning');
    });
  });

  it('tolerates a server response that omits warnings entirely', async () => {
    // The field is additive; an older service that does not send it must still render.
    const legacy = reviewType('money');
    delete (legacy as Record<string, unknown>).warnings;
    mockReview([legacy]);
    await renderReview({ $defs: { money: { type: 'object' } } });

    const row = screen.getByText('money').closest('div');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).queryByText(UNTYPED)).not.toBeInTheDocument();
  });
});
