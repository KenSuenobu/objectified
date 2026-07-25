/**
 * Governance → import/export quality policy panel (IXH-2.3, #5098).
 *
 * Covers the panel's contract with the API and the reader:
 *  1. a tenant with no policy sees the advisory default and is told it is not configured;
 *  2. a saved policy renders its floors, its version badge, its history, and its waiver ledger;
 *  3. a scope only reads as "Blocking" when it has a floor *and* enforcement is on — the same
 *     rule the server applies, so the badge cannot promise a gate that does not exist;
 *  4. saving PUTs the whole policy body (both scopes plus the override contract) and the role
 *     list is normalized to slugs;
 *  5. a non-admin sees the policy read-only, with no save control;
 *  6. a failed load is explained rather than rendered as an empty policy.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';

import QualityPolicyPanel, {
  parseRoleList,
} from '../src/app/ade/dashboard/style-guides/QualityPolicyPanel';
import {
  isBlockingConfiguration,
  type QualityPolicy,
} from '../src/app/ade/dashboard/style-guides/quality-policy-api';

const DEFAULT_POLICY: QualityPolicy = {
  policyVersionId: null,
  versionNumber: 0,
  contentFingerprint: 'default',
  isDefault: true,
  import: { minGrade: null, minScore: null, blockOnSeverity: null, enforcement: 'advisory' },
  export: { minGrade: null, minScore: null, blockOnSeverity: null, enforcement: 'advisory' },
  formatOverrides: {},
  allowOverride: true,
  overrideRoles: ['owner', 'admin'],
  waiverTtlHours: 168,
  actorLabel: null,
  createdAt: null,
};

const SAVED_POLICY: QualityPolicy = {
  ...DEFAULT_POLICY,
  policyVersionId: 'p-1',
  versionNumber: 2,
  contentFingerprint: 'fingerprint-0123456789abcdef',
  isDefault: false,
  import: { minGrade: 'B', minScore: 80, blockOnSeverity: 'error', enforcement: 'block' },
  export: { minGrade: null, minScore: 70, blockOnSeverity: null, enforcement: 'advisory' },
  overrideRoles: ['owner'],
  waiverTtlHours: 48,
  actorLabel: 'admin@example.com',
  createdAt: '2026-07-25T12:00:00Z',
};

const WAIVER = {
  id: 'w-1',
  scope: 'import',
  subjectKey: 'a'.repeat(64),
  subjectLabel: 'vendor.graphql',
  formatKey: 'graphql',
  reportFingerprint: 'fp-9',
  score: 41,
  grade: 'F',
  reason: 'Vendor spec we do not control',
  expiresAt: '2026-08-01T00:00:00Z',
  policyVersionId: 'p-1',
  actorLabel: 'lead@example.com',
  actorRole: 'owner',
  createdAt: '2026-07-25T12:00:00Z',
};

/** Route the panel's three loads (and the save) by URL. */
function mockApi(options: {
  policy?: QualityPolicy;
  versions?: QualityPolicy[];
  waivers?: unknown[];
  policyError?: string;
  saved?: QualityPolicy;
}): jest.Mock {
  return jest.fn((url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (options.policyError && !href.includes('versions') && !href.includes('waivers')) {
      return Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ success: false, error: options.policyError }),
      });
    }
    if (href.includes('/versions')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: { versions: options.versions ?? [], count: 0 } }),
      });
    }
    if (href.includes('/waivers')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: { waivers: options.waivers ?? [], count: 0 } }),
      });
    }
    if (init?.method === 'PUT') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: options.saved ?? options.policy ?? SAVED_POLICY }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: options.policy ?? DEFAULT_POLICY }),
    });
  }) as unknown as jest.Mock;
}

async function renderPanel(
  options: Parameters<typeof mockApi>[0] = {},
  props: { readOnly?: boolean } = {},
) {
  const fetchMock = mockApi(options);
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<QualityPolicyPanel {...props} />);
  await waitFor(() =>
    expect(screen.queryByTestId('quality-policy-loading')).not.toBeInTheDocument(),
  );
  return fetchMock;
}

afterEach(() => jest.restoreAllMocks());

