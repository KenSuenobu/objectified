/**
 * Render/interaction tests for the Catalog format facet (MFI-28.4, #4120; rebuilt on Radix in
 * HIVE-7.1, #5318).
 *
 * The facet is a controlled multi-select menu that filters the catalog by format family. These
 * cover the disabled empty state, opening the menu, toggling options on and off (reported to
 * the parent), the counts beside each family, the active-count badge, and clearing.
 *
 * What is *not* asserted here is the behaviour Radix owns — outside-click, Escape, focus
 * restoration, typeahead. The control this replaced hand-rolled all four; the point of the
 * rebuild is that they are no longer this component's to get wrong.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { CatalogFormatFacet } from '../src/app/components/ade/catalog';

const OPTIONS = [
  { id: 'protobuf', label: 'gRPC / Protobuf', count: 3 },
  { id: 'graphql', label: 'GraphQL', count: 2 },
  { id: 'asyncapi', label: 'AsyncAPI', count: 1 },
];

/** Radix `DropdownMenu.Trigger` opens on `pointerdown`, which jsdom does not synthesise. */
function openMenu() {
  fireEvent.keyDown(screen.getByTestId('catalog-format-facet'), { key: 'Enter' });
}

describe('CatalogFormatFacet', () => {
  it('disables the trigger and offers no menu when there are no formats', () => {
    render(<CatalogFormatFacet options={[]} selected={[]} onChange={() => {}} />);
    const trigger = screen.getByTestId('catalog-format-facet');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'No formats to filter yet');
    openMenu();
    expect(screen.queryByTestId('catalog-format-facet-menu')).not.toBeInTheDocument();
  });

  it('opens the menu and lists every available family with its count', () => {
    render(<CatalogFormatFacet options={OPTIONS} selected={[]} onChange={() => {}} />);
    openMenu();
    expect(screen.getByTestId('catalog-format-facet-menu')).toBeInTheDocument();
    for (const option of OPTIONS) {
      const row = screen.getByTestId(`catalog-format-option-${option.id}`);
      expect(row).toHaveTextContent(option.label);
      expect(row).toHaveTextContent(String(option.count));
    }
  });

  it('adds an unticked family to the selection', () => {
    const onChange = jest.fn();
    render(<CatalogFormatFacet options={OPTIONS} selected={['protobuf']} onChange={onChange} />);
    openMenu();
    fireEvent.click(screen.getByTestId('catalog-format-option-graphql'));
    expect(onChange).toHaveBeenCalledWith(['protobuf', 'graphql']);
  });

  it('removes an already-ticked family', () => {
    const onChange = jest.fn();
    render(
      <CatalogFormatFacet options={OPTIONS} selected={['protobuf', 'graphql']} onChange={onChange} />
    );
    openMenu();
    fireEvent.click(screen.getByTestId('catalog-format-option-protobuf'));
    expect(onChange).toHaveBeenCalledWith(['graphql']);
  });

  it('marks the trigger active, counts the selection and checks the ticked rows', () => {
    render(
      <CatalogFormatFacet options={OPTIONS} selected={['protobuf', 'asyncapi']} onChange={() => {}} />
    );
    const trigger = screen.getByTestId('catalog-format-facet');
    expect(trigger).toHaveAttribute('data-active');
    expect(screen.getByTestId('catalog-format-facet-count')).toHaveTextContent('2');
    openMenu();
    expect(screen.getByTestId('catalog-format-option-protobuf')).toHaveAttribute(
      'data-state',
      'checked'
    );
    expect(screen.getByTestId('catalog-format-option-graphql')).toHaveAttribute(
      'data-state',
      'unchecked'
    );
  });

  it('clears the whole selection via Clear', () => {
    const onChange = jest.fn();
    render(<CatalogFormatFacet options={OPTIONS} selected={['protobuf']} onChange={onChange} />);
    openMenu();
    fireEvent.click(screen.getByTestId('catalog-format-clear'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('offers no Clear when nothing is ticked, and marks the trigger inactive', () => {
    render(<CatalogFormatFacet options={OPTIONS} selected={[]} onChange={() => {}} />);
    expect(screen.getByTestId('catalog-format-facet')).not.toHaveAttribute('data-active');
    expect(screen.queryByTestId('catalog-format-facet-count')).not.toBeInTheDocument();
    openMenu();
    expect(screen.queryByTestId('catalog-format-clear')).not.toBeInTheDocument();
  });
});
