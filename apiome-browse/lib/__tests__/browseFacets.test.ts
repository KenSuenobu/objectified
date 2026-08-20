import { describe, expect, it } from 'vitest';
import {
  BROWSE_PARADIGMS,
  NO_FACET_SELECTION,
  computeFacetOptions,
  describeFacetSelection,
  facetLabel,
  filterByFacets,
  formatLabel,
  hasFacetSelection,
  normalizeFacetValue,
  paradigmLabel,
  toggleFacet,
  type FacetedEntity,
} from '../browseFacets';
import { FORMAT_PARADIGMS } from '../generated/formatCounts';

/** A directory row with the given paradigms (stored as `protocols`) and formats. */
function entity(protocols: string[] | null, formats: string[] | null): FacetedEntity & { id: string } {
  return { id: `${protocols?.join('+') ?? '-'}/${formats?.join('+') ?? '-'}`, protocols, formats };
}

describe('normalizeFacetValue', () => {
  it('trims and lower-cases', () => {
    expect(normalizeFacetValue('  Data_Schema ')).toBe('data_schema');
  });

  it('folds blank input to null', () => {
    expect(normalizeFacetValue('')).toBeNull();
    expect(normalizeFacetValue('   ')).toBeNull();
    expect(normalizeFacetValue(null)).toBeNull();
    expect(normalizeFacetValue(undefined)).toBeNull();
  });
});

describe('paradigmLabel', () => {
  it('labels every canonical paradigm', () => {
    for (const paradigm of BROWSE_PARADIGMS) {
      expect(paradigmLabel(paradigm.id)).toBe(paradigm.label);
    }
  });

  it('labels data_schema readably', () => {
    expect(paradigmLabel('data_schema')).toBe('Data schema');
    expect(paradigmLabel('DATA_SCHEMA')).toBe('Data schema');
  });

  it('falls back to the raw value for an unknown paradigm', () => {
    expect(paradigmLabel('telepathy')).toBe('telepathy');
    expect(paradigmLabel('')).toBe('');
  });
});

describe('formatLabel', () => {
  it('labels a known format key', () => {
    expect(formatLabel('graphql')).toBe('GraphQL');
    expect(formatLabel('protobuf')).toBe('gRPC / Protobuf');
    expect(formatLabel('k8s-crd')).toBe('Kubernetes CRD');
  });

  it('keeps versioned keys distinguishable', () => {
    expect(formatLabel('openapi-3.0')).toBe('OpenAPI 3.0');
    expect(formatLabel('openapi-3.1')).toBe('OpenAPI 3.1');
    expect(formatLabel('swagger-2.0')).toBe('Swagger 2.0');
    expect(formatLabel('asyncapi-3')).toBe('AsyncAPI 3');
  });

  it('keeps multi-part versions intact', () => {
    expect(formatLabel('json-schema-2020-12')).toBe('JSON Schema 2020-12');
  });

  it('does not split keys that merely end in digits', () => {
    expect(formatLabel('iso20022')).toBe('ISO 20022');
    expect(formatLabel('hl7v2')).toBe('HL7 v2');
    expect(formatLabel('asn1')).toBe('ASN.1');
  });

  it('falls back to the raw key', () => {
    expect(formatLabel('brand-new-format')).toBe('brand-new-format');
    expect(formatLabel('')).toBe('');
  });
});

describe('facetLabel', () => {
  it('routes to the right axis', () => {
    expect(facetLabel('paradigm', 'rest')).toBe('REST');
    expect(facetLabel('format', 'wsdl')).toBe('WSDL');
  });
});

describe('computeFacetOptions', () => {
  const entities = [
    entity(['rest'], ['openapi-3.1']),
    entity(['rest', 'event'], ['openapi-3.1', 'asyncapi-3']),
    entity(['graph'], ['graphql']),
    entity([], []),
  ];

  it('counts an entry once per distinct value it carries', () => {
    const options = computeFacetOptions(entities, 'paradigm');
    expect(options).toEqual([
      { value: 'rest', label: 'REST', count: 2 },
      { value: 'event', label: 'Event-driven', count: 1 },
      { value: 'graph', label: 'Graph', count: 1 },
    ]);
  });

  it('orders paradigms by the canonical paradigm order, not by count', () => {
    const options = computeFacetOptions(
      [entity(['graph'], null), entity(['graph'], null), entity(['rest'], null)],
      'paradigm'
    );
    expect(options.map((o) => o.value)).toEqual(['rest', 'graph']);
  });

  it('orders formats by descending count, then value', () => {
    const options = computeFacetOptions(entities, 'format');
    expect(options.map((o) => o.value)).toEqual(['openapi-3.1', 'asyncapi-3', 'graphql']);
    expect(options[0]).toEqual({ value: 'openapi-3.1', label: 'OpenAPI 3.1', count: 2 });
  });

  it('sorts unknown paradigms after the canonical ones', () => {
    const options = computeFacetOptions(
      [entity(['telepathy'], null), entity(['abacus'], null), entity(['rpc'], null)],
      'paradigm'
    );
    expect(options.map((o) => o.value)).toEqual(['rpc', 'abacus', 'telepathy']);
  });

  it('normalizes and de-duplicates row values', () => {
    const options = computeFacetOptions([entity([' REST ', 'rest'], null)], 'paradigm');
    expect(options).toEqual([{ value: 'rest', label: 'REST', count: 1 }]);
  });

  it('tolerates missing / null columns', () => {
    expect(computeFacetOptions([{}, { protocols: null, formats: undefined }], 'paradigm')).toEqual([]);
    expect(computeFacetOptions([], 'format')).toEqual([]);
  });
});