describe('QualityPolicyPanel', () => {
  it('shows the advisory default for a tenant with no policy', async () => {
    await renderPanel();
    expect(screen.getByTestId('quality-policy-default-badge')).toHaveTextContent(
      'Not configured — advisory',
    );
    expect(screen.getByTestId('quality-policy-import-mode')).toHaveTextContent('Advisory');
    expect(screen.getByTestId('quality-policy-export-mode')).toHaveTextContent('Advisory');
    expect(screen.getByLabelText('import minimum grade')).toHaveValue('');
    expect(screen.getByText('No policy has been saved yet.')).toBeInTheDocument();
    expect(screen.getByText('No active waivers.')).toBeInTheDocument();
  });

  it('renders a saved policy with its floors, version, history, and waivers', async () => {
    await renderPanel({
      policy: SAVED_POLICY,
      versions: [SAVED_POLICY],
      waivers: [WAIVER],
    });
    expect(screen.getByTestId('quality-policy-version-badge')).toHaveTextContent('v2');
    expect(screen.getByLabelText('import minimum grade')).toHaveValue('B');
    expect(screen.getByLabelText('import minimum score')).toHaveValue(80);
    expect(screen.getByLabelText('import blocking severity')).toHaveValue('error');
    expect(screen.getByTestId('quality-policy-import-mode')).toHaveTextContent('Blocking');
    // Export sets a floor but stays advisory — it must not read as a gate.
    expect(screen.getByTestId('quality-policy-export-mode')).toHaveTextContent('Advisory');
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByTitle(SAVED_POLICY.contentFingerprint)).toBeInTheDocument();
    expect(screen.getByText('vendor.graphql')).toBeInTheDocument();
    expect(screen.getByText(/Vendor spec we do not control/)).toBeInTheDocument();
  });

  it('shows configured per-format overrides so a verdict can be traced to its rule', async () => {
    await renderPanel({
      policy: { ...SAVED_POLICY, formatOverrides: { openapi: { import: { minScore: 95 } } } },
    });
    const overrides = screen.getByTestId('quality-policy-format-overrides');
    expect(overrides).toHaveTextContent('openapi');
    expect(overrides).toHaveTextContent('"minScore":95');
  });

  it('says so plainly when no format override is configured', async () => {
    await renderPanel({ policy: SAVED_POLICY });
    expect(screen.queryByTestId('quality-policy-format-overrides')).not.toBeInTheDocument();
    expect(screen.getByText(/Every format uses the tenant floors above/)).toBeInTheDocument();
  });

  it('saves the whole policy body and normalizes the role list', async () => {
    const fetchMock = await renderPanel({ policy: SAVED_POLICY, saved: SAVED_POLICY });
    fireEvent.change(screen.getByLabelText('import minimum score'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Roles permitted to waive'), {
      target: { value: 'Owner,  ADMIN ,' },
    });
    fireEvent.click(screen.getByTestId('quality-policy-save'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => (call[1] as RequestInit)?.method === 'PUT'),
      ).toBe(true),
    );
    const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit)?.method === 'PUT');
    const body = JSON.parse(String((put![1] as RequestInit).body));
    expect(body.import).toMatchObject({ minGrade: 'B', minScore: 90, enforcement: 'block' });
    expect(body.export).toMatchObject({ minScore: 70, enforcement: 'advisory' });
    expect(body.overrideRoles).toEqual(['owner', 'admin']);
    expect(body.waiverTtlHours).toBe(48);
  });

  it('keeps the save control disabled until something changes', async () => {
    await renderPanel({ policy: SAVED_POLICY });
    expect(screen.getByTestId('quality-policy-save')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Allow overrides'));
    await waitFor(() => expect(screen.getByTestId('quality-policy-save')).toBeEnabled());
  });

  it('renders read-only for a non-admin, with no save control', async () => {
    await renderPanel({ policy: SAVED_POLICY }, { readOnly: true });
    expect(screen.queryByTestId('quality-policy-save')).not.toBeInTheDocument();
    expect(screen.getByLabelText('import minimum grade')).toBeDisabled();
  });

  it('explains a failed load instead of rendering an empty policy', async () => {
    await renderPanel({ policyError: 'No tenant selected' });
    expect(screen.getByText('No tenant selected')).toBeInTheDocument();
    expect(screen.queryByTestId('quality-policy-save')).not.toBeInTheDocument();
  });
});

describe('quality policy helpers', () => {
  it('reads a scope as blocking only when a floor is enforced', () => {
    expect(
      isBlockingConfiguration({
        minGrade: 'B',
        minScore: null,
        blockOnSeverity: null,
        enforcement: 'block',
      }),
    ).toBe(true);
    // Enforcement without a floor has nothing to block on — the server's rule exactly.
    expect(
      isBlockingConfiguration({
        minGrade: null,
        minScore: null,
        blockOnSeverity: null,
        enforcement: 'block',
      }),
    ).toBe(false);
    expect(
      isBlockingConfiguration({
        minGrade: 'B',
        minScore: null,
        blockOnSeverity: null,
        enforcement: 'advisory',
      }),
    ).toBe(false);
  });

  it('parses a role list into slugs and drops blanks', () => {
    expect(parseRoleList(' Owner, ADMIN ,, ')).toEqual(['owner', 'admin']);
    expect(parseRoleList('')).toEqual([]);
  });
});
