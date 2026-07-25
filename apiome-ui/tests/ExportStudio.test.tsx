/**
 * ExportStudio — the full-page Export Studio route + stepper shell (MFX-41.1, #4348).
 *
 * Covers the ticket's acceptance criteria:
 *  1. The Studio opens scoped to a source (name + resolved version), with the target carried from
 *     the dialog escalation pre-selected.
 *  2. All registered targets render in the shared grid with their per-source fidelity badges.
 *  3. The generated options form validates against the emitter schema and gates the Options step.
 *  4. Stepper state (selected target, option values) survives navigating back and forth.
 *  5. Forward navigation is gated: no Verify until a target is picked; no Generate until Verify
 *     ran (or was skipped with the lossy loss acknowledged).
 *  6. Generate submits an async export job (`POST /api/export/jobs`), polls it to completion, and
 *     downloads the emitted artifact into the Review preview card (MFX-46.2).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, language }: { value?: string; language?: string }) => (
    <div data-testid="export-artifact-content" data-language={language}>
      {value}
    </div>
  ),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

// The job tracker toasts on background completion; a stub keeps that out of the DOM in tests.
jest.mock('sonner', () => ({
  __esModule: true,
  toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }),
}));

import { ExportStudio } from '../src/app/components/ade/dashboard/export/ExportStudio';
import { __resetExportJobTrackerForTests } from '../src/app/components/ade/dashboard/export/exportJobTracker';
import { buildZip } from '../src/app/components/ade/dashboard/export/zipBundle';
import type { ExportTargetsResponse } from '../src/app/components/ade/dashboard/export/exportTargetCatalog';
import type { ExportFidelityEnvelope } from '../src/app/components/ade/dashboard/export/exportFidelityPreview';

/** A three-target registry: lossless OpenAPI, lossy Protobuf (with options), unavailable Avro. */
const TARGETS: ExportTargetsResponse = {
  artifact: 'proj-petstore',
  version: null,
  version_record_id: 'rev-1',
  version_label: '1.2.0',
  targets: [
    {
      descriptor: {
        key: 'avro',
        format: 'avro-1.12',
        label: 'Avro',
        description: 'Export record schemas to Avro.',
        icon: 'layers',
        paradigm: 'data',
        multi_file: false,
        needs_toolchain: true,
        available: false,
        unavailable_reason: 'Requires the avro toolchain.',
      },
      capability_profile: {},
      options_schema: {},
      default_options: {},
      fidelity: { tier: 'types-only', preserved_percent: 31, total: 58, preserved: 18, dropped: 38, approximated: 2, synthesized: 0 },
    },
    {
      descriptor: {
        key: 'openapi',
        format: 'openapi-3.1',
        label: 'OpenAPI 3.1',
        description: 'Export the canonical model as an OpenAPI 3.1 document.',
        icon: 'file-json',
        paradigm: 'rest',
        multi_file: false,
        needs_toolchain: false,
        available: true,
        unavailable_reason: null,
      },
      capability_profile: { operations: true },
      options_schema: {},
      default_options: {},
      fidelity: { tier: 'lossless', preserved_percent: 100, total: 58, preserved: 58, dropped: 0, approximated: 0, synthesized: 0 },
    },
    {
      descriptor: {
        key: 'proto',
        format: 'proto-3',
        label: 'gRPC / Protobuf',
        description: 'Export services and messages as a .proto file.',
        icon: 'binary',
        paradigm: 'rpc',
        multi_file: false,
        needs_toolchain: false,
        available: true,
        unavailable_reason: null,
      },
      capability_profile: { operations: true },
      options_schema: {
        type: 'object',
        required: ['package'],
        properties: {
          emit_services: { type: 'boolean', default: true, title: 'Emit Services', description: 'Emit service/rpc blocks.' },
          package: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: 'Package' },
        },
      },
      default_options: { emit_services: true, package: null },
      fidelity: { tier: 'lossy', preserved_percent: 64, total: 58, preserved: 51, dropped: 3, approximated: 2, synthesized: 2 },
    },
  ],
};

const PREVIEWS: Record<string, ExportFidelityEnvelope> = {
  proto: {
    target: TARGETS.targets[2].descriptor,
    summary: TARGETS.targets[2].fidelity,
    report: {
      items: [
        { construct: 'User.email', kind: 'drop', severity: 'warn', message: 'Unrepresentable in proto3.', target_mapping: null },
      ],
      kind_counts: { drop: 1, approx: 0, synth: 0, ok: 0 },
      severity_counts: { info: 0, warn: 1, critical: 0 },
    },
    advisory: {
      show: true,
      severity: 'warn',
      requires_ack: false,
      target_format: 'gRPC / Protobuf',
      dropped: 3,
      approximated: 2,
      synthesized: 2,
      affected: 7,
      headline: 'This export loses fidelity',
      message: 'Exporting to gRPC / Protobuf may lose some fidelity: 7 constructs affected.',
    },
  },
  openapi: {
    target: TARGETS.targets[1].descriptor,
    summary: TARGETS.targets[1].fidelity,
    report: {
      items: [{ construct: 'User.name', kind: 'ok', severity: 'info', message: 'Carried faithfully.', target_mapping: null }],
      kind_counts: { drop: 0, approx: 0, synth: 0, ok: 1 },
      severity_counts: { info: 1, warn: 0, critical: 0 },
    },
    advisory: {
      show: false,
      severity: null,
      requires_ack: false,
      target_format: 'OpenAPI 3.1',
      dropped: 0,
      approximated: 0,
      synthesized: 0,
      affected: 0,
      headline: 'Lossless export to OpenAPI 3.1',
      message: 'Every construct is carried faithfully to OpenAPI 3.1.',
    },
  },
};

