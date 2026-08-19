/**
 * Render tests for the persistent non-publishable banner (MFI-24.3, #4083; re-skinned
 * HIVE-7.1, #5318).
 *
 * Confirms the info banner renders with an accessible `role="note"` landmark and that its copy
 * matches the mockup intent — items are non-publishable, the only path is "Convert to OpenAPI", and
 * OpenAPI/Swagger imports land in Projects.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { CatalogNonPublishableBanner } from '../src/app/components/ade/catalog';

/** The copy uses non-breaking spaces (U+00A0); normalise them to plain spaces before asserting. */
function normalisedText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/ /g, ' ');
}

describe('CatalogNonPublishableBanner', () => {
  it('renders a note landmark for assistive tech', () => {
    render(<CatalogNonPublishableBanner />);
    const banner = screen.getByRole('note');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('data-testid', 'catalog-nonpublishable-banner');
  });

  it('states that catalog items are non-publishable', () => {
    render(<CatalogNonPublishableBanner />);
    expect(normalisedText(screen.getByRole('note'))).toContain('Catalog items are non-publishable.');
  });

  it('names Convert to OpenAPI as the only publishable path', () => {
    render(<CatalogNonPublishableBanner />);
    const text = normalisedText(screen.getByRole('note'));
    expect(text).toContain('Convert to OpenAPI');
    expect(text).toContain('only path to a publishable spec');
  });

  it('explains that OpenAPI/Swagger imports land in Projects', () => {
    render(<CatalogNonPublishableBanner />);
    const banner = screen.getByRole('note');
    expect(normalisedText(banner)).toContain('OpenAPI/Swagger imports still land in');
    expect(within(banner).getByText('Projects')).toBeInTheDocument();
  });
});
