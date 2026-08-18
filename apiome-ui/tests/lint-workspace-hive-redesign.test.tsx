/**
 * The lint posture workspace, rendered (HIVE-5.8, #5311).
 *
 * `lint-workspace-model.test.ts` pins the rules and `lint-workspace-css.test.ts` pins the
 * declarations; this suite pins what the six components actually put on screen and what they
 * call back with — the mockup's **Notes → Keeps (1:1)** list, one `it` at a time.
 *
 * Two jsdom notes, both learned the expensive way on #5304:
 *
 * * `fireEvent.click` does not drive a Radix `Tabs.Trigger` (it changes value from
 *   `onMouseDown`) and does not open a `DropdownMenu` (it opens on `pointerdown`, which jsdom
 *   does not synthesise). The tab strip here is a plain `<button role="tab">`, so a click is
 *   enough — but `Segmented`'s options are Radix-flavoured `role="radio"` buttons that answer
 *   `onClick`, which is why the window switch is clicked and the shortcuts are not.
 * * Radix `Dialog`/`Drawer` never writes `aria-modal` in jsdom and its focus restoration does
 *   not settle, so those two are asserted in `e2e/hive-lint-workspace.spec.ts` instead.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import LintPostureSummary from '../src/app/components/ade/lintWorkspace/LintPostureSummary';
import LintSavedViewsBar from '../src/app/components/ade/lintWorkspace/LintSavedViewsBar';
import LintQueueTable from '../src/app/components/ade/lintWorkspace/LintQueueTable';
import LintWaiverDialog from '../src/app/components/ade/lintWorkspace/LintWaiverDialog';
import LintFindingDrawer from '../src/app/components/ade/lintWorkspace/LintFindingDrawer';
import LintTrendsPanel from '../src/app/components/ade/lintWorkspace/LintTrendsPanel';
import LintQualityRanksPanel from '../src/app/components/ade/lintWorkspace/LintQualityRanksPanel';
import {
  EMPTY_WORKSPACE_FILTERS,
  selectionKey,
  type WorkspaceFilters,
} from '../src/app/utils/lint-workspace';
import {
  FINDINGS,
  finding,
  findingsPage,
  rankFormat,
  rankSeries,
  savedView,
  summary,
  trends,
} from './helpers/lint-workspace-fixtures';

/** The empty filter bundle, plus whatever a case is about. */
function filters(overrides: Partial<WorkspaceFilters> = {}): WorkspaceFilters {
  return { ...EMPTY_WORKSPACE_FILTERS, ...overrides };
}

// =========================================================================================
// The posture summary
// =========================================================================================

