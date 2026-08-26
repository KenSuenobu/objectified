/**
 * Repository detail → Files tab → *Import selected* for a multi-row selection: the batch wizard
 * (BLK-1.4, #5526).
 *
 * Ordered by the ticket's acceptance criteria:
 *
 *   1. **One wizard covering all N** — the review table has a row per importable item, each
 *      stating its resolution and why, with the header summary and the policy in force.
 *   2. **A per-row override changes only that row**, and is what the request carries.
 *   3. **Verify runs without writing** — it is the BLK-1.3 `dry_run`, and Apply is unreachable
 *      until it has run or is deliberately skipped — **and Apply sends exactly what Verify did.**
 *   4. **Partial failure is legible**: the failed row shows its reason, the other still
 *      completes, and the summary reconciles.
 *   5. **A stale plan is refused with the drift named**, and *Re-plan* starts over.
 *   6. **Closing** hands control back through `onOpenChange`; the Files tab keeps its state.
 *   7. **axe: zero violations** on the review table and the per-row control.
 *
 * The run itself is `CatalogBulkImportPanel`, whose own suite covers the poll; here its two
 * calls are answered by a routed `fetch` and the shared per-item panels are stubbed.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

import { RepositoryBulkImportPanel } from '@/app/components/ade/dashboard/repositories/RepositoryBulkImportPanel';
import type { BulkPlan } from '@/app/components/ade/dashboard/catalog/bulkImportModel';

jest.mock('@/app/components/ade/dashboard/ImportExecutionPanel', () => ({
  __esModule: true,
  default: ({ jobId }: { jobId: string }) => <div data-testid="execution-panel">{jobId}</div>,
}));
jest.mock('@/app/components/ade/dashboard/ImportCompletePanel', () => ({
  __esModule: true,
  default: ({ jobId }: { jobId: string }) => <div data-testid="complete-panel">{jobId}</div>,
}));

const ORDERS = 'openapi/orders.yaml';
const EVENTS = 'events/shipping.asyncapi.yaml';
const FUTURE = 'future/spec.yaml';

const PROJECTS = [
  { id: 'p-orders', name: 'Orders API', slug: 'orders-api' },
  { id: 'p-shipping', name: 'Shipping', slug: 'shipping' },
];

const PLAN: BulkPlan = {
  items: [
    {
      key: ORDERS,
      root_path: ORDERS,
      members: [ORDERS],
      total_bytes: 88,
      source_kind: 'openapi',
      format: 'openapi-3.0',
      confidence: 0.99,
      importable: true,
      predicted_target: 'project',
      input_kind: 'file',
      suggested_name: 'Orders API',
      suggested_slug: 'orders-api',
      reason: 'independent document',
      resolution: 'append-version',
      matched_project: { project_id: 'p-orders', name: 'Orders API', slug: 'orders-api' },
      match_basis: 'repository-provenance',
      match_detail: 'A previous import of this path created Orders API.',
      match_confidence: 1,
      proposed_version: { version_id: '1.1.0', derived_from: 'version-bump', previous_version_id: '1.0.0' },
    },
    {
      key: EVENTS,
      root_path: EVENTS,
      members: [EVENTS, 'events/common.yaml'],
      total_bytes: 96,
      source_kind: 'asyncapi',
      format: 'asyncapi-2',
      confidence: 0.98,
      importable: true,
      predicted_target: 'catalog',
      input_kind: 'fileset',
      suggested_name: 'Shipping Events',
      suggested_slug: 'shipping-events',
      reason: 'independent document',
      resolution: 'create-project',
      matched_project: null,
      proposed_version: { version_id: '1.0.0', derived_from: 'default' },
    },
    {
      key: FUTURE,
      root_path: FUTURE,
      members: [FUTURE],
      total_bytes: 12,
      source_kind: null,
      format: 'future-format',
      importable: false,
      predicted_target: 'catalog',
      input_kind: 'file',
      suggested_name: 'spec',
      suggested_slug: 'spec',
      reason: 'independent document',
      resolution: 'create-project',
      proposed_version: { version_id: '1.0.0', derived_from: 'default' },
    },
  ],
  skipped: [{ path: 'protos/common/types.proto', reason: 'not-an-item-root' }],
  truncated: false,
  total_items: 3,
  max_items: 50,
  source_label: 'acme/widgets@abc1234',
  version_policy: 'append-when-matched',
  version_policy_source: 'tenant',
  plan_fingerprint: 'bp1.reviewed-plan',
  summary: {
    items: 3,
    importable: 2,
    unimportable: 1,
    skipped_files: 1,
    by_target: { project: 1, catalog: 2 },
    by_format: { 'openapi-3.0': 1, 'asyncapi-2': 1, 'future-format': 1 },
    by_resolution: { 'append-version': 1, 'create-project': 2 },
    matched: 1,
  },
};

/** What the routed `fetch` saw. */
let submits: Array<Record<string, unknown>> = [];
let plans = 0;
/** Refuse the next submit as a stale plan. */
let staleNext = false;

