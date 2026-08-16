/**
 * Render/interaction tests for the tenant License & Plan panel (OLO-5.5, #4215).
 *
 * Covers the acceptance criteria: live plan card / seat meter / feature list
 * from the `/api/tenants/license` proxy, the upgrade CTA stub, the
 * non-current-tenant helper, graceful rendering of the OLO-5.3
 * seats-exhausted state, and error handling (friendly copy for stable codes,
 * raw message otherwise).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import TenantLicensePanel, {
  formatQuotaLimit,
  seatMeterAppearance,
} from '../src/app/ade/dashboard/tenants/TenantLicensePanel';
import type { TenantLicenseResponse } from '../src/app/ade/dashboard/tenants/licenseApi';
import { LICENSE_SEATS_EXHAUSTED_CODE } from '../src/app/ade/dashboard/tenants/licenseErrors';

const toastInfo = jest.fn();
jest.mock('sonner', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfo(...args),
    success: jest.fn(),
    error: jest.fn(),
  },
}));

const LICENSE: TenantLicenseResponse = {
  plan: { name: 'Team', type: 'paid' },
  seats: { used: 3, max: 10 },
  quotas: { max_projects: 10, max_versions: 50, max_ai_requests: 1000 },
  features: [
    {
      name: 'designer',
      label: 'API Designer',
      description: 'Visual OpenAPI editing.',
      is_preview: false,
      enabled: true,
      source: 'license',
    },
    {
      name: 'mcp-governance',
      label: 'MCP Governance',
      description: null,
      is_preview: true,
      enabled: false,
      source: 'tenant-override',
    },
  ],
};

/** Stub the license proxy with a success envelope. */
function mockFetchSuccess(data: TenantLicenseResponse) {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => ({ success: true, data }),
  }) as unknown as typeof fetch;
}

/** Stub the license proxy with a failure envelope. */
function mockFetchFailure(error: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => ({ success: false, error }),
  }) as unknown as typeof fetch;
}

/** Render the panel and expand it (data loads on expand). */
function renderExpanded(props: Partial<React.ComponentProps<typeof TenantLicensePanel>> = {}) {
  const utils = render(<TenantLicensePanel isCurrentTenant tenantName="Acme" {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /License & Plan/i }));
  return utils;
}

afterEach(() => {
  jest.restoreAllMocks();
  toastInfo.mockClear();
});