/** The emitted document a completed job serves per target. */
function docFor(target: string) {
  return target === 'openapi'
    ? { filename: 'petstore.json', type: 'application/json', text: '{"openapi":"3.1.0"}' }
    : { filename: 'petstore.proto', type: 'text/plain', text: 'syntax = "proto3";' };
}

/** A downloadable-artifact HTTP response, like the job download route returns. */
function downloadResponse(target: string, bundle = false) {
  if (bundle && target === 'proto') {
    const zip = buildZip([
      { path: 'petstore.proto', content: 'syntax = "proto3";' },
      { path: 'google/protobuf/timestamp.proto', content: 'message Timestamp {}' },
    ]);
    return {
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-disposition'
            ? 'attachment; filename="petstore.zip"'
            : name.toLowerCase() === 'content-type'
              ? 'application/zip'
              : null,
      },
      arrayBuffer: () => Promise.resolve(zip.buffer.slice(0)),
    };
  }
  const doc = docFor(target);
  return {
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-disposition'
          ? `attachment; filename="${doc.filename}"`
          : name.toLowerCase() === 'content-type'
            ? doc.type
            : null,
    },
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(doc.text).buffer),
  };
}

/** One IXH-4.1 manifest entity row with sensible retained defaults. */
function entityRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    parent_key: null,
    description: null,
    deprecated: false,
    status: 'retained',
    reason: null,
    severity: 'info',
    detail: 'carried faithfully',
    target_mapping: null,
    emitted: true,
    aggregated: false,
    reported: true,
    native_name: null,
    native_id: null,
    source_location: null,
    ...overrides,
  };
}