/**
 * The submit's rows: the orders spec starts (as whatever the overrides say), the events spec
 * is refused by the quality policy — the partial failure the batch guarantee is about.
 */
function startResponse(body: Record<string, unknown>) {
  const overrides = Array.isArray(body.overrides) ? (body.overrides as Array<Record<string, unknown>>) : [];
  const orders = overrides.find((entry) => entry.key === ORDERS);
  const events = overrides.find((entry) => entry.key === EVENTS);
  return {
    success: true,
    batch_id: 'batch-1',
    dry_run: Boolean(body.dry_run),
    items: [
      {
        key: ORDERS,
        root_path: ORDERS,
        format: 'openapi-3.0',
        predicted_target: 'project',
        name: 'Orders API',
        slug: 'orders-api',
        state: 'accepted',
        job_id: 'job-1',
        resolution: orders?.mode === 'new' ? 'create-project' : 'append-version',
        target_project_id: orders?.mode === 'new' ? null : 'p-orders',
        version_id: orders?.mode === 'new' ? '1.0.0' : '1.1.0',
        overridden: Boolean(orders),
        resolution_detail: orders?.mode === 'new' ? 'Creates project orders-api.' : 'Appends version 1.1.0 to Orders API.',
      },
      {
        key: EVENTS,
        root_path: EVENTS,
        format: 'asyncapi-2',
        predicted_target: 'catalog',
        name: 'Shipping Events',
        slug: 'shipping-events',
        state: 'failed',
        resolution: events?.mode === 'existing' ? 'append-version' : 'create-project',
        target_project_id: events?.project_id ?? null,
        error: {
          code: 'QUALITY_POLICY_BLOCKED',
          category: 'policy',
          message: 'Import scores D, below the tenant floor of B.',
          remediation: 'Fix the findings and import again.',
          retriable: false,
        },
      },
    ],
    skipped: PLAN.skipped,
    summary: { requested: 2, accepted: 1, failed: 1 },
  };
}

function statusResponse(dryRun: boolean) {
  return {
    success: true,
    items: [
      {
        key: ORDERS,
        job_id: 'job-1',
        state: 'completed',
        percent: 100,
        target: 'project',
        project_slug: dryRun ? null : 'orders-api',
        project_id: dryRun ? null : 'p-orders',
        version_id: '1.1.0',
        outcome: dryRun ? null : 'version-appended',
      },
    ],
    summary: { total: 1, completed: 1, failed: 0, running: 0, not_found: 0, created: 0, appended: dryRun ? 0 : 1 },
    done: true,
  };
}

