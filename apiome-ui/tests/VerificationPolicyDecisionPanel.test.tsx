/**
 * Decision panel renders the API payload only — ECA-3.1 (#4734).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import VerificationPolicyDecisionPanel from '../src/app/components/ade/dashboard/VerificationPolicyDecisionPanel';

const evaluateMock = jest.fn();

jest.mock('../src/app/ade/dashboard/style-guides/verification-policy-api', () => ({
  verificationPolicyApi: (...args: unknown[]) => evaluateMock(...args),
}));

describe('VerificationPolicyDecisionPanel', () => {
  beforeEach(() => {
    evaluateMock.mockReset();
  });

  it('renders evaluationId and evidenceRunIds from the API decision', async () => {
    evaluateMock.mockResolvedValue({
      passed: true,
      enforcement: 'advisory',
      policyVersionId: 'pppppppp-pppp-pppp-pppp-pppppppppppp',
      policyContentFingerprint: 'fp',
      evaluationId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      evidenceRunIds: ['dddddddd-dddd-dddd-dddd-dddddddddddd'],
      gateResults: [
        { gate: 'suite_digest', passed: true, detail: {} },
        { gate: 'evidence_age', passed: true, detail: {} },
        { gate: 'breaking_change', passed: true, detail: {} },
      ],
      warnings: [],
      purpose: 'publish',
      skipped: false,
    });

    const onDecisionChange = jest.fn();
    render(
      <VerificationPolicyDecisionPanel
        projectId="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        versionId="cccccccc-cccc-cccc-cccc-cccccccccccc"
        enabled
        onDecisionChange={onDecisionChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/)).toBeTruthy();
    });
    expect(screen.getByText(/dddddddd-dddd-dddd-dddd-dddddddddddd/)).toBeTruthy();
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(onDecisionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        evidenceRunIds: ['dddddddd-dddd-dddd-dddd-dddddddddddd'],
      }),
    );
    expect(evaluateMock).toHaveBeenCalledWith(
      'evaluate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows failed state from the API without inventing a pass', async () => {
    evaluateMock.mockResolvedValue({
      passed: false,
      enforcement: 'block',
      policyVersionId: null,
      policyContentFingerprint: 'fp',
      evaluationId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      evidenceRunIds: [],
      gateResults: [{ gate: 'suite_digest', passed: false, detail: {} }],
      warnings: [],
      purpose: 'publish',
      skipped: false,
    });

    render(
      <VerificationPolicyDecisionPanel
        projectId="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        versionId="cccccccc-cccc-cccc-cccc-cccccccccccc"
        enabled
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Failed')).toBeTruthy();
    });
    expect(screen.getByText(/enforcement is block/i)).toBeTruthy();
  });
});