function mockFetch(
  opts: {
    invalidVerify?: boolean;
    bundle?: boolean;
    jobFailure?: 'validation' | 'confirmation' | 'emit';
  } = {},
): jest.Mock {
  // Closure state so a job's GET status reflects what its POST was submitted with (target/confirm).
  let submittedTarget = 'openapi';
  let submittedConfirm = false;
  return jest.fn((input: unknown, init?: { method?: string; body?: string }) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/export/targets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...TARGETS }) });
    }
    // IXH-4.1 structural manifest — MUST be matched before the '/api/export/preview'
    // substring branch below, which this URL also contains.
    if (url.includes('/api/export/preview-manifest') && init?.method === 'POST') {
      const target = String(JSON.parse(init?.body ?? '{}').target);
      const proto = target !== 'openapi';
      const entities = proto
        ? [
            entityRow({ key: 'PetService', name: 'PetService', entity_kind: 'service', order: 0, aggregated: true, location: { file: 'petstore.proto', line: 1, pointer: null } }),
            entityRow({ key: 'Timestamp', name: 'Timestamp', entity_kind: 'type', order: 1, location: { file: 'google/protobuf/timestamp.proto', line: 1, pointer: null } }),
            entityRow({ key: 'pet/created', name: 'pet/created', entity_kind: 'channel', order: 2, status: 'dropped', reason: 'destination_unsupported', severity: 'warn', detail: 'protobuf has no event channels', emitted: false, location: null }),
          ]
        : [
            entityRow({ key: 'GET /pets', name: 'listPets', entity_kind: 'operation', order: 0, location: { file: 'petstore.json', line: 1, pointer: '/openapi' } }),
          ];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            artifact: 'proj-petstore',
            version: null,
            version_record_id: 'rev-1',
            version_label: '1.2.0',
            manifest: {
              manifest_hash: 'manifest-hash-1',
              target: { key: target, format: target, label: target, emitter_version: '1', apiome_version: '1.6.5', registry_version: '1' },
              status_counts: { retained: entities.filter((e) => e.status === 'retained').length, dropped: entities.filter((e) => e.status === 'dropped').length },
              reason_counts: {},
              entities,
              total_entities: entities.length,
              dropped_entities: entities.filter((e) => !e.emitted).length,
              files: proto
                ? [
                    { path: 'petstore.proto', media_type: 'text/plain', line_count: 1, entity_count: 1 },
                    { path: 'google/protobuf/timestamp.proto', media_type: 'text/plain', line_count: 1, entity_count: 1 },
                  ]
                : [{ path: 'petstore.json', media_type: 'application/json', line_count: 1, entity_count: 1 }],
              page_size: 1000,
              next_cursor: null,
              truncated: false,
            },
          }),
      });
    }
    if (url.includes('/api/export/preview') && init?.method === 'POST') {
      const target = String(JSON.parse(init?.body ?? '{}').target);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            artifact: 'proj-petstore',
            version: null,
            version_record_id: 'rev-1',
            version_label: '1.2.0',
            fidelity: PREVIEWS[target],
          }),
      });
    }
    // One-call Verify (MFX-42.1) — all three lenses + verdict in one dry-run. Proto is a lossy
    // (valid, lint-clean) conversion; OpenAPI is clean.
    if (url.includes('/api/export/verify') && init?.method === 'POST') {
      const target = String(JSON.parse(init?.body ?? '{}').target);
      const lossy = target !== 'openapi';
      const invalid = Boolean(opts.invalidVerify);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            artifact: 'proj-petstore',
            version: null,
            version_record_id: 'rev-1',
            version_label: '1.2.0',
            fidelity: PREVIEWS[target],
            validation: invalid
              ? {
                  verdict: 'invalid',
                  target,
                  blocks_delivery: true,
                  warns: false,
                  valid: false,
                  findings: [
                    { message: 'Field number 0 is not allowed.', file: 'petstore.proto', line: 12, column: 3, keyword: 'buf.field-number' },
                  ],
                  detail: null,
                  headline: 'Invalid — export blocked',
                  message: 'The export was blocked before delivery.',
                }
              : {
                  verdict: 'valid',
                  target,
                  blocks_delivery: false,
                  warns: false,
                  valid: true,
                  findings: [],
                  detail: null,
                  headline: 'Valid',
                  message: 'The emitted artifact re-parsed cleanly.',
                },
            lint: {
              applicable: true,
              pack: 'pack',
              score: 95,
              grade: 'A',
              // The bundle scenario carries located lint findings (MFX-43.3): one per bundle
              // file, plus one with no location that must stay list-only.
              findings: opts.bundle
                ? [
                    { severity: 'warning', rule: 'proto-style', message: 'Prefer explicit package.', file: 'petstore.proto', line: 1, column: 8 },
                    { severity: 'info', rule: 'naming', message: 'Consider a suffix.', file: 'google/protobuf/timestamp.proto', line: 1 },
                    { severity: 'info', rule: 'no-loc', message: 'Location-less lint.' },
                  ]
                : [],
            },
            verdict: invalid ? 'invalid' : lossy ? 'lossy' : 'clean',
          }),
      });
    }
    // Async export job download (MFX-46.2) — the completed job's emitted artifact bytes.
    if (url.includes('/api/export/jobs/') && url.endsWith('/download')) {
      return Promise.resolve(downloadResponse(submittedTarget, Boolean(opts.bundle)));
    }
    // Submit an async export job — 202 with the job id + poll path.
    if (url.endsWith('/api/export/jobs') && init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      submittedTarget = String(body.target);
      submittedConfirm = Boolean(body.confirm);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, job_id: 'job-1', status_path: '/api/export/jobs/job-1' }),
      });
    }
    // Poll a job — resolves terminal on the first poll: completed, or a structured failure.
    if (url.includes('/api/export/jobs/')) {
      const target = submittedTarget;
      let status: Record<string, unknown>;
      if (opts.jobFailure === 'validation') {
        status = {
          job_id: 'job-1',
          state: 'failed',
          percent: 75,
          events: [],
          progress: { phase: 'validating', total: 5, completed: 3 },
          error: {
            code: 'EMITTED_ARTIFACT_INVALID',
            message: 'The export was blocked before delivery.',
            context: {
              target,
              validation: {
                verdict: 'invalid',
                target,
                blocks_delivery: true,
                warns: false,
                valid: false,
                findings: [
                  { message: 'Field number 0 is not allowed.', file: 'petstore.proto', line: 12, column: 3, keyword: 'buf.field-number' },
                ],
                detail: null,
                headline: 'Invalid — export blocked',
                message: 'The export was blocked before delivery.',
              },
            },
          },
        };
      } else if (opts.jobFailure === 'emit') {
        status = {
          job_id: 'job-1',
          state: 'failed',
          percent: 55,
          events: [],
          progress: { phase: 'emitting', total: 5, completed: 2 },
          error: { code: 'EMIT_FAILED', message: 'The emitter crashed.', context: { status_code: 500 } },
        };
      } else if (opts.jobFailure === 'confirmation' && !submittedConfirm) {
        status = {
          job_id: 'job-1',
          state: 'failed',
          percent: 30,
          events: [],
          progress: { phase: 'analyzing-fidelity', total: 5, completed: 1 },
          error: {
            code: 'TRANSCODE_CONFIRMATION_REQUIRED',
            message: 'This is a severe conversion.',
            context: { verdict: 'severe', reasons: ['Drops all response types'], preserved_percent: 31 },
          },
        };
      } else {
        status = {
          job_id: 'job-1',
          state: 'completed',
          percent: 100,
          events: [],
          progress: { phase: 'packaging', total: 5, completed: 4 },
          result: {
            artifact: 'proj-petstore',
            version_record_id: 'rev-1',
            version_label: '1.2.0',
            target,
            dry_run: false,
            fidelity: PREVIEWS[target],
            files: [{ path: docFor(target).filename, size_bytes: 42 }],
            media_type: docFor(target).type,
            download_path: `/v1/export/t/jobs/job-1/download`,
          },
        };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...status }) });
    }
    // Projection evidence behind the Verify workbench's projection map (EFP-2.1/2.2): one
    // dropped construct whose drawer offers the EFP-2.3 option-change remediation.
    if (url.includes('/api/export/projection-evidence') && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            artifact: 'proj-petstore',
            version: null,
            version_record_id: 'rev-1',
            version_label: '1.2.0',
            redacted: false,
            summary: {
              manifest_hash: 'hash-studio-evidence',
              target: { key: submittedTarget, emitter_version: '1.4.0', registry_version: '2025.07.01' },
              status_counts: { dropped: 1 },
              reason_counts: { option_excluded: 1 },
              total_constructs: 1,
              node_count: 1,
              edge_count: 1,
              evidence_count: 1,
              is_lossless: false,
              worst_severity: 'warn',
              truncated: false,
            },
            page: {
              manifest_hash: 'hash-studio-evidence',
              nodes: [
                { id: 'c1', kind: 'canonical', label: 'PetService', construct_key: 'PetService' },
              ],
              edges: [
                { id: 'se1', relation: 'projects', source: 'c1', target: null, status: 'dropped', severity: 'warn', reason: 'option_excluded', detail: 'Services were excluded by the emit_services option.' },
              ],
              next_cursor: null,
              total: 1,
            },
          }),
      });
    }
    // Catalog-source context for the Source step (MFX-41.2) — a non-OpenAPI (gRPC) import.
    if (url.includes('/api/catalog/')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            item: {
              id: 'proj-petstore',
              name: 'Pet Store API',
              sourceFormat: 'protobuf',
              protocol: 'grpc',
              summary: { services: 3, operations: 12, types: 27, channels: null },
            },
          }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