describe('LintPostureSummary', () => {
  it('draws the four tiles with their figures, units and footnotes', () => {
    render(<LintPostureSummary summary={summary()} onDrillDown={jest.fn()} />);
    expect(screen.getByTestId('summary-security-errors')).toHaveTextContent('2');
    expect(screen.getByTestId('summary-security-errors')).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('summary-coverage')).toHaveTextContent('of 12 subjects');
    expect(screen.getByTestId('summary-new')).toHaveTextContent('7');
    expect(screen.getByTestId('summary-waiver-requests')).toHaveTextContent(
      '3 requested · 1 expiring soon'
    );
  });

  it('makes every tile a real button, so all four can be drilled into', () => {
    const onDrillDown = jest.fn();
    render(<LintPostureSummary summary={summary()} onDrillDown={onDrillDown} />);
    for (const target of ['security-errors', 'coverage', 'new', 'waiver-requests'] as const) {
      const tile = screen.getByTestId(`summary-${target}`);
      expect(tile.tagName).toBe('BUTTON');
      // A `button` with no explicit type submits whatever form it lands in.
      expect(tile).toHaveAttribute('type', 'button');
      fireEvent.click(tile);
      expect(onDrillDown).toHaveBeenCalledWith(target);
    }
    expect(onDrillDown).toHaveBeenCalledTimes(4);
  });

  it('draws every grade band, including the ones with no subjects in them', () => {
    render(<LintPostureSummary summary={summary()} onDrillDown={jest.fn()} />);
    const grades = screen.getByTestId('summary-grades');
    for (const letter of ['A', 'B', 'C', 'D', 'F']) {
      expect(within(grades).getByText(letter)).toBeInTheDocument();
    }
    expect(within(grades).getByText('Ungraded')).toBeInTheDocument();
  });

  it('says an unassessed axis is unassessed rather than scoring it zero', () => {
    render(<LintPostureSummary summary={summary()} onDrillDown={jest.fn()} />);
    expect(screen.getByTestId('summary-axis-quality')).toHaveTextContent('Quality · 84');
    const supply = screen.getByTestId('summary-axis-supply_chain');
    expect(supply).toHaveTextContent('Supply chain · —');
    expect(supply).toHaveAttribute('title', 'Supply chain: not assessed anywhere');
  });

  it('holds the strip’s shape while the summary is being read', () => {
    render(<LintPostureSummary summary={null} loading onDrillDown={jest.fn()} />);
    expect(screen.getByTestId('lint-workspace-summary-skeleton')).toBeInTheDocument();
  });

  it('draws nothing at all when the summary read failed', () => {
    const { container } = render(
      <LintPostureSummary summary={null} loading={false} onDrillDown={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// =========================================================================================
// Saved views
// =========================================================================================

describe('LintSavedViewsBar', () => {
  function renderBar(
    props: Partial<React.ComponentProps<typeof LintSavedViewsBar>> = {},
    current: Partial<WorkspaceFilters> = {}
  ) {
    const handlers = {
      onApply: jest.fn(),
      onSaveCurrent: jest.fn(),
      onTogglePin: jest.fn(),
      onDelete: jest.fn(),
      onSaveOpenChange: jest.fn(),
    };
    render(
      <LintSavedViewsBar
        views={[
          savedView(),
          savedView({
            id: 'view-2',
            name: 'My waivers',
            isPinned: false,
            filters: { state: ['waiver_requested'] },
          }),
        ]}
        filters={filters(current)}
        sort="severity"
        saveOpen={false}
        {...handlers}
        {...props}
      />
    );
    return handlers;
  }

  it('applies, pins and deletes a view', () => {
    const handlers = renderBar();
    const chips = screen.getAllByTestId('saved-view-chip');
    expect(chips).toHaveLength(2);
    fireEvent.click(within(chips[0]).getByTestId('saved-view-apply'));
    expect(handlers.onApply).toHaveBeenCalledWith(expect.objectContaining({ id: 'view-1' }));
    fireEvent.click(within(chips[1]).getByTestId('saved-view-pin'));
    expect(handlers.onTogglePin).toHaveBeenCalledWith(expect.objectContaining({ id: 'view-2' }));
    fireEvent.click(within(chips[0]).getByTestId('saved-view-delete'));
    expect(handlers.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'view-1' }));
  });

  it('names the pin action for the view it belongs to', () => {
    renderBar();
    expect(screen.getByLabelText('Unpin New security errors')).toBeInTheDocument();
    expect(screen.getByLabelText('Pin My waivers')).toBeInTheDocument();
  });

  it('marks the view a reader is actually looking at, and only that one', () => {
    renderBar({}, { severity: ['error'], axis: ['security'], state: ['open'] });
    const chips = screen.getAllByTestId('saved-view-chip');
    expect(chips[0]).toHaveAttribute('data-current', 'true');
    expect(chips[1]).not.toHaveAttribute('data-current');
  });

  it('marks none of them once a facet is flipped', () => {
    renderBar({}, { severity: ['error'], axis: ['security'] });
    for (const chip of screen.getAllByTestId('saved-view-chip')) {
      expect(chip).not.toHaveAttribute('data-current');
    }
  });

  it('will not save an unnamed view, and shows what it would save', () => {
    const handlers = renderBar({ saveOpen: true }, { severity: ['error'] });
    expect(screen.getByTestId('saved-view-query')).toHaveTextContent('severity=error');
    expect(screen.getByTestId('saved-view-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('saved-view-name'), {
      target: { value: 'New security errors' },
    });
    fireEvent.click(screen.getByTestId('saved-view-submit'));
    expect(handlers.onSaveCurrent).toHaveBeenCalledWith('New security errors', true);
    expect(handlers.onSaveOpenChange).toHaveBeenCalledWith(false);
  });

  it('says so rather than showing a bare sort when nothing is narrowed', () => {
    renderBar({ saveOpen: true });
    expect(screen.getByTestId('saved-view-query')).toHaveTextContent(
      'No filters — the whole queue, sorted by severity'
    );
  });
});

// =========================================================================================
// The queue
// =========================================================================================

describe('LintQueueTable', () => {
  function renderQueue(props: Partial<React.ComponentProps<typeof LintQueueTable>> = {}) {
    const page = findingsPage();
    const handlers = {
      onRetry: jest.fn(),
      onFiltersChange: jest.fn(),
      onSortChange: jest.fn(),
      onOffsetChange: jest.fn(),
      onSelectionChange: jest.fn(),
      onOpenFinding: jest.fn(),
      onBulkApply: jest.fn(),
      onOpenWaiverDialog: jest.fn(),
    };
    const view = render(
      <LintQueueTable
        findings={page.findings}
        total={page.total}
        offset={0}
        facets={page.facets}
        filters={filters()}
        sort="severity"
        pathname="/ade/dashboard/lint-workspace"
        selected={new Set()}
        {...handlers}
        {...props}
      />
    );
    return { ...handlers, view };
  }

  it('draws the seven-column row: rule, New pill, message, path, severity, state, subject', () => {
    renderQueue();
    expect(screen.getByText('no-http-basic')).toBeInTheDocument();
    expect(screen.getByTestId('finding-new-pill')).toBeInTheDocument();
    expect(screen.getByText('HTTP Basic auth scheme detected.')).toBeInTheDocument();
    // Both fixture rows carry the same path; the assertion is that the row *draws* one.
    expect(screen.getAllByText('components.securitySchemes.basicAuth')).toHaveLength(2);
    // Scoped to the table body: the facet strip above it carries the same six words.
    const rows = within(screen.getByRole('table'));
    expect(rows.getByText('Error')).toBeInTheDocument();
    expect(rows.getByText('Acknowledged')).toBeInTheDocument();
    expect(rows.getAllByText('Payments API')).toHaveLength(2);
    expect(screen.getAllByText('apiome-security')).not.toHaveLength(0);
  });

  it('shows the finding’s composite grade, and says ungraded when there is none', () => {
    renderQueue({ findings: [finding(), finding({ sourceFingerprint: 'f3', compositeGrade: null })] });
    expect(screen.getAllByTitle('Composite grade B')).toHaveLength(1);
    expect(screen.getByText('ungraded')).toBeInTheDocument();
  });

  it('marks an MCP subject as one', () => {
    renderQueue({
      findings: [finding({ subjectType: 'mcp_endpoint_version', versionRecordId: null })],
    });
    expect(screen.getByText('MCP')).toBeInTheDocument();
  });

  it('draws all four facet groups with the counts from the read', () => {
    renderQueue();
    const facets = screen.getByTestId('workspace-facets');
    expect(within(facets).getByTestId('facet-severity-error')).toHaveTextContent('21');
    expect(within(facets).getByTestId('facet-state-open')).toHaveTextContent('168');
    expect(within(facets).getByTestId('facet-axis-supply_chain')).toBeInTheDocument();
    expect(within(facets).getByTestId('facet-grade-F')).toBeInTheDocument();
  });

  it('flips a facet on the dimension it belongs to', () => {
    const { onFiltersChange } = renderQueue();
    fireEvent.click(screen.getByTestId('facet-severity-error'));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ severity: ['error'] }));
    fireEvent.click(screen.getByTestId('facet-state-waived'));
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: ['waived'], severity: [] })
    );
  });

  it('states the chips as toggles whether or not they are on', () => {
    renderQueue({ filters: filters({ severity: ['error'] }) });
    expect(screen.getByTestId('facet-severity-error')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('facet-severity-info')).toHaveAttribute('aria-pressed', 'false');
  });

  it('drives the six toolbar controls', () => {
    const { onFiltersChange, onSortChange } = renderQueue();
    fireEvent.change(screen.getByTestId('workspace-search'), { target: { value: 'basic' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'basic' }));
    fireEvent.change(screen.getByTestId('workspace-sort'), { target: { value: 'newest' } });
    expect(onSortChange).toHaveBeenCalledWith('newest');
    fireEvent.change(screen.getByTestId('workspace-scanner'), { target: { value: 'spectral' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ scanner: ['spectral'] })
    );
    fireEvent.change(screen.getByTestId('workspace-coverage'), { target: { value: 'missing' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ coverage: 'missing' }));
    fireEvent.change(screen.getByTestId('workspace-subject-type'), {
      target: { value: 'mcp_endpoint_version' },
    });
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ subjectType: 'mcp_endpoint_version' })
    );
  });

  it('offers Clear filters only when something is narrowing the queue, and keeps the project', () => {
    const plain = renderQueue();
    expect(screen.queryByTestId('workspace-clear-filters')).not.toBeInTheDocument();
    plain.view.unmount();

    const { onFiltersChange } = renderQueue({
      filters: filters({ projectId: 'p1', severity: ['error'], newOnly: true }),
    });
    const clear = screen.getByTestId('workspace-clear-filters');
    expect(clear).toHaveTextContent('Clear filters (2)');
    fireEvent.click(clear);
    expect(onFiltersChange).toHaveBeenCalledWith({ ...EMPTY_WORKSPACE_FILTERS, projectId: 'p1' });
  });

  it('prints the address the current view is shareable at', () => {
    renderQueue({ filters: filters({ severity: ['error'] }), offset: 50 });
    const line = screen.getByTestId('workspace-url-line');
    expect(line).toHaveTextContent('/ade/dashboard/lint-workspace');
    expect(line).toHaveTextContent('severity=error');
    expect(line).toHaveTextContent('offset=50');
    expect(line).toHaveTextContent('selection clears when filters change');
  });

  it('selects a row, and reports the selection as ids', () => {
    const { onSelectionChange } = renderQueue();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set([selectionKey(FINDINGS[0])]));
  });

  it('opens a finding from its row', () => {
    const { onOpenFinding } = renderQueue();
    fireEvent.click(screen.getByText('no-http-basic'));
    expect(onOpenFinding).toHaveBeenCalledWith(FINDINGS[0]);
  });

  it('counts the offset window and pages by offset', () => {
    const { onOffsetChange } = renderQueue({ offset: 50 });
    expect(screen.getByTestId('queue-pagination-summary')).toHaveTextContent(
      '51–100 of 213 findings · page size 50'
    );
    fireEvent.click(screen.getByLabelText('Page 3'));
    expect(onOffsetChange).toHaveBeenCalledWith(100);
  });

  it('shows the bulk bar only while something is selected, and names what is selected', () => {
    const plain = renderQueue();
    expect(screen.queryByTestId('bulk-acknowledged')).not.toBeInTheDocument();
    plain.view.unmount();

    renderQueue({ selected: new Set([selectionKey(FINDINGS[0])]) });
    expect(screen.getByText('1 finding selected')).toBeInTheDocument();
  });

  it('applies the four direct verbs and routes the two waiver verbs to the dialog', () => {
    const { onBulkApply, onOpenWaiverDialog } = renderQueue({
      selected: new Set([selectionKey(FINDINGS[0])]),
    });
    fireEvent.click(screen.getByTestId('bulk-acknowledged'));
    expect(onBulkApply).toHaveBeenCalledWith({ state: 'acknowledged' }, 'Acknowledge');
    fireEvent.click(screen.getByTestId('bulk-fixed'));
    expect(onBulkApply).toHaveBeenLastCalledWith({ state: 'fixed' }, 'Mark fixed');
    fireEvent.click(screen.getByTestId('bulk-false_positive'));
    expect(onBulkApply).toHaveBeenLastCalledWith({ state: 'false_positive' }, 'False positive');
    fireEvent.click(screen.getByTestId('bulk-open'));
    expect(onBulkApply).toHaveBeenLastCalledWith({ state: 'open' }, 'Reopen / reject');

    fireEvent.click(screen.getByTestId('bulk-waiver_requested'));
    expect(onOpenWaiverDialog).toHaveBeenCalledWith('request');
    fireEvent.click(screen.getByTestId('bulk-waived'));
    expect(onOpenWaiverDialog).toHaveBeenLastCalledWith('approve');
  });

  it('says which permission the two review verbs need', () => {
    renderQueue({ selected: new Set([selectionKey(FINDINGS[0])]) });
    expect(screen.getByTestId('bulk-waived')).toHaveAttribute(
      'title',
      'Requires waiver approval permission (lint_findings:publish)'
    );
    expect(screen.getByTestId('bulk-open')).toHaveAttribute(
      'title',
      expect.stringContaining('also rejects requested waivers')
    );
  });

  it('assigns an owner without changing any state', () => {
    const { onBulkApply } = renderQueue({ selected: new Set([selectionKey(FINDINGS[0])]) });
    expect(screen.getByTestId('bulk-assign-owner')).toBeDisabled();
    fireEvent.change(screen.getByTestId('bulk-owner-input'), { target: { value: ' user-9 ' } });
    fireEvent.click(screen.getByTestId('bulk-assign-owner'));
    expect(onBulkApply).toHaveBeenCalledWith({ ownerUserId: 'user-9' }, 'Assign');
  });

  it('holds every verb while a write is in flight', () => {
    renderQueue({ selected: new Set([selectionKey(FINDINGS[0])]), bulkBusy: true });
    expect(screen.getByTestId('bulk-acknowledged')).toBeDisabled();
    expect(screen.getByTestId('bulk-waived')).toBeDisabled();
  });

  it('tells a narrowed reader to widen and an empty workspace what would fill it', () => {
    const narrowed = renderQueue({ findings: [], total: 0, filters: filters({ severity: ['error'] }) });
    expect(screen.getByText('No findings match the current filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workspace-empty-clear'));
    expect(narrowed.onFiltersChange).toHaveBeenCalledWith(EMPTY_WORKSPACE_FILTERS);
    narrowed.view.unmount();

    renderQueue({ findings: [], total: 0 });
    expect(screen.getByText('No lint findings in this workspace.')).toBeInTheDocument();
  });

  it('names what it is waiting for while the queue loads', () => {
    renderQueue({ findings: [], loading: true });
    expect(screen.getByText('Loading the findings queue…')).toBeInTheDocument();
  });

  it('reports a failed read as an error with a retry, not as an empty workspace', () => {
    const { onRetry } = renderQueue({ findings: [], total: 0, error: 'The service timed out (504).' });
    expect(screen.getByText('The service timed out (504).')).toBeInTheDocument();
    expect(screen.queryByText('No lint findings in this workspace.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

// =========================================================================================
// The waiver dialog
// =========================================================================================

describe('LintWaiverDialog', () => {
  it('is closed when it has no mode', () => {
    const { container } = render(
      <LintWaiverDialog mode={null} count={0} onClose={jest.fn()} onSubmit={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('requires a rationale to request a waiver', () => {
    const onSubmit = jest.fn();
    render(<LintWaiverDialog mode="request" count={2} onClose={jest.fn()} onSubmit={onSubmit} />);
    expect(screen.getByText('Request waiver for 2 findings')).toBeInTheDocument();
    expect(screen.getByTestId('waiver-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('waiver-rationale'), {
      target: { value: ' Vendor accepts the risk until Q4. ' },
    });
    fireEvent.click(screen.getByTestId('waiver-submit'));
    expect(onSubmit).toHaveBeenCalledWith({
      state: 'waiver_requested',
      rationale: 'Vendor accepts the risk until Q4.',
    });
  });

  it('requires a rationale AND an expiry to approve one', () => {
    const onSubmit = jest.fn();
    render(<LintWaiverDialog mode="approve" count={1} onClose={jest.fn()} onSubmit={onSubmit} />);
    expect(screen.getByText('Approve waiver for 1 finding')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('waiver-rationale'), { target: { value: 'Approved.' } });
    expect(screen.getByTestId('waiver-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('waiver-expires'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByTestId('waiver-submit'));
    expect(onSubmit).toHaveBeenCalledWith({
      state: 'waived',
      rationale: 'Approved.',
      expiresAt: new Date('2026-09-30').toISOString(),
    });
  });

  it('carries the optional ticket, and says which permission approving needs', () => {
    const onSubmit = jest.fn();
    render(<LintWaiverDialog mode="approve" count={1} onClose={jest.fn()} onSubmit={onSubmit} />);
    expect(screen.getByTestId('waiver-permission-note')).toHaveTextContent(
      'lint_findings:publish'
    );
    fireEvent.change(screen.getByTestId('waiver-rationale'), { target: { value: 'Approved.' } });
    fireEvent.change(screen.getByTestId('waiver-expires'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByTestId('waiver-ticket'), {
      target: { value: 'https://tracker/SEC-1182' },
    });
    fireEvent.click(screen.getByTestId('waiver-submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ linkedTicket: 'https://tracker/SEC-1182' })
    );
  });
});

// =========================================================================================
// The finding drawer
// =========================================================================================

describe('LintFindingDrawer', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function renderDrawer(props: Partial<React.ComponentProps<typeof LintFindingDrawer>> = {}) {
    const handlers = { onClose: jest.fn(), onDecision: jest.fn(), onRequestWaiver: jest.fn() };
    render(<LintFindingDrawer finding={finding()} {...handlers} {...props} />);
    return handlers;
  }

  it('is closed when it has no finding', () => {
    const { container } = render(
      <LintFindingDrawer
        finding={null}
        onClose={jest.fn()}
        onDecision={jest.fn()}
        onRequestWaiver={jest.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the six evidence fields the acceptance criteria name', () => {
    renderDrawer();
    const evidence = screen.getByTestId('detail-evidence');
    expect(within(evidence).getByText('apiome-security')).toBeInTheDocument();
    expect(within(evidence).getByText('Acme REST · security pack')).toBeInTheDocument();
    expect(screen.getByTestId('detail-evidence-run')).toHaveTextContent('run_7c1e92');
    expect(screen.getByTestId('detail-location')).toHaveTextContent(
      'path: components.securitySchemes.basicAuth, line: 412'
    );
    expect(screen.getByTestId('detail-remediation')).toHaveTextContent('OAuth2');
  });

  it('links the subject and states the policy verdict with its evaluation', () => {
    renderDrawer();
    expect(screen.getByTestId('detail-subject-link')).toHaveAttribute(
      'href',
      '/ade/dashboard/versions?projectId=p1'
    );
    const policy = screen.getByTestId('detail-policy');
    expect(policy).toHaveTextContent('Failed');
    expect(policy).toHaveTextContent('ev_44b0c1');
  });

  it('says no decisions were recorded when the finding has none', () => {
    renderDrawer();
    expect(screen.getByTestId('detail-history-empty')).toBeInTheDocument();
  });

  it('reads the remediation history for a finding that has a decision', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        events: [
          {
            id: 'e1',
            beforeState: 'open',
            afterState: 'waiver_requested',
            rationale: 'Legacy partner',
            actorLabel: 'Linus Torvalds',
            createdAt: 'Aug 14, 2026',
          },
        ],
      }),
    }) as unknown as typeof fetch;

    renderDrawer({ finding: FINDINGS[1] });
    await waitFor(() =>
      expect(screen.getByTestId('detail-history-event')).toHaveTextContent(
        'Open → Waiver requested'
      )
    );
    expect(screen.getByTestId('detail-history-event')).toHaveTextContent('Legacy partner');
  });

  it('says the history could not be read rather than saying there is none', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: 'Evidence service unavailable' }),
    }) as unknown as typeof fetch;

    renderDrawer({ finding: FINDINGS[1] });
    await waitFor(() =>
      expect(screen.getByTestId('detail-history-error')).toHaveTextContent(
        'Evidence service unavailable'
      )
    );
  });

  it('acknowledges this one finding, and sends the waiver through the dialog', () => {
    const handlers = renderDrawer();
    fireEvent.click(screen.getByTestId('detail-acknowledge'));
    expect(handlers.onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'no-http-basic' }),
      { state: 'acknowledged' },
      'Acknowledge'
    );
    fireEvent.click(screen.getByTestId('detail-request-waiver'));
    expect(handlers.onRequestWaiver).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'no-http-basic' })
    );
    // Never applied directly: a waiver with no rationale is one the server refuses.
    expect(handlers.onDecision).toHaveBeenCalledTimes(1);
  });

  it('offers the lint report only for a finding that has a revision to report on', () => {
    const withRevision = renderDrawer();
    expect(screen.getByTestId('detail-open-lint-report')).toBeInTheDocument();
    void withRevision;
    screen.getByTestId('finding-detail-drawer');
  });

  it('offers no lint report for an MCP finding, which has no revision', () => {
    renderDrawer({
      finding: finding({ versionRecordId: null, mcpVersionId: 'mcp-1', subjectType: 'mcp_endpoint_version' }),
    });
    expect(screen.queryByTestId('detail-open-lint-report')).not.toBeInTheDocument();
  });
});

