/**
 * RoundtripComparisonPanel — the Review step's round-trip evidence panel (IXH-4.4, #5112).
 *
 * Pins the ticket's UI acceptance criteria:
 *
 *  - the action is explicit: an unrun panel renders a "Run round-trip check" button and
 *    triggers nothing on its own;
 *  - differences render grouped — expected (each paired with the fidelity finding that
 *    explains it) versus unexplained/over-claimed, flagged as a fidelity bug;
 *  - unexplained differences offer the one-click issue-report link, carrying reproduction
 *    coordinates and naming any withheld credential-shaped option keys;
 *  - a target with no import adapter shows the skip explanation instead of a result;
 *  - a transport failure degrades to a retryable notice and never gates the export;
 *  - the panel has no axe violations in its key states.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe, toHaveNoViolations } from 'jest-axe';
import { jest } from '@jest/globals';

import { RoundtripComparisonPanel } from '../src/app/components/ade/dashboard/export/RoundtripComparisonPanel';
import type { ExportRoundtripResponse } from '../src/app/components/ade/dashboard/export/exportRoundtrip';

expect.extend(toHaveNoViolations);

function response(overrides: Partial<ExportRoundtripResponse> = {}): ExportRoundtripResponse {
  return {
    artifact: 'proj-1',
    version: '1.0.0',
    version_record_id: 'rev-1',
    version_label: '1.0.0',
    target: 'openapi-3.1',
    emit_key: 'openapi',
    adapter_key: 'openapi',
    status: 'pass',
    reason: null,
    diff_count: 0,
    matched_count: 0,
    matched: [],
    unexplained: [],
    overclaims: [],
    loss_drop: 0,
    loss_approx: 0,
    loss_synth: 0,
    loss_ok: 4,
    source_fingerprint: 'aaaa1111bbbb2222',
    reimported_fingerprint: 'aaaa1111bbbb2222',
    emitter_version: '1.0',
    apiome_version: '1.107.0',
    registry_version: '1',
    ...overrides,
  };
}

const baseProps = {
  result: null,
  running: false,
  hasRun: false,
  error: null,
  fromCache: false,
  onRun: jest.fn(),
  targetLabel: 'OpenAPI 3.1',
};

afterEach(() => jest.clearAllMocks());

describe('RoundtripComparisonPanel', () => {
  it('offers an explicit action when unrun, and triggers nothing on its own', () => {
    const onRun = jest.fn();
    render(<RoundtripComparisonPanel {...baseProps} onRun={onRun} />);
    expect(screen.getByTestId('roundtrip-run')).toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('roundtrip-run'));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('states what is happening while the loop runs', () => {
    render(<RoundtripComparisonPanel {...baseProps} running />);
    expect(screen.getByTestId('roundtrip-running')).toHaveTextContent(/re-importing/i);
  });

  it('degrades a transport failure to a retryable notice', () => {
    const onRun = jest.fn();
    render(
      <RoundtripComparisonPanel {...baseProps} hasRun error="upstream 502" onRun={onRun} />,
    );
    expect(screen.getByTestId('roundtrip-error')).toHaveTextContent('upstream 502');
    expect(screen.getByTestId('roundtrip-error')).toHaveTextContent(/unaffected/);
    fireEvent.click(screen.getByTestId('roundtrip-retry'));
    expect(onRun).toHaveBeenCalledWith(true);
  });

  it('presents a verified round trip with its summary and provenance', () => {
    render(<RoundtripComparisonPanel {...baseProps} hasRun result={response()} />);
    expect(screen.getByTestId('roundtrip-status-pass')).toHaveTextContent('Round trip verified');
    expect(screen.getByTestId('roundtrip-summary')).toHaveTextContent(/identical to the source/);
    expect(screen.getByTestId('roundtrip-provenance')).toHaveTextContent('source aaaa1111bbbb');
    expect(screen.queryByTestId('roundtrip-report-issue')).not.toBeInTheDocument();
  });

  it('labels a cached result as restored and offers a re-run', () => {
    const onRun = jest.fn();
    render(
      <RoundtripComparisonPanel {...baseProps} hasRun fromCache result={response()} onRun={onRun} />,
    );
    expect(screen.getByTestId('roundtrip-from-cache')).toHaveTextContent(/restored/);
    fireEvent.click(screen.getByTestId('roundtrip-rerun'));
    expect(onRun).toHaveBeenCalledWith(true);
  });

  it('groups differences into expected (paired with findings) and unexplained', () => {
    const result = response({
      status: 'fail',
      diff_count: 2,
      matched_count: 1,
      matched: [
        {
          entry: { entity: 'type', key: 'Org', change: 'removed' },
          finding: {
            construct: 'Org',
            kind: 'drop',
            severity: 'warn',
            message: 'target cannot carry Org',
            target_mapping: null,
          },
        },
      ],
      unexplained: [{ entity: 'type', key: 'User', change: 'removed' }],
      overclaims: [
        {
          construct: 'Status',
          kind: 'ok',
          severity: 'info',
          message: 'preserved',
          target_mapping: null,
        },
      ],
      reimported_fingerprint: 'cccc3333dddd4444',
    });
    render(<RoundtripComparisonPanel {...baseProps} hasRun result={result} />);

    const explained = screen.getByTestId('roundtrip-explained');
    expect(explained).toHaveTextContent('Expected differences · explained by the fidelity report (1)');
    expect(explained).toHaveTextContent('Org');
    expect(explained).toHaveTextContent('target cannot carry Org');

    const unexplained = screen.getByTestId('roundtrip-unexplained');
    expect(unexplained).toHaveTextContent('Unexplained differences (2)');
    expect(unexplained).toHaveTextContent('User');
    expect(screen.getByTestId('roundtrip-overclaim')).toHaveTextContent('Status');

    expect(screen.getByTestId('roundtrip-status-fail')).toHaveTextContent(/fidelity bug/i);
  });

  it('offers the one-click issue report carrying reproduction coordinates, secrets stripped', () => {
    const result = response({
      status: 'fail',
      diff_count: 1,
      unexplained: [{ entity: 'type', key: 'User', change: 'removed' }],
    });
    render(
      <RoundtripComparisonPanel
        {...baseProps}
        hasRun
        result={result}
        options={{ package: 'com.example', api_token: 'hunter2' }}
      />,
    );
    const link = screen.getByTestId('roundtrip-report-issue');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('https://github.com/apiome/apiome/issues/new?')).toBe(true);
    expect(href).toContain(encodeURIComponent('rev-1'));
    expect(href).toContain(encodeURIComponent('com.example'));
    expect(href).not.toContain(encodeURIComponent('hunter2'));
    expect(screen.getByTestId('roundtrip-unexplained')).toHaveTextContent(
      'credential-shaped options withheld: api_token',
    );
  });

  it('shows the skip explanation when no import adapter exists, with no issue link', () => {
    const result = response({
      status: 'unsupported',
      adapter_key: null,
      reimported_fingerprint: null,
      reason: "No import adapter can re-import emit format 'sample-noop' (emit key 'sample').",
    });
    render(<RoundtripComparisonPanel {...baseProps} hasRun result={result} />);
    expect(screen.getByTestId('roundtrip-status-unsupported')).toHaveTextContent(
      'Comparison skipped',
    );
    expect(screen.getByTestId('roundtrip-status-unsupported')).toHaveTextContent(
      /No import adapter can re-import/,
    );
    expect(screen.queryByTestId('roundtrip-report-issue')).not.toBeInTheDocument();
  });

  it('has no axe violations across its key states', async () => {
    const unrun = render(<RoundtripComparisonPanel {...baseProps} />);
    expect(await axe(unrun.container)).toHaveNoViolations();
    unrun.unmount();

    const failed = render(
      <RoundtripComparisonPanel
        {...baseProps}
        hasRun
        result={response({
          status: 'fail',
          diff_count: 1,
          unexplained: [{ entity: 'type', key: 'User', change: 'removed' }],
        })}
      />,
    );
    expect(await axe(failed.container)).toHaveNoViolations();
  });
});