/** Render the Studio and wait for the target list to load. */
async function renderStudio(
  fetchMock: jest.Mock,
  props: Partial<React.ComponentProps<typeof ExportStudio>> = {},
) {
  global.fetch = fetchMock as unknown as typeof fetch;
  const utils = render(
    <ExportStudio artifact="proj-petstore" artifactLabel="Pet Store API" version="rev-1" {...props} />,
  );
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/export/targets?artifact=proj-petstore'),
      expect.anything(),
    ),
  );
  await waitFor(() => expect(screen.getByText(/export targets available/)).toBeInTheDocument());
  return utils;
}

beforeEach(() => {
  // The job tracker is a module singleton with sessionStorage persistence — reset both so a job
  // from a previous test never resumes into the next one.
  __resetExportJobTrackerForTests();
  window.sessionStorage.clear();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = jest.fn(() => 'blob:mock');
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ExportStudio — scope + target grid (MFX-41.1)', () => {
  it('opens scoped to the source with its resolved version', async () => {
    await renderStudio(mockFetch());
    expect(screen.getByTestId('export-studio')).toBeInTheDocument();
    expect(screen.getAllByText(/Pet Store API/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Version 1\.2\.0/)).toBeInTheDocument();
  });

  it('resolves the back link to the launch origin', async () => {
    await renderStudio(mockFetch(), { origin: 'catalog' });
    expect(screen.getByRole('link', { name: /back to catalog/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /back to versions/i })).not.toBeInTheDocument();
  });

  it('defaults the back link to Versions when no origin was carried', async () => {
    await renderStudio(mockFetch());
    expect(screen.getByRole('link', { name: /back to versions/i })).toBeInTheDocument();
  });

  it('shows catalog-item context on the Source step for a catalog launch (MFX-41.2)', async () => {
    await renderStudio(mockFetch(), { origin: 'catalog', sourceFormat: 'protobuf' });

    // The Source step carries the item's provenance — format + paradigm pills and the counts.
    const context = await screen.findByTestId('export-studio-catalog-context');
    expect(context).toHaveTextContent(/Protobuf/i);
    expect(context).toHaveTextContent(/gRPC|grpc/i);
    const counts = screen.getByTestId('export-studio-catalog-counts');
    expect(counts).toHaveTextContent('3');
    expect(counts).toHaveTextContent('Services');
    expect(counts).toHaveTextContent('Operations');
    // A null count (channels) is omitted, not shown as a zero.
    expect(counts).not.toHaveTextContent('Channels');
    // The Source step restates that exporting never turns the item into a project.
    expect(screen.getByTestId('export-studio-body')).toHaveTextContent(
      /never turns the item into a project/i,
    );
  });

  it('shows no catalog context for a version launch', async () => {
    await renderStudio(mockFetch(), { origin: 'versions' });
    expect(screen.queryByTestId('export-studio-catalog-context')).not.toBeInTheDocument();
  });

  it('renders all five stepper stops', async () => {
    await renderStudio(mockFetch());
    for (const key of ['source', 'target', 'options', 'verify', 'review']) {
      expect(screen.getByTestId(`export-studio-step-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('export-studio-step-source')).toHaveAttribute('data-state', 'current');
  });

  it('renders every registered target with its fidelity badge on the Target step', async () => {
    await renderStudio(mockFetch());
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));

    expect(screen.getByTestId('export-target-openapi')).toHaveTextContent('lossless');
    expect(screen.getByTestId('export-target-proto')).toHaveTextContent('lossy');
    expect(screen.getByTestId('export-target-avro')).toHaveTextContent('types-only');
    expect(screen.getByTestId('export-target-avro')).toBeDisabled();
  });

  it('pre-selects the target carried from the dialog escalation', async () => {
    await renderStudio(mockFetch(), { initialTarget: 'proto' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    // The fidelity headline reflects the pre-selected target without a manual pick.
    expect(screen.getByTestId('export-fidelity-headline')).toHaveTextContent('gRPC / Protobuf');
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled();
  });

  it('hides the same-format target and offers the original source when the format is known', async () => {
    await renderStudio(mockFetch(), { sourceFormat: 'protobuf' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));

    // proto (a protobuf emitter) is dropped — re-exporting to the source format is redundant.
    expect(screen.queryByTestId('export-target-proto')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-target-openapi')).toBeInTheDocument();

    // The "Original source" option downloads the stored source from the catalog endpoint.
    const original = screen.getByTestId('export-original-source');
    expect(original).toHaveTextContent(/protobuf/i);
    expect(screen.getByTestId('export-original-source-download')).toHaveAttribute(
      'href',
      '/api/catalog/proj-petstore/source',
    );
  });
});

describe('ExportStudio — step gating + options validation (MFX-41.1)', () => {
  it('blocks reaching Verify until a target is picked', async () => {
    await renderStudio(mockFetch());
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    // No target picked yet: Continue is disabled.
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled();
    fireEvent.click(screen.getByTestId('export-target-openapi'));
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled();
  });

  it('gates the Options step until a required option validates', async () => {
    await renderStudio(mockFetch(), { initialTarget: 'proto' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options

    // proto marks `package` required; empty fails validation and blocks Continue.
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled();
    expect(screen.getByText(/Package is required\./)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: 'com.example' } });
    expect(screen.queryByText(/Package is required\./)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled();
  });

  it('pre-fills a re-run\'s option overrides over the target defaults (MFX-41.3)', async () => {
    // A re-run carries the prior run's non-default overrides; they replace the target defaults for
    // the matching keys, so the Options step opens already reproducing that configuration.
    await renderStudio(mockFetch(), {
      initialTarget: 'proto',
      initialOptions: { package: 'com.rerun', emit_services: false },
    });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options

    expect(screen.getByLabelText(/Package/i)).toHaveValue('com.rerun');
    // Required `package` is already satisfied by the seeded value, so Continue is enabled.
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled();
  });

  it('ignores re-run overrides for keys the target does not define (MFX-41.3)', async () => {
    // A foreign key from a stale/hand-edited link must not be injected; `package` still needs a value.
    await renderStudio(mockFetch(), {
      initialTarget: 'proto',
      initialOptions: { not_a_real_option: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    expect(screen.getByText(/Package is required\./)).toBeInTheDocument();
  });

  it('shows a no-options note for a target without options', async () => {
    await renderStudio(mockFetch(), { initialTarget: 'openapi' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    expect(screen.getByTestId('export-studio-no-options')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeEnabled();
  });

  it('preserves the selected target and option values across back/forward navigation', async () => {
    await renderStudio(mockFetch(), { initialTarget: 'proto' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: 'com.example' } });

    // Back to Target, then forward to Options again: the value survives.
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByTestId('export-fidelity-headline')).toHaveTextContent('gRPC / Protobuf');
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(screen.getByLabelText(/Package/i)).toHaveValue('com.example');
  });
});

describe('ExportStudio — Verify workbench gate + generate (MFX-42.1)', () => {
  /** Drive a target from the grid to the Verify step (before verification has run). */
  async function advanceToVerify(fetchMock: jest.Mock, target: string) {
    await renderStudio(fetchMock, { initialTarget: target });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    if (target === 'proto') {
      fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: 'com.example' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → verify
  }

  /** Click "Run verification" and wait for the verdict banner to settle. */
  async function runVerification() {
    fireEvent.click(screen.getByTestId('verify-run'));
    await waitFor(() => expect(screen.getByTestId('verify-verdict')).toBeInTheDocument());
  }

  it('gates "Continue to review" until verification has been run (MFX-42.1)', async () => {
    await advanceToVerify(mockFetch(), 'openapi');
    // Nothing has been verified yet: the gate is closed and the run action is offered.
    expect(screen.getByRole('button', { name: /continue to review/i })).toBeDisabled();
    expect(screen.getByTestId('verify-run')).toBeInTheDocument();

    await runVerification();
    // A clean verdict opens the gate with no acknowledgement.
    expect(screen.getByTestId('verify-verdict')).toHaveAttribute('data-verdict', 'clean');
    expect(screen.getByRole('button', { name: /continue to review/i })).toBeEnabled();
  });

  it('one Run verification yields all three lenses + verdict (MFX-42.1)', async () => {
    await advanceToVerify(mockFetch(), 'proto');
    await runVerification();
    // All three lens tabs render, each with a badge, under one verdict banner.
    for (const lens of ['fidelity', 'validation', 'lint']) {
      expect(screen.getByTestId(`verify-tab-${lens}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('verify-verdict')).toHaveTextContent('Lossy — acknowledge to continue');
  });

  it('runs verify and generates a clean target without acknowledgement', async () => {
    const fetchMock = mockFetch();
    await advanceToVerify(fetchMock, 'openapi');
    await runVerification();

    const toReview = screen.getByRole('button', { name: /continue to review/i });
    expect(toReview).toBeEnabled();
    fireEvent.click(toReview);

    fireEvent.click(screen.getByTestId('export-studio-generate'));
    await waitFor(() => expect(screen.getByTestId('export-artifact-preview')).toBeInTheDocument());
    expect(screen.getByTestId('export-artifact-preview')).toHaveTextContent('petstore.json');
  });

  it('keeps a lossy target from proceeding until the loss is acknowledged', async () => {
    await advanceToVerify(mockFetch(), 'proto');
    await runVerification();

    const toReview = screen.getByRole('button', { name: /continue to review/i });
    expect(toReview).toBeDisabled();
    // The "Export anyway" checkbox lives in the fidelity lens (the lossy verdict's default tab).
    const checkbox = within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(toReview).toBeEnabled();
  });

  it('blocks Generate for an invalid output and shows the validator detail (MFX-42.1)', async () => {
    await advanceToVerify(mockFetch({ invalidVerify: true }), 'proto');
    await runVerification();

    // Invalid blocks unconditionally — no acknowledgement is offered, the gate stays shut.
    expect(screen.getByTestId('verify-verdict')).toHaveAttribute('data-verdict', 'invalid');
    expect(screen.getByRole('button', { name: /continue to review/i })).toBeDisabled();
    // The blocked export leads with the validation lens and its structured detail + location.
    const panel = screen.getByTestId('verify-panel-validation');
    expect(within(panel).getByTestId('verify-validation-findings')).toHaveTextContent(
      'Field number 0 is not allowed.',
    );
    expect(within(panel).getByTestId('verify-finding-location')).toHaveTextContent('petstore.proto');
  });

  it('persists the verdict to the Review step (MFX-42.1)', async () => {
    await advanceToVerify(mockFetch(), 'openapi');
    await runVerification();
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));

    // The same verdict banner the Verify step showed follows the user to Review.
    expect(screen.getByTestId('verify-verdict')).toHaveAttribute('data-verdict', 'clean');
    expect(screen.getByTestId('export-studio-review-summary')).toBeInTheDocument();
  });

  it('re-locks the gate when an option changes after a verdict (MFX-42.1)', async () => {
    await advanceToVerify(mockFetch(), 'proto');
    await runVerification();
    fireEvent.click(within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /continue to review/i })).toBeEnabled();

    // Change an option: the prior verdict no longer describes what Generate would produce, so the
    // gate re-locks and the run action returns (auto re-verify is MFX-42.6).
    fireEvent.click(screen.getByRole('button', { name: /^back$/i })); // → options
    fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: 'com.other' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → verify
    expect(screen.queryByTestId('verify-verdict')).not.toBeInTheDocument();
    expect(screen.getByTestId('verify-run')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to review/i })).toBeDisabled();
  });

  it('routes the evidence drawer remediation to the Options step (EFP-2.3)', async () => {
    await advanceToVerify(mockFetch(), 'proto');
    await runVerification();

    // The projection map renders below the lenses; open the excluded construct's drawer.
    await waitFor(() => expect(screen.getByTestId('projection-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('projection-row-select-se1'));
    expect(screen.getByTestId('projection-detail-category')).toHaveTextContent('Excluded by option');

    // The safe remediation navigates to the Options step — nothing changes until the user
    // edits an option there, which re-locks the gate (covered above).
    fireEvent.click(screen.getByTestId('projection-detail-action-change-options'));
    await waitFor(() =>
      expect(screen.getByTestId('export-studio-step-options')).toHaveAttribute('data-state', 'current'),
    );
  });

  it('generates a lossy target and sends only the changed options', async () => {
    const onGenerated = jest.fn();
    const fetchMock = mockFetch();
    await renderStudio(fetchMock, { initialTarget: 'proto', onGenerated });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: 'com.example' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → verify
    await runVerification();
    fireEvent.click(within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));

    expect(screen.getByTestId('export-studio-review-summary')).toHaveTextContent('gRPC / Protobuf');
    fireEvent.click(screen.getByTestId('export-studio-generate'));

    await waitFor(() => expect(screen.getByTestId('export-artifact-preview')).toBeInTheDocument());
    const submitCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/export/jobs') &&
        (init as { method?: string } | undefined)?.method === 'POST',
    );
    expect(submitCall).toBeDefined();
    const body = JSON.parse((submitCall![1] as { body: string }).body);
    expect(body).toEqual({
      artifact: 'proj-petstore',
      version: 'rev-1',
      target: 'proto',
      options: { package: 'com.example' },
      // A lossy conversion continued past the acknowledgement submits the job confirmed (MFX-3.3).
      confirm: true,
      // Studio always forwards the verify envelope's projection snapshot id (EFP-3.1); this
      // fixture's fidelity preview has no projection summary, so the field is null.
      acknowledged_snapshot: null,
    });
    // The same changed options are reported to onGenerated, so the recent-export record can offer
    // a faithful re-run (MFX-41.3).
    expect(onGenerated).toHaveBeenCalledWith(
      expect.objectContaining({ targetKey: 'proto', options: { package: 'com.example' } }),
    );
  });

  it('reports the generated artifact via onGenerated', async () => {
    const onGenerated = jest.fn();
    const fetchMock = mockFetch();
    await renderStudio(fetchMock, { initialTarget: 'openapi', onGenerated });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → verify
    await runVerification();
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
    fireEvent.click(screen.getByTestId('export-studio-generate'));

    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    expect(onGenerated).toHaveBeenCalledWith({
      targetKey: 'openapi',
      targetLabel: 'OpenAPI 3.1',
      tier: 'lossless',
      preservedPercent: 100,
      filename: 'petstore.json',
      // No options were changed from their defaults (openapi has none), so the recorded overrides
      // are null — a re-run of this record reopens the target at its defaults (MFX-41.3).
      options: null,
    });
  });

  it('downloads the generated file and a .zip from the Review step', async () => {
    const downloads: string[] = [];
    jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    await advanceToVerify(mockFetch(), 'openapi');
    await runVerification();
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
    fireEvent.click(screen.getByTestId('export-studio-generate'));
    await waitFor(() => expect(screen.getByTestId('export-artifact-preview')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /download petstore\.json/i }));
    fireEvent.click(screen.getByRole('button', { name: /download \.zip/i }));
    expect(downloads).toEqual(['petstore.json', 'petstore.zip']);
  });

  it('explores a multi-file bundle in the Review step (MFX-43.2)', async () => {
    await advanceToVerify(mockFetch({ bundle: true }), 'proto');
    await runVerification();
    // A lossy proto conversion: acknowledge, then advance and generate.
    fireEvent.click(within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
    fireEvent.click(screen.getByTestId('export-studio-generate'));

    // The bundle explorer (not the single-file preview) renders, with the file tree + tabs.
    const explorer = await screen.findByTestId('bundle-explorer');
    expect(explorer).toHaveAttribute('data-multi', 'true');
    expect(screen.queryByTestId('export-artifact-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('bundle-tree')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-tree-file-petstore.proto')).toBeInTheDocument();

    // Navigate to the nested import file — it opens in the viewer.
    fireEvent.click(screen.getByTestId('bundle-tree-file-google/protobuf/timestamp.proto'));
    expect(await screen.findByTestId('bundle-file-editor')).toHaveTextContent('message Timestamp');

    // A bundle downloads only as the whole .zip here (per-file download is MFX-43.5).
    expect(screen.queryByRole('button', { name: /download petstore\.proto/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download \.zip/i })).toBeInTheDocument();
  });

  it('round-trips a located finding from the Verify lens to the Review editor (MFX-43.3)', async () => {
    await advanceToVerify(mockFetch({ bundle: true }), 'proto');
    await runVerification();
    fireEvent.click(within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
    fireEvent.click(screen.getByTestId('export-studio-generate'));
    await screen.findByTestId('bundle-explorer');

    // The primary file's located lint finding shows in the Review problems panel.
    expect(screen.getByTestId('verify-problem-lint-0')).toBeInTheDocument();

    // Back on the Verify lint lens, located findings are openable; the location-less one is not.
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    fireEvent.click(screen.getByTestId('verify-tab-lint'));
    const lintPanel = screen.getByTestId('verify-panel-lint');
    expect(within(lintPanel).getByTestId('verify-open-lint-1')).toBeInTheDocument();
    expect(within(lintPanel).getByText('Location-less lint.')).toBeInTheDocument();
    expect(within(lintPanel).queryByTestId('verify-open-lint-2')).not.toBeInTheDocument();

    // Click the import file's finding → the Studio jumps to Review with that file open and the
    // finding highlighted in the problems panel (the lens → editor direction).
    fireEvent.click(within(lintPanel).getByTestId('verify-open-lint-1'));
    await screen.findByTestId('bundle-explorer');
    expect(screen.getByTestId('bundle-tab-google/protobuf/timestamp.proto')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('bundle-file-editor')).toHaveTextContent('message Timestamp');
    expect(screen.getByTestId('verify-problem-lint-1')).toHaveAttribute('data-selected', 'true');
  });

  it('renders the artifact manifest tree beside the bundle explorer (IXH-4.1)', async () => {
    await advanceToVerify(mockFetch({ bundle: true }), 'proto');
    await runVerification();
    fireEvent.click(within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
    fireEvent.click(screen.getByTestId('export-studio-generate'));
    await screen.findByTestId('bundle-explorer');

    // The manifest panel loads lazily on the Review step and lists the entity tree.
    const panel = await screen.findByTestId('export-manifest-panel');
    await waitFor(() => expect(within(panel).getAllByTestId('export-manifest-entity').length).toBeGreaterThan(0));
    const summary = within(panel).getByTestId('export-manifest-summary');
    expect(summary).toHaveTextContent('3 entities');

    // Sections render with the loaded entities beneath them (sections default expanded).
    const sections = within(panel).getAllByTestId('export-manifest-section');
    expect(sections.map((s) => s.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Services/i), expect.stringMatching(/Channels/i), expect.stringMatching(/Types/i)]),
    );

    // AC: the dropped channel is listed, badged dropped — never hidden.
    const rows = within(panel).getAllByTestId('export-manifest-entity');
    const droppedRow = rows.find((row) => row.textContent?.includes('pet/created'));
    expect(droppedRow).toBeDefined();
    expect(within(droppedRow!).getByTestId('export-manifest-status')).toHaveAttribute('data-status', 'dropped');

    // Selecting the dropped channel spells out its drop reason in the detail strip.
    fireEvent.click(droppedRow!);
    const detail = within(panel).getByTestId('export-manifest-detail');
    expect(within(detail).getByTestId('export-manifest-reason')).toHaveTextContent('destination_unsupported');
    expect(detail).toHaveTextContent('protobuf has no event channels');
    expect(detail).toHaveTextContent(/not in artifact/i);
  });

  it('reveals an entity across bundle files from the manifest tree (IXH-4.1 two-way)', async () => {
    await advanceToVerify(mockFetch({ bundle: true }), 'proto');
    await runVerification();
    fireEvent.click(within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
    fireEvent.click(screen.getByTestId('export-studio-generate'));
    await screen.findByTestId('bundle-explorer');
    const panel = await screen.findByTestId('export-manifest-panel');
    await waitFor(() => expect(within(panel).getAllByTestId('export-manifest-entity').length).toBeGreaterThan(0));

    // The primary file is active to start.
    expect(screen.getByTestId('bundle-tab-petstore.proto')).toHaveAttribute('data-active', 'true');

    // Selecting the Timestamp type (located in the nested import file) opens that file in
    // the viewer — entity → code selection synchronized across bundle files.
    const rows = within(panel).getAllByTestId('export-manifest-entity');
    const timestampRow = rows.find((row) => row.textContent?.includes('Timestamp'));
    expect(timestampRow).toBeDefined();
    fireEvent.click(timestampRow!);
    expect(screen.getByTestId('bundle-tab-google/protobuf/timestamp.proto')).toHaveAttribute('data-active', 'true');
    expect(await screen.findByTestId('bundle-file-editor')).toHaveTextContent('message Timestamp');
    // The tree row reflects the shared selection.
    expect(timestampRow).toHaveAttribute('aria-selected', 'true');
  });
});

