/**
 * Export delivery gate panel (IXH-2.5, #5100).
 *
 * Covers what the Studio depends on: the panel is *silent* for a clean delivery (an allow has
 * nothing to say), it renders every named reason with the dimension it came from, a blocked
 * delivery shows the override path (or states that there is none), and a delivered artifact
 * names its attestation.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DeliveryGatePanel } from '../src/app/components/ade/dashboard/export/DeliveryGatePanel';
import type { DeliveryGateReport } from '../src/app/components/ade/dashboard/export/exportJob';

/** A delivery the tenant's export policy refused, with its override path. */
const BLOCKED: DeliveryGateReport = {
  decision: 'block',
  blocks_delivery: true,
  warns: false,
  headline: 'Delivery blocked',
  message: "The 'openapi-3.1' delivery was blocked before any artifact was produced.",
  reasons: [
    {
      code: 'DELIVERY_FIDELITY_BELOW_FLOOR',
      dimension: 'fidelity',
      severity: 'blocking',
      message: 'Only 42% of the source survives, below the tenant 80% fidelity floor.',
    },
    {
      code: 'DELIVERY_SOURCE_ERRORS_OPEN',
      dimension: 'lint',
      severity: 'warning',
      message: 'The source revision has 3 open error-severity lint findings.',
    },
  ],
  target: 'openapi-3.1',
  source_grade: 'D',
  preserved_percent: 42,
  override: {
    available: true,
    endpoint: '/v1/tenants/acme/governance/quality-waivers',
    scope: 'export',
    subject_key: 'rev-uuid-1',
    format_key: 'openapi',
    roles: ['owner', 'admin'],
    instructions: 'Record an export waiver for this revision with a stated reason.',
  },
};

/** A delivered artifact carrying one advisory reason and a signed attestation. */
const WARNED: DeliveryGateReport = {
  decision: 'allow_with_warning',
  blocks_delivery: false,
  warns: true,
  headline: 'Delivered with warnings',
  message: "The 'openapi-3.1' artifact was delivered with 1 advisory reason.",
  reasons: [
    {
      code: 'DELIVERY_VALIDATION_SKIPPED',
      dimension: 'validation',
      severity: 'warning',
      message: 'The validator toolchain is unavailable in this runtime.',
    },
  ],
  target: 'openapi-3.1',
  override: { available: false, instructions: 'No override is needed.' },
  attestation: {
    predicate_type: 'https://apiome.dev/attestations/export-delivery/v1',
    signed: true,
    key_id: 'apiome-lint-hmac-v1',
    generated_at: '2026-08-01T12:00:00+00:00',
    envelope: { payloadType: 'application/vnd.in-toto+json', payload: 'e30=', signatures: [] },
  },
};

describe('DeliveryGatePanel', () => {
  it('says nothing for a clean allow', () => {
    const { container } = render(
      <DeliveryGatePanel delivery={{ ...WARNED, decision: 'allow', warns: false, reasons: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders every named reason with its dimension and severity', () => {
    render(<DeliveryGatePanel delivery={BLOCKED} />);

    expect(screen.getByTestId('delivery-gate-panel')).toHaveAttribute('data-decision', 'block');
    expect(screen.getByTestId('delivery-gate-message')).toHaveTextContent('blocked before any artifact');

    const reasons = screen.getAllByTestId('delivery-gate-reason');
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toHaveAttribute('data-reason-code', 'DELIVERY_FIDELITY_BELOW_FLOOR');
    expect(reasons[0]).toHaveAttribute('data-severity', 'blocking');
    expect(reasons[0]).toHaveTextContent('Conversion fidelity');
    expect(reasons[1]).toHaveAttribute('data-severity', 'warning');
    expect(reasons[1]).toHaveTextContent('Source quality');
  });

  it('shows the override path a blocked delivery may be unblocked through', () => {
    render(<DeliveryGatePanel delivery={BLOCKED} />);

    const override = screen.getByTestId('delivery-gate-override');
    expect(override).toHaveAttribute('data-available', 'true');
    expect(screen.getByTestId('delivery-gate-override-endpoint')).toHaveTextContent(
      'POST /v1/tenants/acme/governance/quality-waivers',
    );
    expect(override).toHaveTextContent('rev-uuid-1');
    expect(override).toHaveTextContent('owner, admin');
  });

  it('states plainly when a block has no override', () => {
    render(
      <DeliveryGatePanel
        delivery={{
          ...BLOCKED,
          override: {
            available: false,
            instructions: 'This artifact is not valid in its target format, so it cannot be waived.',
          },
        }}
      />,
    );

    const override = screen.getByTestId('delivery-gate-override');
    expect(override).toHaveAttribute('data-available', 'false');
    expect(override).toHaveTextContent('cannot be waived');
    expect(screen.queryByTestId('delivery-gate-override-endpoint')).not.toBeInTheDocument();
  });

  it('names the attestation a delivered artifact carries', () => {
    render(<DeliveryGatePanel delivery={WARNED} />);

    expect(screen.getByTestId('delivery-gate-panel')).toHaveAttribute(
      'data-decision',
      'allow_with_warning',
    );
    const attestation = screen.getByTestId('delivery-gate-attestation');
    expect(attestation).toHaveAttribute('data-signed', 'true');
    expect(attestation).toHaveTextContent('signed delivery attestation');
    // A warning delivery is not a block, so no override block is drawn.
    expect(screen.queryByTestId('delivery-gate-override')).not.toBeInTheDocument();
  });

  it('marks an unsigned attestation as such', () => {
    render(
      <DeliveryGatePanel
        delivery={{
          ...WARNED,
          attestation: { ...WARNED.attestation!, signed: false, key_id: null },
        }}
      />,
    );

    const attestation = screen.getByTestId('delivery-gate-attestation');
    expect(attestation).toHaveAttribute('data-signed', 'false');
    expect(attestation).toHaveTextContent('unsigned delivery attestation');
  });
});
