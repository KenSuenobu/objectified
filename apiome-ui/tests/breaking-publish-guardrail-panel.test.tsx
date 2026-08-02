/**
 * Publish dialog breaking-change guardrail panel (CTG-3.4, #4478).
 *
 * Covers the two things the dialog depends on: the panel is *silent* for a well-formed release
 * (so a compatible or properly-majored publish sees no friction), and it surfaces the verdict,
 * the recommended major, and the breaking-change list when the guardrail triggers.
 */

import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BreakingPublishGuardrailPanel } from '../src/app/components/ade/dashboard/BreakingPublishGuardrailPanel';
import {
  guardrailBlocksPublish,
  guardrailStatusLabel,
  type BreakingPublishGuardrail,
} from '../src/app/utils/breaking-publish-guardrail';

const PROJECT_ID = 'e8d8179b-66f4-4ad4-b462-f7d1c782f8cf';
const VERSION_ID = '71ff5cc0-df6c-48e7-aeb8-32d98df416d1';

/** A clean assessment: nothing for the dialog to say. */
const OK_GUARDRAIL: BreakingPublishGuardrail = {
  policy: 'warn',
  status: 'ok',
  triggered: false,
  blocked: false,
  breaking: false,
  majorBumped: false,
  fromVersion: '1.0.0',
  toVersion: '1.1.0',
  baselineRevisionId: 'base-1',
  breakingChanges: [],
  breakingCount: 0,
  truncated: false,
  counts: { breaking: 0, 'non-breaking': 2, 'docs-only': 0, unclassified: 0, total: 2 },
  maxSeverity: 'non-breaking',
  recommendedVersion: null,
  detail: null,
  message: 'No breaking-publish guardrail findings.',
};

/** Breaking without a major bump, under the block policy. */
const BLOCKED_GUARDRAIL: BreakingPublishGuardrail = {
  policy: 'block',
  status: 'blocked',
  triggered: true,
  blocked: true,
  breaking: true,
  majorBumped: false,
  fromVersion: '1.4.0',
  toVersion: '1.5.0',
  baselineRevisionId: 'base-1',
  breakingChanges: [
    {
      pointer: '/paths/~1owners',
      ruleId: 'path.removed',
      pathGroup: '/paths/~1owners',
      summary: 'Path removed',
    },
    {
      pointer: '/components/schemas/Pet/properties/id',
      ruleId: 'schema.property.removed',
      pathGroup: '/components/schemas/Pet',
      summary: 'Required property removed',
    },
  ],
  breakingCount: 2,
  truncated: false,
  counts: { breaking: 2, 'non-breaking': 0, 'docs-only': 0, unclassified: 0, total: 2 },
  maxSeverity: 'breaking',
  recommendedVersion: '2.0.0',
  detail: null,
  message:
    '2 breaking change(s) versus 1.4.0 published as 1.5.0 without a major-version bump. Publish as 2.0.0 instead.',
};

function mockGuardrailFetch(guardrail: BreakingPublishGuardrail) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ success: true, ...guardrail }),
    })
  ) as unknown as typeof fetch;
}

function mockFailingFetch(message: string) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: message }),
    })
  ) as unknown as typeof fetch;
}

/** Parent that recreates `onGuardrailChange` every render (matches publish dialog usage). */
function UnstableCallbackParent() {
  const [, setGuardrail] = useState<BreakingPublishGuardrail | null>(null);
  return (
    <BreakingPublishGuardrailPanel
      projectId={PROJECT_ID}
      versionId={VERSION_ID}
      onGuardrailChange={(guardrail) => setGuardrail(guardrail)}
    />
  );
}

describe('BreakingPublishGuardrailPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stays silent for a release with nothing to flag', async () => {
    mockGuardrailFetch(OK_GUARDRAIL);
    const onChange = jest.fn();
    render(
      <BreakingPublishGuardrailPanel
        projectId={PROJECT_ID}
        versionId={VERSION_ID}
        onGuardrailChange={onChange}
      />
    );

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(screen.queryByTestId('breaking-publish-guardrail-panel')).toBeNull();
    expect(screen.queryByText('Checking breaking changes…')).toBeNull();
  });

  it('surfaces the verdict, status badge, and recommended major when blocked', async () => {
    mockGuardrailFetch(BLOCKED_GUARDRAIL);
    render(<BreakingPublishGuardrailPanel projectId={PROJECT_ID} versionId={VERSION_ID} />);

    expect(await screen.findByTestId('breaking-publish-guardrail-panel')).toBeInTheDocument();
    expect(screen.getByTestId('breaking-publish-guardrail-status')).toHaveTextContent('Blocked');
    expect(screen.getByText(/without a major-version bump/)).toBeInTheDocument();
    expect(screen.getByText(/Publishing is blocked by your tenant policy/)).toBeInTheDocument();
    expect(screen.getByTestId('breaking-publish-recommended-version')).toHaveTextContent('2.0.0');
  });

  it('lists the breaking changes only once expanded', async () => {
    mockGuardrailFetch(BLOCKED_GUARDRAIL);
    render(<BreakingPublishGuardrailPanel projectId={PROJECT_ID} versionId={VERSION_ID} />);

    const toggle = await screen.findByTestId('breaking-publish-changes-toggle');
    expect(toggle).toHaveTextContent('Breaking changes (2)');
    expect(screen.queryAllByTestId('breaking-publish-change')).toHaveLength(0);

    fireEvent.click(toggle);

    expect(screen.getAllByTestId('breaking-publish-change')).toHaveLength(2);
    expect(screen.getByText('path.removed')).toBeInTheDocument();
    expect(screen.getByText('Required property removed')).toBeInTheDocument();
    expect(screen.queryByTestId('breaking-publish-changes-truncated')).toBeNull();
  });

  it('says how many changes were omitted when the list is truncated', async () => {
    mockGuardrailFetch({ ...BLOCKED_GUARDRAIL, breakingCount: 57, truncated: true });
    render(<BreakingPublishGuardrailPanel projectId={PROJECT_ID} versionId={VERSION_ID} />);

    fireEvent.click(await screen.findByTestId('breaking-publish-changes-toggle'));

    expect(screen.getByTestId('breaking-publish-changes-truncated')).toHaveTextContent(
      'Showing 2 of 57'
    );
  });

  it('warns rather than blocking when the versioning scheme is not semver', async () => {
    mockGuardrailFetch({
      ...BLOCKED_GUARDRAIL,
      policy: 'block',
      status: 'warning',
      blocked: false,
      majorBumped: null,
      detail: 'version-labels-not-semver',
      recommendedVersion: null,
      message:
        '2 breaking change(s) versus spring-2026 published as summer-2026, and the version labels are not semver so a major bump cannot be confirmed. Publish under a major version to signal the break.',
    });
    render(<BreakingPublishGuardrailPanel projectId={PROJECT_ID} versionId={VERSION_ID} />);

    expect(await screen.findByTestId('breaking-publish-guardrail-status')).toHaveTextContent(
      'Warning'
    );
    expect(screen.queryByText(/Publishing is blocked by your tenant policy/)).toBeNull();
    expect(screen.queryByTestId('breaking-publish-recommended-version')).toBeNull();
  });

  it('reports a load failure without claiming the publish is safe', async () => {
    mockFailingFetch('REST API unreachable');
    const onChange = jest.fn();
    render(
      <BreakingPublishGuardrailPanel
        projectId={PROJECT_ID}
        versionId={VERSION_ID}
        onGuardrailChange={onChange}
      />
    );

    expect(await screen.findByTestId('breaking-publish-guardrail-error')).toHaveTextContent(
      'REST API unreachable'
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null, 'REST API unreachable'));
  });

  it('does not fetch while the dialog is closed', () => {
    mockGuardrailFetch(BLOCKED_GUARDRAIL);
    render(
      <BreakingPublishGuardrailPanel
        projectId={PROJECT_ID}
        versionId={VERSION_ID}
        enabled={false}
      />
    );

    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('breaking-publish-guardrail-panel')).toBeNull();
  });

  it('finishes loading when onGuardrailChange is unstable across parent re-renders', async () => {
    mockGuardrailFetch(BLOCKED_GUARDRAIL);
    render(<UnstableCallbackParent />);

    expect(await screen.findByTestId('breaking-publish-guardrail-panel')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  });

  it('requests the version-scoped proxy route', async () => {
    mockGuardrailFetch(BLOCKED_GUARDRAIL);
    render(<BreakingPublishGuardrailPanel projectId={PROJECT_ID} versionId={VERSION_ID} />);

    await screen.findByTestId('breaking-publish-guardrail-panel');
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/projects/${PROJECT_ID}/versions/${VERSION_ID}/breaking-publish-guardrail`,
      expect.objectContaining({ method: 'GET' })
    );
  });
});

describe('guardrailBlocksPublish', () => {
  it('blocks only a blocked assessment that is not being force-published', () => {
    expect(guardrailBlocksPublish(BLOCKED_GUARDRAIL, false)).toBe(true);
    expect(guardrailBlocksPublish(BLOCKED_GUARDRAIL, true)).toBe(false);
    expect(guardrailBlocksPublish(OK_GUARDRAIL, false)).toBe(false);
    expect(guardrailBlocksPublish(null, false)).toBe(false);
  });

  it('never blocks on a warning — warn is advisory by definition', () => {
    expect(
      guardrailBlocksPublish(
        { ...BLOCKED_GUARDRAIL, status: 'warning', blocked: false, policy: 'warn' },
        false
      )
    ).toBe(false);
  });

  it('never blocks when the assessment could not be made', () => {
    expect(
      guardrailBlocksPublish(
        {
          ...OK_GUARDRAIL,
          status: 'unavailable',
          triggered: false,
          blocked: false,
          detail: 'db down',
        },
        false
      )
    ).toBe(false);
  });
});

describe('guardrailStatusLabel', () => {
  it('labels every documented status', () => {
    expect(guardrailStatusLabel('blocked')).toBe('Blocked');
    expect(guardrailStatusLabel('warning')).toBe('Warning');
    expect(guardrailStatusLabel('ok')).toBe('Compatible release');
    expect(guardrailStatusLabel('no-baseline')).toBe('Initial publication');
    expect(guardrailStatusLabel('disabled')).toBe('Guardrail off');
    expect(guardrailStatusLabel('unavailable')).toBe('Not checked');
  });

  it('falls back for an unknown status rather than rendering blank', () => {
    expect(guardrailStatusLabel('something-new')).toBe('Not checked');
  });
});
