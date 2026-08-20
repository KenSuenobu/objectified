/**
 * `CatalogSupportedFormats` renders from the import-source registry (FMT-1.2, #5413).
 *
 * The acceptance criterion: the gallery reads `GET /api/import/sources` rather than keeping its own
 * view of which formats are importable. These tests drive the real component against fixture
 * registry payloads and assert that what it shows follows the payload — including the two cases
 * that used to be conflated: a format with no adapter ("not yet importable") and a format whose
 * adapter is registered but cannot run here ("unavailable in this runtime").
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { CatalogSupportedFormats } from '../src/app/components/ade/catalog/CatalogSupportedFormats';
import { CATALOG_FORMAT_UNAVAILABLE_NOTE } from '../src/app/components/ade/catalog/CatalogSupportedFormats';

/** One descriptor as `GET /api/import/sources` reports it. */
function source(key: string, available = true, unavailable_reason: string | null = null) {
  return {
    key,
    label: key,
    description: `The ${key} adapter.`,
    icon: 'file-code',
    paradigm: 'rest',
    input_kinds: ['file', 'url', 'paste'],
    supports_live_discovery: false,
    formats: [key],
    file_extensions: [`.${key}`],
    available,
    unavailable_reason,
  };
}

/** Serve a fixture registry payload for `/api/import/sources`; everything else fails closed. */
function mockRegistry(sources: ReturnType<typeof source>[] | null) {
  return jest.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/import/sources')) {
      if (sources === null) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

/** Render the gallery expanded and wait for the registry fetch to land. */
async function renderGallery() {
  render(<CatalogSupportedFormats defaultOpen />);
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
  );
}

/**
 * Queries scoped to the expanded panel.
 *
 * The collapsed header previews the first few format names as pills, so an unscoped `getByText`
 * matches twice — once in the preview, once in the grid below.
 */
function panel() {
  const node = document.getElementById('catalog-supported-formats-panel');
  if (!node) throw new Error('the gallery panel is not open');
  return within(node);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CatalogSupportedFormats reads the registry', () => {
  it('lists a format as importable because the registry reports its adapter', async () => {
    global.fetch = mockRegistry([source('grpc'), source('graphql')]) as unknown as typeof fetch;
    await renderGallery();

    await waitFor(() => expect(panel().getByText('gRPC')).toBeInTheDocument());
    expect(panel().getByText('GraphQL')).toBeInTheDocument();
    // Two gallery entries — `gRPC` and `Protobuf` — both import under the `grpc` adapter, so both
    // follow that one key.
    expect(panel().getByText('Protobuf')).toBeInTheDocument();
  });

  it('demotes a format the registry does not report to "not yet importable"', async () => {
    // Only gRPC is registered here, so HL7 v2 must appear in the recognized section.
    global.fetch = mockRegistry([source('grpc')]) as unknown as typeof fetch;
    await renderGallery();

    await waitFor(() =>
      expect(panel().getByText('Recognized — not yet importable')).toBeInTheDocument(),
    );
    expect(panel().getByText('HL7 v2')).toBeInTheDocument();
  });

  it('promotes a format as soon as its adapter appears in the payload', async () => {
    global.fetch = mockRegistry([source('grpc')]) as unknown as typeof fetch;
    const first = render(<CatalogSupportedFormats defaultOpen />);
    await waitFor(() => expect(panel().getByText('HL7 v2')).toBeInTheDocument());
    // The `grpc` key backs two gallery entries (gRPC and Protobuf), so registering it alone counts
    // two importable formats.
    await waitFor(() =>
      expect(screen.getByTestId('catalog-supported-formats-toggle')).toHaveTextContent(
        /2 alternative formats importable now/,
      ),
    );
    first.unmount();

    global.fetch = mockRegistry([source('grpc'), source('hl7v2')]) as unknown as typeof fetch;
    render(<CatalogSupportedFormats defaultOpen />);
    await waitFor(() =>
      expect(screen.getByTestId('catalog-supported-formats-toggle')).toHaveTextContent(
        /3 alternative formats importable now/,
      ),
    );
  });

  it('counts only what this deployment can actually run', async () => {
    // A registered adapter with a missing toolchain is listed but not counted as importable here.
    global.fetch = mockRegistry([
      source('grpc', false, 'Requires the buf toolchain, which is not available in this runtime.'),
      source('graphql'),
    ]) as unknown as typeof fetch;
    await renderGallery();

    await waitFor(() =>
      expect(screen.getByTestId('catalog-supported-formats-toggle')).toHaveTextContent(
        /1 alternative formats importable now/,
      ),
    );
  });

  it('keeps an unavailable adapter in the importable section, dimmed with a reason', async () => {
    // "This deployment has no buf" is not "Apiome has never heard of Protobuf"; the gallery must
    // not collapse the two.
    global.fetch = mockRegistry([
      source('grpc', false, 'Requires the buf toolchain, which is not available in this runtime.'),
    ]) as unknown as typeof fetch;
    await renderGallery();

    await waitFor(() => expect(panel().getByText('gRPC')).toBeInTheDocument());
    expect(panel().getAllByText(CATALOG_FORMAT_UNAVAILABLE_NOTE).length).toBeGreaterThan(0);
    // It is not in the recognized/not-yet-importable group.
    const recognizedHeading = panel().getByText('Recognized — not yet importable');
    const recognizedSection = recognizedHeading.closest('div')?.parentElement;
    expect(recognizedSection?.textContent).not.toContain('gRPC');
  });

  it('says so plainly when every recognized format is importable', async () => {
    const everything = [
      'grpc', 'graphql', 'asyncapi', 'thrift', 'connectrpc', 'flatbuffers', 'capnproto', 'wit',
      'wsdl', 'raml', 'wadl', 'discovery', 'openrpc', 'avro', 'xmlrpc', 'xsd', 'postman',
      'cloudevents', 'smithy', 'apiblueprint', 'arazzo', 'asn1', 'edix12', 'oncrpc', 'corbaidl',
      'odata', 'kong', 'gateway-api', 'fhir', 'hl7v2', 'iso20022', 'iso8583', 'cobolcopybook',
      'fix', 'zosconnect', 'json-schema', 'k8s-crd', 'llm-tools', 'mcp', 'jtd', 'typespec',
      'http-file',
    ].map((key) => source(key));
    global.fetch = mockRegistry(everything) as unknown as typeof fetch;
    await renderGallery();

    await waitFor(() =>
      expect(panel().getByTestId('catalog-formats-none-pending')).toBeInTheDocument(),
    );
  });

  it('falls back to the shipped list when the registry is unreachable', async () => {
    // A blank gallery would be worse than a slightly stale one.
    global.fetch = mockRegistry(null) as unknown as typeof fetch;
    await renderGallery();

    await waitFor(() => expect(panel().getByText('gRPC')).toBeInTheDocument());
    expect(screen.getByTestId('catalog-supported-formats')).toBeInTheDocument();
  });

  it('still toggles open and closed', async () => {
    global.fetch = mockRegistry([source('grpc')]) as unknown as typeof fetch;
    render(<CatalogSupportedFormats />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    const toggle = screen.getByTestId('catalog-supported-formats-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