// =========================================================================================
// Trends
// =========================================================================================

describe('LintTrendsPanel', () => {
  it('splits remediation from policy, and totals each series over the window', () => {
    render(<LintTrendsPanel trends={trends(3)} />);
    expect(screen.getByTestId('trend-newFindings')).toHaveTextContent('6 in 30d');
    expect(screen.getByTestId('trend-remediatedFindings')).toHaveTextContent('3 in 30d');
    expect(screen.getByTestId('trend-waiversGranted')).toBeInTheDocument();
    expect(screen.getByTestId('trend-policyPackPublications')).toBeInTheDocument();
  });

  it('keeps both notes, which are the reason the split exists', () => {
    render(<LintTrendsPanel trends={trends(3)} />);
    expect(screen.getByText(/genuine fixes only/)).toBeInTheDocument();
    expect(screen.getByText(/attributable to fixes, not rule changes/)).toBeInTheDocument();
  });

  it('names each series to a screen reader rather than leaving a shape unlabelled', () => {
    render(<LintTrendsPanel trends={trends(3)} />);
    expect(
      screen.getByRole('img', { name: /New findings per day over the last 30 days/ })
    ).toBeInTheDocument();
  });

  it('shows the tab-level empty state when there is no series at all', () => {
    render(<LintTrendsPanel trends={null} />);
    expect(screen.getByText('No trend data yet')).toBeInTheDocument();
    render(<LintTrendsPanel trends={{ days: 30, series: [] }} />);
    expect(screen.getAllByText('No trend data yet')).toHaveLength(2);
  });
});

