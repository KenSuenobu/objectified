/**
 * Export Studio route — deep-link entry (MFX-41.1, #4348; MFX-41.4, #4351).
 *
 * The route is the boundary where an untrusted URL becomes Studio state. These tests cover that
 * hand-off: a shared link arrives as validated props (source, target, compact options, resumable
 * step), anything unverifiable arrives as a notice instead, credentials never arrive at all, and a
 * link with no source still lands somewhere useful.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

const mockSearchParams = jest.fn();
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams(),
}));

jest.mock('@lib/auth/session-client', () => ({
  AuthSessionProvider: ({ children }: { children: unknown }) => children,
  signOut: jest.fn(),
  useAuthSession: () => ({ data: { user: { id: 'u-1' } }, status: 'authenticated' }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

/** Capture the props the route hands the Studio, instead of mounting the whole workspace. */
const studioProps: Record<string, unknown>[] = [];
jest.mock('../src/app/components/ade/dashboard/export/ExportStudio', () => ({
  __esModule: true,
  ExportStudio: (props: Record<string, unknown>) => {
    studioProps.push(props);
    return <div data-testid="export-studio-stub" />;
  },
}));

import ExportStudioPage from '../src/app/ade/dashboard/export/studio/page';
import { encodeStudioOptions } from '../src/app/components/ade/dashboard/export/exportStudioUrlState';

/** Render the route for one query string and return the props the Studio received. */
function renderRoute(query: string): Record<string, unknown> {
  studioProps.length = 0;
  mockSearchParams.mockReturnValue(new URLSearchParams(query));
  render(<ExportStudioPage />);
  return studioProps[studioProps.length - 1];
}

beforeEach(() => {
  studioProps.length = 0;
  mockSearchParams.mockReset();
});

describe('Export Studio route — deep links (MFX-41.4)', () => {
  it('hands a shared session to the Studio as validated state', () => {
    const opts = encodeStudioOptions({ package: 'com.example' });
    const props = renderRoute(
      `artifact=proj-1&version=rev-9&label=Pet+Store+API&target=proto&from=catalog&sourceFormat=graphql&opts=${opts}&step=verify`,
    );
    expect(props).toMatchObject({
      artifact: 'proj-1',
      version: 'rev-9',
      artifactLabel: 'Pet Store API',
      initialTarget: 'proto',
      initialOptions: { package: 'com.example' },
      initialStep: 'verify',
      origin: 'catalog',
      sourceFormat: 'graphql',
    });
    expect(props.linkIssues).toEqual([]);
  });

  it('still opens a link minted before the compact encoding (MFX-41.3)', () => {
    const props = renderRoute(
      `artifact=proj-1&target=proto&options=${encodeURIComponent('{"package":"com.legacy"}')}`,
    );
    expect(props.initialOptions).toEqual({ package: 'com.legacy' });
    expect(props.initialStep).toBeNull();
  });

  it('never lets a credential out of the URL and into the form', () => {
    const props = renderRoute(
      `artifact=proj-1&target=proto&options=${encodeURIComponent(
        '{"package":"p","registry_token":"sk-live-1"}',
      )}`,
    );
    expect(props.initialOptions).toEqual({ package: 'p' });
    expect(props.linkIssues).toEqual([
      expect.objectContaining({ code: 'options-redacted' }),
    ]);
  });

  it('degrades an unreadable options payload into a notice', () => {
    const props = renderRoute('artifact=proj-1&target=proto&opts=%7Bnope');
    expect(props.initialOptions).toBeNull();
    expect(props.linkIssues).toEqual([
      expect.objectContaining({ code: 'options-unreadable' }),
    ]);
  });

  it('ignores an unknown step rather than resuming somewhere arbitrary', () => {
    expect(renderRoute('artifact=proj-1&step=teleport').initialStep).toBeNull();
  });

  it('shows how to open the Studio when the link carries no source', () => {
    mockSearchParams.mockReturnValue(new URLSearchParams(''));
    render(<ExportStudioPage />);
    expect(screen.getByText(/open the export studio from a source/i)).toBeInTheDocument();
    expect(screen.queryByTestId('export-studio-stub')).not.toBeInTheDocument();
  });
});