function installFetch(): void {
  global.fetch = jest.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (payload: unknown, status = 200) => ({
      ok: status < 400,
      status,
      statusText: status < 400 ? 'OK' : 'Error',
      json: async () => payload,
    });
    if (url.endsWith('/api/catalog/import/bulk/plan')) {
      plans += 1;
      return ok(PLAN);
    }
    if (url.endsWith('/api/catalog/import/bulk/status')) {
      const last = submits.at(-1);
      return ok(statusResponse(Boolean(last?.dry_run)));
    }
    if (url.endsWith('/api/catalog/import/bulk')) {
      submits.push(body);
      if (staleNext) {
        staleNext = false;
        return ok(
          {
            success: false,
            error: 'The plan you reviewed no longer describes this batch: 1 item(s) changed.',
            detail: {
              code: 'TARGET_PLAN_STALE',
              category: 'input',
              message: 'The plan you reviewed no longer describes this batch: 1 item(s) changed.',
              remediation: 'Re-plan the payload.',
              retriable: true,
              drift: [
                {
                  key: ORDERS,
                  change: 'version',
                  reviewed: 'append-version onto project p-orders at 1.1.0',
                  current: 'append-version onto project p-orders at 1.2.0',
                  detail: `'${ORDERS}' would create a different version now.`,
                },
              ],
            },
          },
          409,
        );
      }
      return ok(startResponse(body));
    }
    if (url.endsWith('/api/projects')) {
      return ok({ success: true, projects: PROJECTS });
    }
    return ok({ error: `No stub for ${url}` }, 404);
  }) as unknown as typeof fetch;
}

const onOpenChange = jest.fn();
const onImported = jest.fn();

function renderWizard(paths: string[] = [ORDERS, EVENTS, FUTURE, 'protos/common/types.proto']) {
  return render(
    <RepositoryBulkImportPanel
      repositoryId="11111111-1111-1111-1111-111111111111"
      repoUrl="https://github.com/acme/widgets"
      branch="main"
      paths={paths}
      open
      onOpenChange={onOpenChange}
      onImported={onImported}
    />,
  );
}

/** Mount and wait for the review table. */
async function openWizard() {
  const result = renderWizard();
  await screen.findByTestId('repository-batch-table');
  return result;
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });

/** A footer button — the dialog's own X is also named *Close*. */
const footerButton = (name: string) =>
  within(document.querySelector('.imp-wizard__foot') as HTMLElement).getByRole('button', { name });

/** The polls sleep 400 ms; a run needs one. */
const RUN_TIMEOUT = { timeout: 4000 };

beforeEach(() => {
  jest.clearAllMocks();
  submits = [];
  plans = 0;
  staleNext = false;
  installFetch();
});