// =========================================================================================
// Quality ranks
// =========================================================================================

describe('LintQualityRanksPanel', () => {
  it('draws one card per (scope, format) with its distribution and its trend', () => {
    render(
      <LintQualityRanksPanel
        series={rankSeries({
          formats: [rankFormat(), rankFormat({ scope: 'export', formatKey: 'grpc' })],
        })}
        days={30}
        onDaysChange={jest.fn()}
      />
    );
    expect(screen.getByTestId('quality-rank-import-openapi-3.1')).toBeInTheDocument();
    expect(screen.getByTestId('quality-rank-export-grpc')).toBeInTheDocument();
    expect(screen.getByTestId('grade-distribution-openapi-3.1')).toBeInTheDocument();
    expect(screen.getByTestId('score-trend-openapi-3.1')).toBeInTheDocument();
  });

  it('reports the outcomes an import has and the ones an export has', () => {
    const { unmount } = render(
      <LintQualityRanksPanel series={rankSeries()} days={30} onDaysChange={jest.fn()} />
    );
    expect(screen.getByTestId('stat-secondary')).toHaveTextContent('Blocked');
    expect(screen.getByTestId('stat-tertiary')).toHaveTextContent('Warned');
    unmount();

    render(
      <LintQualityRanksPanel
        series={rankSeries({
          formats: [rankFormat({ scope: 'export', averageReadiness: 96, bestRank: 1 })],
        })}
        days={30}
        onDaysChange={jest.fn()}
      />
    );
    expect(screen.getByTestId('stat-secondary')).toHaveTextContent('Average readiness');
    expect(screen.getByTestId('stat-tertiary')).toHaveTextContent('Best rank');
  });

  it('renders an em dash rather than a zero for an unmeasured figure', () => {
    render(
      <LintQualityRanksPanel
        series={rankSeries({ formats: [rankFormat({ averageScore: null })] })}
        days={30}
        onDaysChange={jest.fn()}
      />
    );
    expect(within(screen.getByTestId('stat-primary')).getByText('—')).toBeInTheDocument();
  });

  it('states the drift, and says a format never drifted rather than calling it flat', () => {
    const { unmount } = render(
      <LintQualityRanksPanel series={rankSeries()} days={30} onDaysChange={jest.fn()} />
    );
    expect(screen.getByTestId('rank-drift')).toHaveTextContent('+6 pts over the window');
    unmount();

    render(
      <LintQualityRanksPanel
        series={rankSeries({ formats: [rankFormat({ scoreDelta: null })] })}
        days={30}
        onDaysChange={jest.fn()}
      />
    );
    expect(screen.getByTestId('rank-drift')).toHaveTextContent('No drift');
  });

  it('splits adapter findings from specification findings and says which is which', () => {
    render(<LintQualityRanksPanel series={rankSeries()} days={30} onDaysChange={jest.fn()} />);
    const attribution = screen.getByTestId('attribution-import-openapi-3.1');
    expect(attribution).toHaveTextContent('38% adapter · 62% specification');
    expect(attribution).toHaveTextContent('cannot read yet');
  });

  it('warns when the grades in a window came from more than one guide version', () => {
    render(
      <LintQualityRanksPanel
        series={rankSeries({ formats: [rankFormat({ styleGuideVersions: ['a', 'b'] })] })}
        days={30}
        onDaysChange={jest.fn()}
      />
    );
    expect(screen.getByTestId('rank-guide-drift-note')).toHaveTextContent(
      '2 style-guide versions'
    );
  });

  it('says the view was capped rather than implying it is the whole picture', () => {
    render(
      <LintQualityRanksPanel
        series={rankSeries({ truncated: true })}
        days={30}
        onDaysChange={jest.fn()}
      />
    );
    expect(screen.getByTestId('quality-rank-truncated')).toHaveTextContent('the busiest 6');
  });

  it('changes the window', () => {
    const onDaysChange = jest.fn();
    render(<LintQualityRanksPanel series={rankSeries()} days={30} onDaysChange={onDaysChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '90d' }));
    expect(onDaysChange).toHaveBeenCalledWith(90);
  });

  it('distinguishes a window with no grades from a tab with no data at all', () => {
    const { unmount } = render(
      <LintQualityRanksPanel
        series={rankSeries({ formats: [] })}
        days={30}
        onDaysChange={jest.fn()}
      />
    );
    expect(screen.getByTestId('quality-rank-window-empty')).toBeInTheDocument();
    unmount();

    render(<LintQualityRanksPanel series={null} days={30} onDaysChange={jest.fn()} />);
    expect(screen.getByText('No quality-rank data yet')).toBeInTheDocument();
  });
});