describe('TenantLicensePanel', () => {
  it('is collapsed by default and does not fetch until expanded', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(<TenantLicensePanel isCurrentTenant tenantName="Acme" />);
    expect(screen.queryByText(/Current plan/i)).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the switch-tenant helper instead of fetching for a non-current tenant', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(<TenantLicensePanel isCurrentTenant={false} tenantName="Acme" />);
    fireEvent.click(screen.getByRole('button', { name: /License & Plan/i }));
    expect(screen.getByText(/Select Acme as your current tenant/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders the live plan card, seat meter, and feature list', async () => {
    mockFetchSuccess(LICENSE);
    renderExpanded();

    expect(await screen.findByText('Team')).toBeInTheDocument();
    expect(screen.getByText('paid')).toBeInTheDocument();
    expect(screen.getByText('3 of 10 used')).toBeInTheDocument();
    const meter = screen.getByRole('meter', { name: /Member seats used/i });
    expect(meter).toHaveAttribute('aria-valuenow', '3');
    expect(meter).toHaveAttribute('aria-valuemax', '10');

    // Feature rows: label, slug, badges.
    expect(screen.getByText('API Designer')).toBeInTheDocument();
    expect(screen.getByText('designer')).toBeInTheDocument();
    expect(screen.getByText('Visual OpenAPI editing.')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('MCP Governance')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('Included in plan')).toBeInTheDocument();
    expect(screen.getByText('Tenant override')).toBeInTheDocument();

    expect(global.fetch).toHaveBeenCalledWith('/api/tenants/license', { cache: 'no-store' });
  });

  it('shows the Free-tier fallback when the tenant has no plan attached', async () => {
    mockFetchSuccess({ ...LICENSE, plan: null });
    renderExpanded();
    expect(
      await screen.findByText(/No plan attached — Free-tier limits apply/i),
    ).toBeInTheDocument();
  });

  it('presents the upgrade CTA stub and explains billing is not live yet', async () => {
    mockFetchSuccess(LICENSE);
    renderExpanded();

    const cta = await screen.findByRole('button', { name: /Upgrade plan/i });
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    fireEvent.click(cta);
    expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/coming soon/i));
  });

  it('renders the seats-exhausted guidance when every seat is used', async () => {
    mockFetchSuccess({ ...LICENSE, seats: { used: 10, max: 10 } });
    renderExpanded();

    expect(await screen.findByText('10 of 10 used')).toBeInTheDocument();
    expect(screen.getByText(/All member seats included in this tenant's license/i)).toBeInTheDocument();
  });

  it('renders the stored plan quota limits (#64)', async () => {
    mockFetchSuccess(LICENSE);
    renderExpanded();

    expect(await screen.findByText('Plan limits')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('Published versions per project')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('AI assistant requests')).toBeInTheDocument();
    expect(screen.getByText('1000')).toBeInTheDocument();
  });

  it('shows Unlimited for negative quotas and "Not included" for a zero AI cap', async () => {
    mockFetchSuccess({
      ...LICENSE,
      quotas: { max_projects: -1, max_versions: -1, max_ai_requests: 0 },
    });
    renderExpanded();

    await screen.findByText('Plan limits');
    // Both unlimited quotas render the same copy.
    expect(screen.getAllByText('Unlimited')).toHaveLength(2);
    expect(screen.getByText('Not included')).toBeInTheDocument();
  });

  it('renders an empty-features note instead of an empty list', async () => {
    mockFetchSuccess({ ...LICENSE, features: [] });
    renderExpanded();
    expect(
      await screen.findByText(/No features are configured for this tenant/i),
    ).toBeInTheDocument();
  });

  it('maps a structured OLO-5.3 error payload to friendly guidance', async () => {
    mockFetchFailure({ code: LICENSE_SEATS_EXHAUSTED_CODE, message: 'raw api text' });
    renderExpanded();

    await waitFor(() =>
      expect(
        screen.getByText(/All member seats included in this tenant's license/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('raw api text')).not.toBeInTheDocument();
  });

  it('shows the raw proxy error for non-license failures', async () => {
    mockFetchFailure('REST API unreachable');
    renderExpanded();
    expect(await screen.findByText('REST API unreachable')).toBeInTheDocument();
  });
});

// The palette moved to the shared quota bands in HIVE-2.6 (#5285); see `license-seats.test.ts`.
describe('seatMeterAppearance', () => {
  it('is quiet below the warning band', () => {
    expect(seatMeterAppearance(3, 10)).toEqual(
      expect.objectContaining({ percent: 30, tone: 'accent' }),
    );
  });

  it('turns warn at 80% and danger when full', () => {
    expect(seatMeterAppearance(8, 10).tone).toBe('warn');
    expect(seatMeterAppearance(10, 10).tone).toBe('danger');
  });

  it('clamps over-limit usage to 100% and treats a zero max as full', () => {
    expect(seatMeterAppearance(12, 10).percent).toBe(100);
    expect(seatMeterAppearance(0, 0)).toEqual(
      expect.objectContaining({ percent: 100, tone: 'danger' }),
    );
  });
});

describe('formatQuotaLimit', () => {
  it('renders a positive limit as its number', () => {
    expect(formatQuotaLimit(10)).toBe('10');
  });

  it('renders any negative value as Unlimited', () => {
    expect(formatQuotaLimit(-1)).toBe('Unlimited');
    expect(formatQuotaLimit(-42)).toBe('Unlimited');
  });

  it('renders zero with the default label, or a custom zero label', () => {
    expect(formatQuotaLimit(0)).toBe('0');
    expect(formatQuotaLimit(0, 'Not included')).toBe('Not included');
  });
});
