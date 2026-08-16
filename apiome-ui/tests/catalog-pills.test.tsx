/**
 * Render tests for the catalog pills (MFI-23.5, #4014): FormatPill, ProtocolPill, SourceBadge.
 *
 * These pin the acceptance criteria — a correct format pill + protocol pill + source badge, and the
 * neutral-pill degradation for unknown formats — plus the null-render contract when there is nothing
 * to show.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { FormatPill } from '../src/app/components/ui/catalog/FormatPill';
import { ProtocolPill } from '../src/app/components/ui/catalog/ProtocolPill';
import { SourceBadge } from '../src/app/components/ui/catalog/SourceBadge';
import { resolveCatalogSource } from '../src/app/utils/catalog-format-registry';

describe('FormatPill', () => {
  it('renders the registry label for a known format', () => {
    render(<FormatPill format="openapi-3.1" />);
    const pill = screen.getByTestId('format-pill');
    expect(pill).toHaveTextContent('OpenAPI');
    expect(pill).toHaveAttribute('title', 'Format: OpenAPI');
  });

  it('degrades an unknown but present format to a neutral pill showing the raw token', () => {
    render(<FormatPill format="mystery-format" />);
    const pill = screen.getByTestId('format-pill');
    expect(pill).toHaveTextContent('mystery-format');
    // Neutral hue, not a coloured one. Since HIVE-2.4 (#5283) the hue is a fixed `.fmt--*`
    // class rather than a theme-tinted utility — a format's colour is an identity.
    expect(pill.className).toContain('fmt--neutral');
  });

  it('gives a known format a fixed hue that does not tint with the theme', () => {
    render(<FormatPill format="asyncapi" />);
    const pill = screen.getByTestId('format-pill');
    // The registry's tone names the hue; the hue itself is frozen in `globals.css`.
    expect(pill.className).toContain('fmt--violet');
    expect(pill.className).not.toMatch(/dark:/);
    expect(pill).toHaveAttribute('data-format', 'asyncapi');
  });

  it('renders nothing when the format is empty or absent', () => {
    const { container, rerender } = render(<FormatPill format={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FormatPill format="   " />);
    expect(screen.queryByTestId('format-pill')).not.toBeInTheDocument();
  });
});

describe('ProtocolPill', () => {
  it('renders the registry label for a known protocol', () => {
    render(<ProtocolPill protocol="data_schema" />);
    const pill = screen.getByTestId('protocol-pill');
    expect(pill).toHaveTextContent('Data Schema');
    expect(pill).toHaveAttribute('title', 'Protocol: Data Schema');
  });

  it('degrades an unknown protocol to a neutral pill', () => {
    render(<ProtocolPill protocol="smoke-signal" />);
    const pill = screen.getByTestId('protocol-pill');
    expect(pill).toHaveTextContent('smoke-signal');
    expect(pill.className).toContain('bg-gray-100');
  });

  it('renders nothing when the protocol is absent', () => {
    const { container } = render(<ProtocolPill protocol={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SourceBadge', () => {
  it('renders a resolved file source with its file name', () => {
    const source = resolveCatalogSource({ input_kind: 'file', file_name: 'petstore.proto' }, null);
    render(<SourceBadge source={source} />);
    const badge = screen.getByTestId('source-badge');
    expect(badge).toHaveTextContent('petstore.proto');
    expect(badge).toHaveAttribute('title', 'Source: petstore.proto');
  });

  it('shows the compacted URL but keeps the full URL in the tooltip', () => {
    const source = resolveCatalogSource(
      { inputKind: 'url', sourceUri: 'https://api.example.com/v1/spec.yaml?x=1' },
      null,
    );
    render(<SourceBadge source={source} />);
    const badge = screen.getByTestId('source-badge');
    expect(badge).toHaveTextContent('api.example.com/v1/spec.yaml');
    expect(badge).toHaveAttribute('title', 'Source: https://api.example.com/v1/spec.yaml?x=1');
  });

  it('supports an explicit kind with the kind fallback label', () => {
    render(<SourceBadge kind="discovery" />);
    expect(screen.getByTestId('source-badge')).toHaveTextContent('Live discovery');
  });

  it('renders nothing when neither a source nor a kind is supplied', () => {
    const { container } = render(<SourceBadge source={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
