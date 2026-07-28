/**
 * Render + accessibility tests for `<FormatCapabilityPanel>` (CPDO-2.4, #4796).
 *
 * The panel is the surface the ticket's honesty requirement lands on, so the assertions here are
 * about *what it says*, not how it looks:
 *
 * - a parser limit, an unsupported format and an analyzer failure never render the
 *   "no source material was captured" line — only the one category that genuinely means it does;
 * - the two construct lists are captioned with what a construct's absence from a tree means, so an
 *   unmodelled construct is not read as missing data;
 * - the analyzer key, analyzer version, tool versions, registry version and review date are all on
 *   screen, because a capability claim without its evidence is an opinion;
 * - the structure is navigable: a named region per facet, real headings, a labelled note for the
 *   absence, and every badge carrying its meaning in text rather than in colour alone.
 */

import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FormatCapabilityPanel } from '@/app/components/ade/dashboard/catalog/FormatCapabilityPanel';
import type {
  AbsenceExplanation,
  FormatCapability,
} from '@/app/components/ade/dashboard/catalog/formatCapabilityRegistry';

const X12: FormatCapability = {
  format: 'edix12',
  label: 'EDI X12',
  paradigm: 'data_schema',
  provenance: 'reviewed',
  availability: 'available',
  unavailable_reason: null,
  native_hierarchy: 'native',
  native_hierarchy_note: 'Interchange → functional group → transaction set → segment → element.',
  analyzer: { key: 'edix12', version: '1.0.0', tool_versions: { pyx12: '4.0.1' } },
  source_location: { quality: 'path_only', note: 'Envelope path and sibling ordinal only.' },
  value_visibility: {
    default: 'structural',
    maximum: 'full',
    note: 'Element values are observed; the default keeps presence and length.',
  },
  supported_constructs: ['x12.functional_group', 'x12.segment'],
  unsupported_constructs: ['x12.hl_hierarchy', 'x12.repeating_elements'],
  limits: { maxNodes: 5000, maxDepth: 32 },
  canonical_projection: {
    coverage: 'partial',
    dropped_constructs: ['x12.interchange_envelope'],
    note: 'Normalization reads the first functional group’s first transaction set.',
  },
  conversion: {
    support: 'supported',
    canonical_formats: ['edix12'],
    normalizes_in_adapter: false,
    declared_formats: ['edi', 'edix12', 'x12'],
    note: 'Reaches the canonical model through edix12.',
  },
  notes: ['HL loops are described as the segments they are, not as the hierarchy they encode.'],
  registry_version: '1',
  review_date: '2026-07-28',
};

const PARSE_LIMIT: AbsenceExplanation = {
  category: 'parse_limit',
  category_label: 'Parser limit',
  summary_template:
    "apiome's analyzer for this format does not describe {construct}; the source may well contain it.",
  remediation: 'This is an apiome parser limitation — read the original source to confirm.',
  source_missing: false,
};

const SOURCE_MISSING: AbsenceExplanation = {
  category: 'source_missing',
  category_label: 'Source not captured',
  summary_template:
    'No source material was captured for this revision, so there is nothing to analyse for {construct}.',
  remediation: 'Re-import the item so its source is captured.',
  source_missing: true,
};

const UNAFFECTED = /source material is unaffected/i;
const NOT_CAPTURED = /no source material was captured for this revision\./i;

describe('FormatCapabilityPanel — evidence', () => {
  it('names the analyzer, its version and the tool versions behind the claims', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    expect(screen.getByText('edix12@1.0.0')).toBeInTheDocument();
    expect(screen.getByText('pyx12 4.0.1')).toBeInTheDocument();
  });

  it('stamps the registry version and review date', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    expect(screen.getByText(/Capability registry v1 · reviewed 2026-07-28/)).toBeInTheDocument();
  });

  it('renders the reviewed boundary notes', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    expect(screen.getByText(/HL loops are described as the segments they are/)).toBeInTheDocument();
  });

  it('renders the numeric parsing limits with human labels', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    const limits = screen.getByRole('region', { name: 'Parsing limits' });
    expect(within(limits).getByText('Nodes kept')).toBeInTheDocument();
    expect(within(limits).getByText('5,000')).toBeInTheDocument();
  });
});

describe('FormatCapabilityPanel — construct lists', () => {
  it('captions the modelled list with what an absence there means', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    const modelled = screen.getByRole('region', { name: 'Modelled' });
    expect(within(modelled).getByText(/the source did not contain it/i)).toBeInTheDocument();
    expect(within(modelled).getByText('x12.segment')).toBeInTheDocument();
  });

  it('captions the unmodelled list so it is never read as missing data', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    const unmodelled = screen.getByRole('region', { name: /not modelled/i });
    expect(
      within(unmodelled).getByText(/says nothing about the source, which may well contain them/i),
    ).toBeInTheDocument();
    expect(within(unmodelled).getByText('x12.hl_hierarchy')).toBeInTheDocument();
  });

  it('states plainly when an analyzer declares no unreadable grammar', () => {
    render(
      <FormatCapabilityPanel capability={{ ...X12, unsupported_constructs: [] }} />,
    );
    const unmodelled = screen.getByRole('region', { name: /not modelled/i });
    expect(
      within(unmodelled).getByText(/declares no grammar it cannot read/i),
    ).toBeInTheDocument();
  });
});

