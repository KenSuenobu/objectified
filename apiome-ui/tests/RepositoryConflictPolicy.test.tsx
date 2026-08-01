/**
 * Integration tests for the refresh conflict-policy panel (RAR-4.5, #3531).
 *
 * These drive the real component against a stubbed
 * `/api/repositories/{id}/conflict-policy` and assert the ticket's acceptance criteria as a
 * user meets them: the policy is settable per repository, a single file can override it, and
 * the default a repository arrives with is hold-for-review.
 *
 * Plus the two behaviours that keep the panel honest:
 *
 *  - every mutation re-renders from what the server returned, so the panel cannot claim a
 *    policy that was not stored;
 *  - clearing an override is a delete (`policy: null`), because the file must inherit
 *    whatever the repository says *next*, not a frozen copy of today's setting.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    message: jest.fn(),
  },
}));

import { RepositoryConflictPolicy } from '@/app/components/ade/dashboard/repositories/RepositoryConflictPolicy';

const REPO_ID = '770e8400-e29b-41d4-a716-446655440002';
const API = `/api/repositories/${REPO_ID}/conflict-policy`;

interface Override {
  branch: string;
  path: string;
  policy: string;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

function payload(policy = 'hold-for-review', overrides: Override[] = []) {
  return {
    success: true,
    repositoryId: REPO_ID,
    policy,
    defaultPolicy: 'hold-for-review',
    availablePolicies: ['overwrite', 'hold-for-review', 'new-branch'],
    overrides,
  };
}

/** Requests the component made, so a test can assert method + body, not just the URL. */
let calls: Array<{ url: string; method: string; body: unknown }> = [];

/**
 * Stub `fetch` with a queue of responses, one per request in order.
 *
 * @param responses Bodies to return; the last one repeats if the component asks again.
 */
function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  let index = 0;
  global.fetch = jest.fn(async (url: unknown, init?: unknown) => {
    const opts = (init ?? {}) as { method?: string; body?: string };
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      statusText: 'stub',
      json: async () => next.body,
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function renderPanel() {
  return render(<RepositoryConflictPolicy repositoryId={REPO_ID} defaultBranch="main" />);
}

describe('acceptance criteria', () => {
  test('a repository defaults to hold-for-review', async () => {
    stubFetch([{ body: payload() }]);
    renderPanel();

    await screen.findByTestId('conflict-policy');
    const held = screen.getByTestId('conflict-policy-option-hold-for-review');
    expect(held).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('conflict-policy-option-overwrite')).toHaveAttribute(
      'data-selected',
      'false'
    );
    expect(screen.getByTestId('conflict-policy-summary')).toHaveTextContent(
      'Hold for review applies to every file in this repository.'
    );
  });

  test('the repository policy is configurable, and the panel renders the stored answer', async () => {
    stubFetch([{ body: payload() }, { body: payload('overwrite') }]);
    renderPanel();
    await screen.findByTestId('conflict-policy');

    await userEvent.click(
      within(screen.getByTestId('conflict-policy-option-overwrite')).getByRole('radio')
    );

    await waitFor(() =>
      expect(screen.getByTestId('conflict-policy-option-overwrite')).toHaveAttribute(
        'data-selected',
        'true'
      )
    );
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(API);
    expect(put?.body).toEqual({ policy: 'overwrite' });
    expect(toastSuccess).toHaveBeenCalled();
  });

  test('a single file can override the repository policy', async () => {
    const saved = payload('overwrite', [
      { branch: 'main', path: 'specs/petstore.yaml', policy: 'hold-for-review' },
    ]);
    stubFetch([{ body: payload('overwrite') }, { body: saved }]);
    renderPanel();
    await screen.findByTestId('conflict-policy');
    expect(screen.getByTestId('conflict-policy-no-overrides')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('File path'), 'specs/petstore.yaml');
    await userEvent.selectOptions(screen.getByLabelText('Policy'), 'hold-for-review');
    await userEvent.click(screen.getByRole('button', { name: /save file override/i }));

    await waitFor(() => expect(screen.getByTestId('conflict-policy-overrides')).toBeInTheDocument());
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(`${API}/file`);
    expect(put?.body).toEqual({
      branch: 'main',
      path: 'specs/petstore.yaml',
      policy: 'hold-for-review',
    });
    expect(screen.getByTestId('conflict-policy-summary')).toHaveTextContent(
      'except 1 file has its own policy'
    );
  });
});

describe('overrides', () => {
  test('clearing an override sends a null policy, not a copy of the repository setting', async () => {
    const withOverride = payload('overwrite', [
      { branch: 'main', path: 'specs/petstore.yaml', policy: 'new-branch' },
    ]);
    stubFetch([{ body: withOverride }, { body: payload('overwrite') }]);
    renderPanel();
    await screen.findByTestId('conflict-policy-overrides');

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove override for specs/petstore.yaml' })
    );

    await waitFor(() =>
      expect(screen.getByTestId('conflict-policy-no-overrides')).toBeInTheDocument()
    );
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(`${API}/file`);
    expect(put?.body).toEqual({ branch: 'main', path: 'specs/petstore.yaml', policy: null });
  });

  test('an override with no file path is refused before a request is made', async () => {
    stubFetch([{ body: payload() }]);
    renderPanel();
    await screen.findByTestId('conflict-policy');

    await userEvent.click(screen.getByRole('button', { name: /save file override/i }));

    expect(toastError).toHaveBeenCalledWith('A branch and a file path are required.');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  test('an override row names its branch and the policy in force', async () => {
    stubFetch([
      {
        body: payload('hold-for-review', [
          { branch: 'develop', path: 'specs/orders.yaml', policy: 'overwrite' },
        ]),
      },
    ]);
    renderPanel();

    const list = await screen.findByTestId('conflict-policy-overrides');
    expect(within(list).getByText('specs/orders.yaml')).toBeInTheDocument();
    expect(within(list).getByText('develop · Overwrite')).toBeInTheDocument();
  });
});

describe('degradations', () => {
  test('a failed load surfaces an error with a retry rather than an empty panel', async () => {
    stubFetch([{ status: 503, body: { error: 'Repository API unavailable' } }]);
    renderPanel();

    await screen.findByTestId('conflict-policy-error');
    expect(screen.getByText('Repository API unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  test('a rejected write leaves the panel showing what is actually stored', async () => {
    stubFetch([
      { body: payload() },
      { status: 400, body: { error: 'unrecognised conflict policy' } },
    ]);
    renderPanel();
    await screen.findByTestId('conflict-policy');

    await userEvent.click(
      within(screen.getByTestId('conflict-policy-option-new-branch')).getByRole('radio')
    );

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByTestId('conflict-policy-option-hold-for-review')).toHaveAttribute(
      'data-selected',
      'true'
    );
  });
});