describe('ExportStudio — job progress & failure recovery (MFX-46.2)', () => {
  /** Verify a clean OpenAPI (or acknowledge a lossy proto) and land on the Review step. */
  async function advanceToReview(
    fetchMock: jest.Mock,
    target: string,
    { acknowledge = false }: { acknowledge?: boolean } = {},
  ) {
    await renderStudio(fetchMock, { initialTarget: target });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    if (target === 'proto') {
      fireEvent.change(screen.getByLabelText(/Package/i), { target: { value: 'com.example' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → verify
    fireEvent.click(screen.getByTestId('verify-run'));
    await waitFor(() => expect(screen.getByTestId('verify-verdict')).toBeInTheDocument());
    if (acknowledge) {
      fireEvent.click(within(screen.getByTestId('verify-panel-fidelity')).getByRole('checkbox'));
    }
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
  }

  it('surfaces every pipeline stage on a failed job (MFX-46.2 acceptance #1)', async () => {
    await advanceToReview(mockFetch({ jobFailure: 'emit' }), 'openapi');
    fireEvent.click(screen.getByTestId('export-studio-generate'));

    await waitFor(() => expect(screen.getByTestId('generate-failure')).toBeInTheDocument());
    // Each of the five stages is rendered and individually addressable.
    for (const key of ['loading-source', 'analyzing-fidelity', 'emitting', 'validating', 'packaging']) {
      expect(screen.getByTestId(`generate-stage-${key}`)).toBeInTheDocument();
    }
    // The emit failure marks the emitting row failed and the earlier rows done.
    expect(screen.getByTestId('generate-stage-emitting')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('generate-stage-loading-source')).toHaveAttribute('data-status', 'done');
    expect(screen.getByTestId('generate-stage-packaging')).toHaveAttribute('data-status', 'pending');
  });

  it('renders an emitter failure with its detail and a retry action (MFX-46.2 acceptance #2)', async () => {
    const fetchMock = mockFetch({ jobFailure: 'emit' });
    await advanceToReview(fetchMock, 'openapi');
    fireEvent.click(screen.getByTestId('export-studio-generate'));

    const failure = await screen.findByTestId('generate-failure');
    expect(failure).toHaveAttribute('data-failure-class', 'emitter');
    expect(failure).toHaveAttribute('data-recovery', 'retry');
    expect(screen.getByTestId('generate-failure-message')).toHaveTextContent('The emitter crashed.');

    // Retry re-submits the same config — a second POST to /api/export/jobs.
    fireEvent.click(screen.getByTestId('generate-failure-action'));
    await waitFor(() => {
      const submits = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/api/export/jobs') &&
          (init as { method?: string } | undefined)?.method === 'POST',
      );
      expect(submits.length).toBe(2);
    });
  });

  it('routes a validation-gate failure back to the Verify lens with findings loaded (MFX-46.2)', async () => {
    await advanceToReview(mockFetch({ jobFailure: 'validation' }), 'openapi');
    fireEvent.click(screen.getByTestId('export-studio-generate'));

    const failure = await screen.findByTestId('generate-failure');
    expect(failure).toHaveAttribute('data-failure-class', 'validation');
    expect(screen.getByTestId('generate-validation-summary')).toHaveTextContent('1 validation finding');

    // "Review in Verify" jumps back to the Verify step with the validator's findings loaded.
    fireEvent.click(screen.getByTestId('generate-failure-action'));
    expect(screen.getByTestId('verify-gate-failure-notice')).toBeInTheDocument();
    expect(screen.getByTestId('verify-verdict')).toHaveAttribute('data-verdict', 'invalid');
    const panel = screen.getByTestId('verify-panel-validation');
    expect(within(panel).getByTestId('verify-validation-findings')).toHaveTextContent(
      'Field number 0 is not allowed.',
    );
    // The gate re-locks: Generate cannot proceed until the user re-verifies.
    expect(screen.getByRole('button', { name: /continue to review/i })).toBeDisabled();
  });

  it('re-verifies to clear a validation-gate override (MFX-46.2)', async () => {
    // The failing job routes to Verify; a fresh (clean) verify run clears the override and unlocks.
    const fetchMock = mockFetch({ jobFailure: 'validation' });
    await advanceToReview(fetchMock, 'openapi');
    fireEvent.click(screen.getByTestId('export-studio-generate'));
    fireEvent.click(await screen.findByTestId('generate-failure-action')); // → verify (invalid)

    fireEvent.click(screen.getByTestId('verify-rerun'));
    await waitFor(() =>
      expect(screen.getByTestId('verify-verdict')).toHaveAttribute('data-verdict', 'clean'),
    );
    expect(screen.queryByTestId('verify-gate-failure-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to review/i })).toBeEnabled();
  });

  it('acknowledges a severe conversion and re-submits confirmed (MFX-46.2)', async () => {
    // The transcoding guard can flag a severe conversion even when Verify passed clean: the first
    // (unconfirmed) submit fails, and acknowledging re-submits it with confirmation.
    const fetchMock = mockFetch({ jobFailure: 'confirmation' });
    await advanceToReview(fetchMock, 'openapi');
    fireEvent.click(screen.getByTestId('export-studio-generate'));

    const failure = await screen.findByTestId('generate-failure');
    expect(failure).toHaveAttribute('data-failure-class', 'confirmation');
    expect(screen.getByTestId('generate-guard-reasons')).toHaveTextContent('Drops all response types');

    fireEvent.click(screen.getByTestId('generate-failure-action')); // Acknowledge & generate
    // The re-submit carries confirm:true, so the guard passes and the artifact is produced.
    await waitFor(() => expect(screen.getByTestId('export-artifact-preview')).toBeInTheDocument());
    const submits = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/api/export/jobs') &&
        (init as { method?: string } | undefined)?.method === 'POST',
    );
    expect(JSON.parse((submits[submits.length - 1][1] as { body: string }).body).confirm).toBe(true);
  });

  it('resumes a finished job when the Studio is reopened for the same source (MFX-46.2 acceptance #3)', async () => {
    const fetchMock = mockFetch();
    const utils = await renderStudio(fetchMock, { initialTarget: 'openapi' });
    fireEvent.click(screen.getByRole('button', { name: /choose target/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → options
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // → verify
    fireEvent.click(screen.getByTestId('verify-run'));
    await waitFor(() => expect(screen.getByTestId('verify-verdict')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));
    fireEvent.click(screen.getByTestId('export-studio-generate'));
    await waitFor(() => expect(screen.getByTestId('export-artifact-preview')).toBeInTheDocument());

    // Leave the Studio, then reopen it for the same source with NO deep-link target: the tracked
    // job resumes — the Studio lands back on Review with the generated artifact, no re-generate.
    utils.unmount();
    render(<ExportStudio artifact="proj-petstore" artifactLabel="Pet Store API" version="rev-1" />);
    await waitFor(() => expect(screen.getByTestId('export-artifact-preview')).toBeInTheDocument());
    expect(screen.queryByTestId('export-studio-generate')).not.toBeInTheDocument();
  });
});