describe('FormatCapabilityPanel — absence wording', () => {
  it('renders no absence block when the analysis is available', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    expect(screen.queryByRole('note', { name: /why this detail is missing/i })).toBeNull();
  });

  it('renders a parser limit without claiming the source is missing', () => {
    render(
      <FormatCapabilityPanel
        capability={X12}
        absence={PARSE_LIMIT}
        absenceConstruct="x12.hl_hierarchy"
      />,
    );
    const note = screen.getByRole('note', { name: /why this detail is missing/i });
    expect(within(note).getByText('Parser limit')).toBeInTheDocument();
    expect(within(note).getByText(/`x12.hl_hierarchy`/)).toBeInTheDocument();
    expect(within(note).getByText(UNAFFECTED)).toBeInTheDocument();
    expect(within(note).queryByText(NOT_CAPTURED)).toBeNull();
  });

  it.each([
    ['format_unsupported', 'Format not analysed'],
    ['analyzer_failed', 'Analysis failed'],
    ['value_redacted', 'Value withheld'],
    ['not_analyzed', 'Not analysed yet'],
    ['undeclared', 'No statement'],
    ['absent_in_source', 'Not in the source'],
  ] as const)(
    'never claims the source is missing for the %s category',
    (category, label) => {
      const absence: AbsenceExplanation = {
        category,
        category_label: label,
        summary_template: 'Something about {construct}.',
        remediation: 'Guidance.',
        source_missing: false,
      };
      render(<FormatCapabilityPanel capability={X12} absence={absence} />);
      const note = screen.getByRole('note', { name: /why this detail is missing/i });
      expect(within(note).getByText(label)).toBeInTheDocument();
      expect(within(note).getByText(UNAFFECTED)).toBeInTheDocument();
      expect(within(note).queryByText(NOT_CAPTURED)).toBeNull();
    },
  );

  it('does say the source was not captured for the one category that means it', () => {
    render(
      <FormatCapabilityPanel capability={X12} absence={SOURCE_MISSING} absenceConstruct="x12.segment" />,
    );
    const note = screen.getByRole('note', { name: /why this detail is missing/i });
    expect(within(note).getByText(NOT_CAPTURED)).toBeInTheDocument();
    expect(within(note).queryByText(UNAFFECTED)).toBeNull();
  });

  it('reads without a construct when none is named', () => {
    render(<FormatCapabilityPanel capability={X12} absence={PARSE_LIMIT} />);
    const note = screen.getByRole('note', { name: /why this detail is missing/i });
    expect(within(note).getByText(/this detail/)).toBeInTheDocument();
    expect(within(note).queryByText(/\{construct\}/)).toBeNull();
  });
});

describe('FormatCapabilityPanel — availability and accessibility', () => {
  it('exposes the whole panel as a region named for the format', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    expect(
      screen.getByRole('region', { name: /EDI X12 — what apiome records/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /EDI X12 — what apiome records/, level: 3 }),
    ).toBeInTheDocument();
  });

  it('carries each badge’s meaning in text, with a screen-reader label for the field', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    expect(screen.getByText('Reviewed')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Entry provenance:')).toBeInTheDocument();
    expect(screen.getByText('Availability:')).toBeInTheDocument();
  });

  it('states an unavailable toolchain rather than hiding it', () => {
    render(
      <FormatCapabilityPanel
        capability={{
          ...X12,
          availability: 'tool_unavailable',
          unavailable_reason: 'Requires the asyncapi-parser toolchain, which is not available.',
        }}
      />,
    );
    expect(screen.getByText('Toolchain unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Requires the asyncapi-parser toolchain/)).toBeInTheDocument();
  });

  it('renders an unknown format as claiming nothing, without crashing', () => {
    render(
      <FormatCapabilityPanel
        capability={{
          ...X12,
          format: 'retired-format',
          label: 'retired-format',
          provenance: 'unknown_format',
          availability: 'unregistered',
          unavailable_reason: 'No import-source adapter is registered under this format key.',
          native_hierarchy: 'none',
          source_location: { quality: 'none', note: 'No analyzer runs for this format.' },
          value_visibility: { default: 'structural', maximum: 'none', note: 'Nothing is observed.' },
          supported_constructs: [],
          unsupported_constructs: [],
          limits: {},
          canonical_projection: { coverage: 'none', dropped_constructs: [], note: 'Not normalized.' },
          conversion: {
            support: 'unsupported',
            canonical_formats: [],
            normalizes_in_adapter: false,
            declared_formats: [],
            note: 'No conversion route.',
          },
        }}
      />,
    );
    expect(screen.getByText('Unknown format')).toBeInTheDocument();
    expect(screen.getByText('Not registered')).toBeInTheDocument();
    expect(screen.getByText('No structure recorded')).toBeInTheDocument();
    expect(screen.getByText('No value material')).toBeInTheDocument();
    expect(screen.getByText(/This analyzer names no format constructs/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Parsing limits' })).toBeNull();
  });

  it('names the projection coverage and the constructs normalization drops', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    const projection = screen.getByRole('region', { name: /canonical projection/i });
    expect(within(projection).getByText('Partially projected')).toBeInTheDocument();
    expect(within(projection).getByText('x12.interchange_envelope')).toBeInTheDocument();
  });

  it('names the conversion route', () => {
    render(<FormatCapabilityPanel capability={X12} />);
    const conversion = screen.getByRole('region', { name: /^conversion$/i });
    expect(
      within(conversion).getByText('Converts to every export target'),
    ).toBeInTheDocument();
  });
});
