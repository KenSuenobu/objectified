/**
 * Guide editor — rule catalog tab tests (GOV-2.2, #4434)
 *
 * Renders GuideEditorClient against a mocked `global.fetch` returning the documented
 * `{ success, data }` proxy shapes and asserts: category grouping with rationale and
 * default severity, search and category filtering, the live enabled count, per-rule
 * enable/severity editing with the dirty-state save bar (save PUTs the full rule set,
 * discard reverts), the unsaved-changes warning on navigation, and read-only rendering
 * for the built-in guide and non-admin members.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

const mockConfirm = jest.fn<Promise<boolean>, [unknown]>(() => Promise.resolve(true));
const mockPush = jest.fn();

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({
    confirm: (opts: unknown) => mockConfirm(opts),
    alert: jest.fn(),
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import GuideEditorClient from '../src/app/ade/dashboard/style-guides/[guideId]/GuideEditorClient';

const GUIDE_ID = 'guide-custom';

const RULES = [
  {
    ruleId: 'documentation.operation-missing-summary',
    pack: 'openapi',
    category: 'documentation',
    defaultSeverity: 'warning',
    rationale: 'Operations without a summary are hard to scan in generated docs.',
    docsAnchor: 'documentation-operation-missing-summary',
    enabled: true,
    severity: 'warning',
  },
  {
    ruleId: 'documentation.type-missing-description',
    pack: 'common',
    category: 'documentation',
    defaultSeverity: 'info',
    rationale: 'Types should explain what they model.',
    docsAnchor: 'documentation-type-missing-description',
    enabled: true,
    severity: 'error', // stored severity override
  },
  {
    ruleId: 'naming.schema-pascal-case',
    pack: 'openapi',
    category: 'naming',
    defaultSeverity: 'warning',
    rationale: 'Schema names should be PascalCase for consistency.',
    docsAnchor: 'naming-schema-pascal-case',
    enabled: false,
    severity: 'warning',
  },
];

function makeView(rules = RULES, source: 'builtin' | 'custom' = 'custom') {
  return {
    guideId: GUIDE_ID,
    guideName: 'Payments Guide',
    source,
    rules,
    count: rules.length,
    enabledCount: rules.filter((r) => r.enabled).length,
    docsPage: 'docs/guide/lint-rules.md',
  };
}

let isAdmin = true;
let guideSource: 'builtin' | 'custom' = 'custom';
let calls: { url: string; method: string; body: unknown }[] = [];

function jsonResponse(payload: unknown) {
  return Promise.resolve({
    status: 200,
    json: () => Promise.resolve(payload),
  } as Response);
}

function mockFetch() {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, method, body });

    if (url.includes('/api/access/permissions/me')) {
      return jsonResponse({ success: true, data: { is_admin: isAdmin, permissions: [] } });
    }
    if (url.includes(`/api/style-guides/${GUIDE_ID}/rules`) && method === 'PUT') {
      // Echo the saved state back, as the REST layer does: merge the PUT rows onto the
      // registry facts so the screen can re-baseline from the response.
      const putRules = (body as { rules: { ruleId: string; enabled: boolean; severity: string }[] }).rules;
      const byId = new Map(putRules.map((r) => [r.ruleId, r]));
      const rules = RULES.map((r) => ({
        ...r,
        enabled: byId.get(r.ruleId)?.enabled ?? false,
        severity: byId.get(r.ruleId)?.severity ?? r.defaultSeverity,
      }));
      return jsonResponse({ success: true, data: makeView(rules, guideSource) });
    }
    if (url.includes(`/api/style-guides/${GUIDE_ID}/rules`)) {
      return jsonResponse({
        success: true,
        data: makeView(
          guideSource === 'builtin' ? RULES.map((r) => ({ ...r, enabled: true })) : RULES,
          guideSource,
        ),
      });
    }
    return jsonResponse({ success: false, error: 'Unexpected request' });
  });
  // @ts-expect-error - assigning a test double to the global
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  isAdmin = true;
  guideSource = 'custom';
  calls = [];
  mockConfirm.mockClear();
  mockConfirm.mockResolvedValue(true);
  mockPush.mockClear();
  mockFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Render the editor and wait for the rules payload to land. */
async function renderEditor() {
  render(<GuideEditorClient guideId={GUIDE_ID} />);
  await screen.findByText('documentation.operation-missing-summary');
}