describe('filterByFacets', () => {
  const rest = entity(['rest'], ['openapi-3.1']);
  const multi = entity(['rest', 'event'], ['openapi-3.1', 'asyncapi-3']);
  const graph = entity(['graph'], ['graphql']);
  const untagged = entity(null, null);
  const all = [rest, multi, graph, untagged];

  it('returns everything when nothing is selected', () => {
    expect(filterByFacets(all, NO_FACET_SELECTION)).toEqual(all);
  });

  it('matches when any of the entry values matches', () => {
    expect(filterByFacets(all, { paradigm: 'event', format: null })).toEqual([multi]);
  });

  it('composes the two axes with AND', () => {
    expect(filterByFacets(all, { paradigm: 'rest', format: 'asyncapi-3' })).toEqual([multi]);
    expect(filterByFacets(all, { paradigm: 'graph', format: 'openapi-3.1' })).toEqual([]);
  });

  it('normalizes the selection before comparing', () => {
    expect(filterByFacets(all, { paradigm: '  REST ', format: null })).toEqual([rest, multi]);
  });

  it('excludes rows with no facet values once an axis is selected', () => {
    expect(filterByFacets(all, { paradigm: 'rest', format: null })).not.toContain(untagged);
  });

  it('narrows to nothing for an unknown value instead of throwing', () => {
    expect(filterByFacets(all, { paradigm: 'telepathy', format: null })).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = [...all];
    filterByFacets(input, { paradigm: 'rest', format: null });
    expect(input).toEqual(all);
  });
});

describe('toggleFacet', () => {
  it('selects a value on an empty axis', () => {
    expect(toggleFacet(NO_FACET_SELECTION, 'paradigm', 'rest')).toEqual({
      paradigm: 'rest',
      format: null,
    });
  });

  it('clears the axis when the active value is clicked again', () => {
    expect(toggleFacet({ paradigm: 'rest', format: null }, 'paradigm', 'rest')).toEqual({
      paradigm: null,
      format: null,
    });
  });

  it('replaces a different value on the same axis', () => {
    expect(toggleFacet({ paradigm: 'rest', format: null }, 'paradigm', 'rpc')).toEqual({
      paradigm: 'rpc',
      format: null,
    });
  });

  it('leaves the other axis untouched', () => {
    expect(toggleFacet({ paradigm: 'rest', format: 'openapi-3.1' }, 'format', 'graphql')).toEqual({
      paradigm: 'rest',
      format: 'graphql',
    });
  });

  it('does not mutate the input selection', () => {
    const selection = { paradigm: 'rest', format: null };
    toggleFacet(selection, 'paradigm', 'rpc');
    expect(selection).toEqual({ paradigm: 'rest', format: null });
  });
});

describe('hasFacetSelection', () => {
  it('is false for the empty selection', () => {
    expect(hasFacetSelection(NO_FACET_SELECTION)).toBe(false);
    expect(hasFacetSelection({ paradigm: '  ', format: '' })).toBe(false);
  });

  it('is true when either axis is narrowed', () => {
    expect(hasFacetSelection({ paradigm: 'rest', format: null })).toBe(true);
    expect(hasFacetSelection({ paradigm: null, format: 'graphql' })).toBe(true);
  });
});

describe('describeFacetSelection', () => {
  it('summarizes both axes with labels', () => {
    expect(describeFacetSelection({ paradigm: 'rest', format: 'openapi-3.1' })).toBe(
      'REST · OpenAPI 3.1'
    );
  });

  it('summarizes a single axis', () => {
    expect(describeFacetSelection({ paradigm: null, format: 'graphql' })).toBe('GraphQL');
  });

  it('is empty when nothing is selected', () => {
    expect(describeFacetSelection(NO_FACET_SELECTION)).toBe('');
  });
});

describe('BROWSE_PARADIGMS (FMT-1.6)', () => {
  it('is the generated canonical vocabulary, not a local copy', () => {
    expect(BROWSE_PARADIGMS).toBe(FORMAT_PARADIGMS);
  });

  it('carries the six paradigms `ApiParadigm` declares, in canonical order', () => {
    expect(BROWSE_PARADIGMS.map((paradigm) => paradigm.id)).toEqual([
      'rest',
      'rpc',
      'event',
      'graph',
      'data_schema',
      'agent',
    ]);
  });

  it('labels every value, so a chip is never blank', () => {
    for (const paradigm of BROWSE_PARADIGMS) {
      expect(paradigm.label.trim()).not.toBe('');
    }
  });

  it('offers a facet value for every paradigm an import can record', () => {
    // The reverse of the drift the vocabulary used to risk: a paradigm the registry produces but
    // the facet cannot offer is a value a visitor can see on a row and never filter by.
    const facetValues = new Set(BROWSE_PARADIGMS.map((paradigm) => paradigm.id));
    for (const paradigm of FORMAT_PARADIGMS) {
      expect(facetValues.has(paradigm.id)).toBe(true);
    }
  });
});