describe('the review step', () => {
  it('has one row per importable item, stating its resolution and why', async () => {
    await openWizard();

    const orders = within(screen.getByTestId(`repository-batch-row-${ORDERS}`));
    expect(orders.getByTestId(`repository-batch-resolution-${ORDERS}`)).toHaveTextContent(
      'New version of Orders API',
    );
    expect(orders.getByText('v1.1.0')).toBeInTheDocument();
    expect(orders.getByText('imported from this path before')).toBeInTheDocument();

    const events = within(screen.getByTestId(`repository-batch-row-${EVENTS}`));
    expect(events.getByTestId(`repository-batch-resolution-${EVENTS}`)).toHaveTextContent(
      'New project shipping-events',
    );
    expect(events.getByText('+1 file')).toBeInTheDocument();

    // The unimportable item is not a row; it is excluded, with its reason.
    expect(screen.queryByTestId(`repository-batch-row-${FUTURE}`)).not.toBeInTheDocument();
    const excluded = screen.getByTestId('repository-batch-excluded');
    expect(excluded).toHaveTextContent('Excluded (2)');
    expect(excluded).toHaveTextContent('future/spec.yaml — no importer for future-format');
    expect(excluded).toHaveTextContent('protos/common/types.proto — compiled into another selected spec');
  });

  it('carries the header summary and the policy in force', async () => {
    await openWizard();

    expect(screen.getByTestId('repository-batch-summary')).toHaveTextContent(
      '2 items · 1 new version · 1 new project · 2 excluded',
    );
    expect(screen.getByTestId('repository-batch-policy')).toHaveTextContent(
      'Policy: append-when-matched (workspace default)',
    );
    expect(screen.getByRole('dialog', { name: 'Import 4 selected files' })).toBeInTheDocument();
  });

  it('a per-row override changes only that row', async () => {
    await openWizard();

    fireEvent.change(screen.getByLabelText(`Target for ${EVENTS}`), {
      target: { value: 'existing:p-shipping' },
    });

    const events = screen.getByTestId(`repository-batch-row-${EVENTS}`);
    expect(events).toHaveAttribute('data-overridden', 'true');
    expect(within(events).getByTestId(`repository-batch-resolution-${EVENTS}`)).toHaveTextContent(
      'New version of Shipping',
    );
    expect(within(events).getByText('chosen here')).toBeInTheDocument();

    const orders = screen.getByTestId(`repository-batch-row-${ORDERS}`);
    expect(orders).not.toHaveAttribute('data-overridden');
    expect(within(orders).getByTestId(`repository-batch-resolution-${ORDERS}`)).toHaveTextContent(
      'New version of Orders API',
    );
    // The header moves with it.
    expect(screen.getByTestId('repository-batch-summary')).toHaveTextContent(
      '2 items · 2 new versions · 2 excluded',
    );
  });

  it('offers the plan, the other shape and every other project as a row’s target', async () => {
    await openWizard();

    const options = within(screen.getByLabelText(`Target for ${ORDERS}`))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual([
      'Plan: New version of Orders API',
      'New project orders-api',
      'New version of Shipping',
    ]);
  });

  it('has no axe violations', async () => {
    await openWizard();
    fireEvent.change(screen.getByLabelText(`Target for ${ORDERS}`), { target: { value: 'new' } });
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('holds no interactive control inside a label', async () => {
    await openWizard();
    const nested = Array.from(document.querySelectorAll('label')).reduce(
      (total, label) =>
        total + label.querySelectorAll('button, select, textarea, a[href], input').length,
      0,
    );
    expect(nested).toBe(0);
  });
});

describe('verify, then apply', () => {
  it('keeps Apply unreachable until verify has run', async () => {
    await openWizard();
    fireEvent.click(button('Next: Verify →'));

    expect(screen.getByTestId('repository-bulk-import')).toHaveAttribute('data-step', 'verify');
    expect(screen.getByTestId('repository-batch-verify-note')).toHaveTextContent('nothing is written');
    expect(button('Run verify')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Next: Apply →' })).not.toBeInTheDocument();
  });

  it('verify is the dry run: the same overrides and fingerprint, nothing persisted', async () => {
    await openWizard();
    fireEvent.change(screen.getByLabelText(`Target for ${EVENTS}`), {
      target: { value: 'existing:p-shipping' },
    });
    fireEvent.click(button('Next: Verify →'));
    fireEvent.click(button('Run verify'));

    await waitFor(
      () => expect(screen.getByTestId('catalog-bulk-import-summary')).toHaveTextContent('Verify finished'),
      RUN_TIMEOUT,
    );

    expect(submits).toHaveLength(1);
    expect(submits[0]).toEqual({
      git: {
        repo_url: 'https://github.com/acme/widgets',
        ref: 'main',
        repository_id: '11111111-1111-1111-1111-111111111111',
        paths: [ORDERS, EVENTS, FUTURE, 'protos/common/types.proto'],
      },
      dry_run: true,
      overrides: [{ key: EVENTS, mode: 'existing', project_id: 'p-shipping' }],
      plan_fingerprint: 'bp1.reviewed-plan',
    });
    // Each row carries its validation outcome — and its decision, even the refused one's.
    expect(screen.getByTestId('catalog-bulk-import-summary')).toHaveTextContent(
      'Verify finished: 1 validated, 1 failed of 2.',
    );
    expect(screen.getByTestId(`catalog-bulk-import-destination-${ORDERS}`)).toHaveTextContent(
      'New version v1.1.0 of p-orders',
    );
    expect(screen.getByTestId(`catalog-bulk-import-item-${EVENTS}`)).toHaveTextContent(
      'below the tenant floor',
    );
    expect(button('Next: Apply →')).toBeEnabled();
  });

  it('Skip verify is the deliberate way past it', async () => {
    await openWizard();
    fireEvent.click(button('Next: Verify →'));
    fireEvent.click(screen.getByTestId('repository-batch-skip-verify'));

    expect(screen.getByTestId('repository-batch-verify-note')).toHaveTextContent('Verify was skipped');
    expect(button('Next: Apply →')).toBeEnabled();
    expect(submits).toHaveLength(0);
  });

  it('Apply sends exactly what Verify sent, and reports each item’s realized destination', async () => {
    await openWizard();
    fireEvent.change(screen.getByLabelText(`Target for ${EVENTS}`), {
      target: { value: 'existing:p-shipping' },
    });
    fireEvent.click(button('Next: Verify →'));
    fireEvent.click(button('Run verify'));
    await waitFor(() => expect(button('Next: Apply →')).toBeEnabled(), RUN_TIMEOUT);
    fireEvent.click(button('Next: Apply →'));

    expect(screen.getByTestId('repository-bulk-import')).toHaveAttribute('data-step', 'apply');
    fireEvent.click(button('Import 2 specs'));
    await waitFor(
      () =>
        expect(screen.getByTestId('catalog-bulk-import-summary')).toHaveTextContent(
          'Bulk import finished: 1 imported, 1 failed of 2.',
        ),
      RUN_TIMEOUT,
    );

    expect(submits).toHaveLength(2);
    const [verify, apply] = submits;
    expect(apply).toEqual({ ...verify, dry_run: false });

    // Partial failure is legible: the failed row says why, the other still landed.
    expect(screen.getByTestId(`catalog-bulk-import-destination-${ORDERS}`)).toHaveTextContent(
      'Appended v1.1.0 to orders-api',
    );
    expect(screen.getByTestId(`catalog-bulk-import-item-${EVENTS}`)).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId(`catalog-bulk-import-item-${EVENTS}`)).toHaveTextContent(
      'QUALITY_POLICY_BLOCKED',
    );
    expect(onImported).toHaveBeenCalledTimes(1);
    // Nothing forward of a finished batch: the dismiss verb is Close.
    expect(footerButton('Close')).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Import \d+ spec/ })).not.toBeInTheDocument();
  });

  it('a row’s own job opens the shared completion panel', async () => {
    await openWizard();
    fireEvent.click(button('Next: Verify →'));
    fireEvent.click(button('Run verify'));
    await waitFor(() => expect(button('Next: Apply →')).toBeEnabled(), RUN_TIMEOUT);

    fireEvent.click(screen.getByTestId(`catalog-bulk-import-toggle-${ORDERS}`));
    expect(screen.getByTestId('complete-panel')).toHaveTextContent('job-1');
  });

  it('refuses a stale plan with the drift named, and Re-plan starts over', async () => {
    await openWizard();
    fireEvent.click(button('Next: Verify →'));
    staleNext = true;
    fireEvent.click(button('Run verify'));

    await waitFor(() => expect(screen.getByTestId('catalog-bulk-import-stale')).toBeInTheDocument(), RUN_TIMEOUT);
    expect(screen.getByTestId('catalog-bulk-import-stale')).toHaveTextContent(
      'would create a different version now',
    );
    expect(screen.getByTestId('repository-batch-stale')).toBeInTheDocument();
    // Verify did not run, so Apply stays out of reach.
    expect(button('Run verify')).toBeEnabled();

    fireEvent.click(button('Re-plan'));
    await waitFor(() => expect(plans).toBe(2));
    await screen.findByTestId('repository-batch-table');
    expect(screen.getByTestId('repository-bulk-import')).toHaveAttribute('data-step', 'review');
  });
});

describe('closing', () => {
  it('hands control back through onOpenChange', async () => {
    await openWizard();
    fireEvent.click(button('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says why a batch cannot be read without a repository URL', async () => {
    render(
      <RepositoryBulkImportPanel
        repositoryId="11111111-1111-1111-1111-111111111111"
        repoUrl={null}
        branch="main"
        paths={[ORDERS, EVENTS]}
        open
        onOpenChange={onOpenChange}
      />,
    );
    expect(screen.getByTestId('repository-bulk-no-url')).toBeInTheDocument();
    expect(button('Next: Verify →')).toBeDisabled();
  });
});