describe('GuideEditorClient — rule catalog rendering', () => {
  it('renders every rule grouped by category with rationale and default severity', async () => {
    await renderEditor();

    // Guide header, tab, and live count. The name is asserted on the `h1` rather than by
    // text: the redesign's breadcrumb ends on the guide, so the name is on the page twice.
    expect(
      screen.getByRole('heading', { name: 'Payments Guide', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Rule catalog')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 rules enabled')).toBeInTheDocument();

    // Category groups with per-group counts.
    const documentation = screen.getByRole('region', { name: 'documentation rules' });
    const naming = screen.getByRole('region', { name: 'naming rules' });
    expect(within(documentation).getAllByRole('listitem')).toHaveLength(2);
    expect(within(naming).getAllByRole('listitem')).toHaveLength(1);
    expect(within(documentation).getByText('2 of 2 on')).toBeInTheDocument();
    expect(within(naming).getByText('0 of 1 on')).toBeInTheDocument();

    // Rationale and default-severity chips.
    expect(
      screen.getByText('Operations without a summary are hard to scan in generated docs.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('default: warning')).toHaveLength(2);
    expect(screen.getByText('default: info')).toBeInTheDocument();

    // Enable switches and severity selects reflect the stored state.
    expect(screen.getByLabelText('Enable documentation.operation-missing-summary')).toBeChecked();
    expect(screen.getByLabelText('Enable naming.schema-pascal-case')).not.toBeChecked();
    expect(
      screen.getByLabelText('Severity for documentation.type-missing-description'),
    ).toHaveValue('error');
    // A disabled rule's severity select is inert until the rule is enabled.
    expect(screen.getByLabelText('Severity for naming.schema-pascal-case')).toBeDisabled();
  });

  it('filters rules by search term', async () => {
    await renderEditor();

    fireEvent.change(screen.getByLabelText('Search rules'), { target: { value: 'pascal' } });

    expect(screen.getByText('naming.schema-pascal-case')).toBeInTheDocument();
    expect(screen.queryByText('documentation.operation-missing-summary')).toBeNull();
    expect(screen.queryByRole('region', { name: 'documentation rules' })).toBeNull();
  });

  it('shows an empty state when nothing matches the search', async () => {
    await renderEditor();

    fireEvent.change(screen.getByLabelText('Search rules'), {
      target: { value: 'nothing-matches-this' },
    });

    expect(screen.getByText('No rules match your search.')).toBeInTheDocument();
  });

  it('filters rules by category', async () => {
    await renderEditor();

    fireEvent.change(screen.getByLabelText('Filter by category'), {
      target: { value: 'naming' },
    });

    expect(screen.getByText('naming.schema-pascal-case')).toBeInTheDocument();
    expect(screen.queryByText('documentation.type-missing-description')).toBeNull();
  });
});

describe('GuideEditorClient — editing and the dirty-state save bar', () => {
  it('tracks toggles in the save bar, updates the live count, and discards cleanly', async () => {
    await renderEditor();
    expect(screen.queryByText(/unsaved rule change/)).toBeNull();

    fireEvent.click(screen.getByLabelText('Enable naming.schema-pascal-case'));

    expect(screen.getByText('1 unsaved rule change')).toBeInTheDocument();
    expect(screen.getByText('3 of 3 rules enabled')).toBeInTheDocument();
    expect(screen.getByText('modified')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Discard'));

    expect(screen.queryByText(/unsaved rule change/)).toBeNull();
    expect(screen.getByText('2 of 3 rules enabled')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable naming.schema-pascal-case')).not.toBeChecked();
    // Nothing was persisted.
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();
  });

  it('saves the full rule set via PUT and re-baselines from the response', async () => {
    await renderEditor();

    fireEvent.click(screen.getByLabelText('Enable naming.schema-pascal-case'));
    fireEvent.change(screen.getByLabelText('Severity for naming.schema-pascal-case'), {
      target: { value: 'error' },
    });
    expect(screen.getByText('1 unsaved rule change')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(screen.queryByText(/unsaved rule change/)).toBeNull());

    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toContain(`/api/style-guides/${GUIDE_ID}/rules`);
    // The payload is the complete rule state — one entry per catalog rule.
    expect(put!.body).toEqual({
      rules: [
        {
          ruleId: 'documentation.operation-missing-summary',
          enabled: true,
          severity: 'warning',
        },
        {
          ruleId: 'documentation.type-missing-description',
          enabled: true,
          severity: 'error',
        },
        { ruleId: 'naming.schema-pascal-case', enabled: true, severity: 'error' },
      ],
    });

    // Saved state is the new baseline: counts reflect it, nothing reads as modified.
    expect(screen.getByText('3 of 3 rules enabled')).toBeInTheDocument();
    expect(screen.queryByText('modified')).toBeNull();
  });

  it('marks a severity-only change as dirty', async () => {
    await renderEditor();

    fireEvent.change(
      screen.getByLabelText('Severity for documentation.operation-missing-summary'),
      { target: { value: 'error' } },
    );

    expect(screen.getByText('1 unsaved rule change')).toBeInTheDocument();
    expect(screen.getByText('modified')).toBeInTheDocument();
  });

  it('warns before navigating back with unsaved changes and stays when declined', async () => {
    mockConfirm.mockResolvedValue(false);
    await renderEditor();

    fireEvent.click(screen.getByLabelText('Enable naming.schema-pascal-case'));
    fireEvent.click(screen.getByLabelText('Back to style guides'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('navigates back after confirming the unsaved-changes warning', async () => {
    await renderEditor();

    fireEvent.click(screen.getByLabelText('Enable naming.schema-pascal-case'));
    fireEvent.click(screen.getByLabelText('Back to style guides'));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/style-guides'));
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('navigates back without a warning when nothing changed', async () => {
    await renderEditor();

    fireEvent.click(screen.getByLabelText('Back to style guides'));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/style-guides'));
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe('GuideEditorClient — read-only rendering', () => {
  it('disables editing on the built-in guide and explains why', async () => {
    guideSource = 'builtin';
    await renderEditor();

    expect(screen.getByText('Built-in')).toBeInTheDocument();
    expect(screen.getByText(/read-only\. Duplicate it/)).toBeInTheDocument();
    expect(screen.getByLabelText('Enable documentation.operation-missing-summary')).toBeDisabled();
    expect(
      screen.getByLabelText('Severity for documentation.operation-missing-summary'),
    ).toBeDisabled();
  });

  it('disables editing for non-admin members and explains why', async () => {
    isAdmin = false;
    await renderEditor();

    expect(screen.getByText(/Only tenant administrators/)).toBeInTheDocument();
    expect(screen.getByLabelText('Enable documentation.operation-missing-summary')).toBeDisabled();
    expect(screen.getByLabelText('Enable naming.schema-pascal-case')).toBeDisabled();
  });
});
