/**
 * Repository detail → Files tab → Map & import: when the Import button may be pressed.
 *
 * Reproduction coverage for the report "select two files, Import selected, pick a target, and
 * the Import button never enables". The button is gated on an importable verdict *and* a
 * staged target, so the interesting cases are the ones where a reader believes they have
 * chosen a target and the gate disagrees.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { RepositoryFileImportMapping } from '../src/app/components/ade/dashboard/repositories/RepositoryFileImportMapping';

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), success: jest.fn(), message: jest.fn() },
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: { current_tenant_id: 'tenant-1', user_id: 'user-1' } },
  }),
}));

jest.mock('@lib/db/helper', () => ({ createProject: jest.fn() }));
jest.mock('@lib/db/import-actions', () => ({
  startImport: jest.fn(),
  getImportStatus: jest.fn(),
}));
jest.mock('@/app/components/ade/dashboard/ImportExecutionPanel', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/app/components/ade/dashboard/ImportCompletePanel', () => ({
  __esModule: true,
  default: () => null,
}));

const OPENAPI = [
  'openapi: 3.0.3',
  'info:',
  '  title: Orders API',
  '  version: 1.4.0',
  'paths: {}',
].join('\n');

const PROJECTS = [
  { id: 'project-a', name: 'Payments', slug: 'payments' },
  { id: 'project-b', name: 'Shipping', slug: 'shipping' },
];

function mockApi(): void {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/content')) {
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          path: 'api/orders.yaml',
          branch: 'main',
          display_kind: 'OpenAPI',
          confidence: 'content',
          blob_sha: 'abc1234def5678',
          size_bytes: OPENAPI.length,
          content: OPENAPI,
        }),
      };
    }
    if (url.includes('/api/projects')) {
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({ success: true, projects: PROJECTS }),
      };
    }
    return { ok: true, statusText: 'OK', json: async () => ({}) };
  }) as unknown as typeof fetch;
}

function renderWizard() {
  return render(
    <RepositoryFileImportMapping
      repositoryId="11111111-1111-1111-1111-111111111111"
      repositoryName="widgets"
      repositoryFullName="acme/widgets"
      branch="main"
      file={{
        id: 'file-1',
        path: 'api/orders.yaml',
        name: 'orders.yaml',
        display_kind: 'OpenAPI',
        confidence: 'content',
        blob_sha: 'abc1234def5678',
        size_bytes: OPENAPI.length,
      } as never}
      open
      onOpenChange={() => {}}
    />
  );
}

/** Pick a project from the Radix select by name. */
async function pickProject(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = await waitFor(() => {
    const el = document.getElementById('repo-import-project-select');
    if (!el) throw new Error('project select not rendered yet');
    return el;
  });
  await user.click(trigger);
  const option = await screen.findByRole('option', { name });
  await user.click(option);
}

function submitButton(): HTMLButtonElement {
  return screen.getByTestId('repository-import-submit') as HTMLButtonElement;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi();
});

describe('Map & import — the Import button gate', () => {
  it('enables once an importable file is mapped to an existing project', async () => {
    const user = userEvent.setup();
    renderWizard();

    await waitFor(() => expect(screen.getByTestId('repository-import-submit')).toBeInTheDocument());
    expect(submitButton()).toBeDisabled();

    await pickProject(user, 'Payments');

    await waitFor(() => expect(submitButton()).toBeEnabled());
  });

  it('re-enables after the reader toggles to New project and back', async () => {
    // The reported dead end: a reader who tries "New project", changes their mind, and returns
    // to the existing-project picker. Toggling clears the staged project, so the picker has to
    // be able to stage one again — including the *same* project they had chosen before.
    const user = userEvent.setup();
    renderWizard();

    await waitFor(() => expect(screen.getByTestId('repository-import-submit')).toBeInTheDocument());
    await pickProject(user, 'Payments');
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(screen.getByRole('radio', { name: /create a new project/i }));
    expect(submitButton()).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /existing project/i }));
    await pickProject(user, 'Payments');

    await waitFor(() => expect(submitButton()).toBeEnabled());
  });
});
