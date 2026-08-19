/**
 * SuiteRegressionBadge component tests (IXH-5.7, #5119).
 *
 * The badge is a warning surface for the catalog and version detail pages: visible exactly
 * when at least one of the artifact's suites has a newest run flagging a regression, and
 * silent (not an error state) otherwise — including on fetch failure.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { SuiteRegressionBadge } from '../src/app/components/ade/dashboard/SuiteRegressionBadge';

const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

function suiteWith(regression: boolean, id = 's1') {
  return {
    id,
    name: `suite ${id}`,
    ref: 'catalog/legacy-soap',
    ref_kind: 'catalog',
    ref_artifact: 'legacy-soap',
    suite_version: 1,
    payload_count: 1,
    latest_run: {
      id: `run-${id}`,
      suite_version: 1,
      requested_ref: 'catalog/legacy-soap/latest',
      trigger: 'manual',
      status: 'completed',
      total: 1,
      passed: regression ? 0 : 1,
      failed: regression ? 1 : 0,
      errored: 0,
      regression,
    },
  };
}

function mockList(body: unknown, ok = true) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('/api/schemas/suites?ref=catalog%2Flegacy-soap');
    return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('SuiteRegressionBadge', () => {
  it('renders the chip when a suite regressed, counting the affected suites', async () => {
    mockList({ success: true, items: [suiteWith(true, 'a'), suiteWith(true, 'b'), suiteWith(false, 'c')] });
    render(<SuiteRegressionBadge surface="catalog" artifact="legacy-soap" />);

    const badge = await screen.findByTestId('suite-regression-badge');
    expect(badge).toHaveTextContent('Suite regression ×2');
  });

  it('drops the count suffix for a single regressed suite', async () => {
    mockList({ success: true, items: [suiteWith(true)] });
    render(<SuiteRegressionBadge surface="catalog" artifact="legacy-soap" />);

    expect(await screen.findByTestId('suite-regression-badge')).toHaveTextContent(
      /Suite regression$/
    );
  });

  it('renders nothing when every suite is calm', async () => {
    const fetchMock = mockList({ success: true, items: [suiteWith(false)] });
    const { container } = render(<SuiteRegressionBadge surface="catalog" artifact="legacy-soap" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a fetch failure — absence is silence, not an error state', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('network down');
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(<SuiteRegressionBadge surface="catalog" artifact="legacy-soap" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('has no axe violations when visible', async () => {
    mockList({ success: true, items: [suiteWith(true)] });
    const { container } = render(<SuiteRegressionBadge surface="catalog" artifact="legacy-soap" />);
    await screen.findByTestId('suite-regression-badge');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  /**
   * HIVE-7.2 (#5319): `sources/catalog-item.html` makes the chip a link to the verdict diff
   * its tooltip already names. Given a handler the chip *is* the button — the badge's classes
   * on a `<button>`, so the whole pill is the hit area and no interactive element is nested
   * inside another one.
   */
  describe('as a link to the verdict diff', () => {
    it('stays an inert chip when no handler is given', async () => {
      mockList({ success: true, items: [suiteWith(true)] });
      render(<SuiteRegressionBadge surface="catalog" artifact="legacy-soap" />);
      const chip = await screen.findByTestId('suite-regression-badge');
      expect(chip.tagName).toBe('DIV');
      expect(chip.querySelector('button')).toBeNull();
    });

    it('becomes the button itself when one is', async () => {
      mockList({ success: true, items: [suiteWith(true)] });
      const onSelect = jest.fn();
      render(
        <SuiteRegressionBadge surface="catalog" artifact="legacy-soap" onSelect={onSelect} />,
      );
      const chip = await screen.findByTestId('suite-regression-badge');
      expect(chip.tagName).toBe('BUTTON');
      // No nested interactive element — the pill and the control are one node.
      expect(chip.querySelector('button, a')).toBeNull();
      fireEvent.click(chip);
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('is axe-clean as a button too', async () => {
      mockList({ success: true, items: [suiteWith(true)] });
      const { container } = render(
        <SuiteRegressionBadge surface="catalog" artifact="legacy-soap" onSelect={() => {}} />,
      );
      await screen.findByTestId('suite-regression-badge');
      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });
});
