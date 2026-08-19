/**
 * Unit tests for capability directory helpers (V2-MCP-35.4 / MCAT-21.4, #4663; presets, the two
 * summary lines and the sort resolver added in HIVE-7.9, #5326).
 */

import {
  MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
  MCP_CAPABILITY_DIRECTORY_PRESETS,
  mcpCapabilityDirectoryApplyPreset,
  mcpCapabilityDirectoryDisplayName,
  mcpCapabilityDirectoryEndpointHref,
  mcpCapabilityDirectoryEntryFromPayload,
  mcpCapabilityDirectoryFootLine,
  mcpCapabilityDirectoryFromPayload,
  mcpCapabilityDirectoryKindBadge,
  mcpCapabilityDirectoryPresetCountParams,
  mcpCapabilityDirectoryPresetIsActive,
  mcpCapabilityDirectoryQueryParams,
  mcpCapabilityDirectoryRange,
  mcpCapabilityDirectorySortFromTable,
  type McpCapabilityDirectoryFilters,
} from '../src/app/components/ade/dashboard/mcp/mcpCapabilityDirectoryUi';

describe('mcpCapabilityDirectoryFromPayload', () => {
  it('parses directory rows with owner context', () => {
    const page = mcpCapabilityDirectoryFromPayload({
      success: true,
      total: 1,
      limit: 50,
      offset: 0,
      items: [
        {
          kind: 'tool',
          item_id: 'item-1',
          item_name: 'geocode',
          item_title: 'Geocode',
          description: 'Lookup coordinates',
          endpoint_id: 'ep-1',
          endpoint_name: 'Acme Geo',
          endpoint_slug: 'acme-geo',
          host: 'mcp.acme.example',
          endpoint_url: 'https://mcp.acme.example/sse',
          visibility: 'private',
          grade: 'A',
        },
      ],
    });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.endpointSlug).toBe('acme-geo');
    expect(page.items[0]?.itemName).toBe('geocode');
  });
});

describe('mcpCapabilityDirectoryQueryParams', () => {
  it('builds filter and pagination query params', () => {
    const params = mcpCapabilityDirectoryQueryParams(
      {
        ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
        name: 'geo',
        type: 'tool',
        host: 'mcp.acme.example',
        visibility: 'private',
      },
      'name',
      'desc',
      50,
      25,
    );
    expect(params.get('name')).toBe('geo');
    expect(params.get('type')).toBe('tool');
    expect(params.get('host')).toBe('mcp.acme.example');
    expect(params.get('visibility')).toBe('private');
    expect(params.get('sort')).toBe('name');
    expect(params.get('direction')).toBe('desc');
    expect(params.get('offset')).toBe('50');
    expect(params.get('limit')).toBe('25');
  });
});

describe('mcpCapabilityDirectory helpers', () => {
  it('links to endpoint detail', () => {
    expect(mcpCapabilityDirectoryEndpointHref('ep-1')).toBe('/ade/dashboard/mcp/ep-1');
  });

  it('prefers title for display name', () => {
    const entry = mcpCapabilityDirectoryEntryFromPayload({
      kind: 'prompt',
      item_id: 'p1',
      item_name: 'summarize',
      item_title: 'Summarize text',
      endpoint_id: 'ep-1',
      endpoint_name: 'Writer',
      endpoint_slug: 'writer',
      host: 'writer.example',
      endpoint_url: 'https://writer.example/mcp',
    });
    expect(entry).not.toBeNull();
    expect(mcpCapabilityDirectoryDisplayName(entry!)).toBe('Summarize text');
  });

  it('labels capability kinds', () => {
    expect(mcpCapabilityDirectoryKindBadge('resource_template').label).toBe('Resource template');
  });
});


// ---------------------------------------------------------------------------------------
// Presets (HIVE-7.9, #5326)
// ---------------------------------------------------------------------------------------

describe('the preset tiles', () => {
  /** A preset by id — the suite names them rather than indexing into the list. */
  function preset(id: string) {
    const found = MCP_CAPABILITY_DIRECTORY_PRESETS.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`no preset \`${id}\``);
    return found;
  }

  it('offers four views, each expressible as a directory query', () => {
    expect(MCP_CAPABILITY_DIRECTORY_PRESETS).toHaveLength(4);
    for (const candidate of MCP_CAPABILITY_DIRECTORY_PRESETS) {
      // Every key a preset sets has to be a filter the API serves — this is what stops a tile
      // becoming a client-side filter over a *paged* response, which would be wrong on page two.
      for (const key of Object.keys(candidate.filters)) {
        expect(Object.keys(MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS)).toContain(key);
      }
      expect(mcpCapabilityDirectoryPresetCountParams(candidate).get('limit')).toBe('1');
    }
  });

  it('applies a preset as a whole view rather than as a refinement', () => {
    const narrowed: McpCapabilityDirectoryFilters = {
      ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
      host: 'mcp.acme.dev',
      name: 'search',
    };
    // "Reusable prompt templates" describes the catalog, not one host's slice of it.
    expect(mcpCapabilityDirectoryApplyPreset(preset('prompts'), narrowed)).toEqual({
      ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
      type: 'prompt',
    });
  });

  it('clears back to the unfiltered directory when the active preset is re-applied', () => {
    const active: McpCapabilityDirectoryFilters = {
      ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
      type: 'tool',
    };
    expect(mcpCapabilityDirectoryApplyPreset(preset('tools'), active)).toEqual(
      MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
    );
  });

  it('reads as active only when the filters are exactly its own', () => {
    const exact: McpCapabilityDirectoryFilters = {
      ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
      type: 'tool',
    };
    expect(mcpCapabilityDirectoryPresetIsActive(preset('tools'), exact)).toBe(true);

    // A tile that stayed lit while a host filter narrowed it would describe a set it no longer
    // describes.
    expect(
      mcpCapabilityDirectoryPresetIsActive(preset('tools'), { ...exact, host: 'mcp.acme.dev' }),
    ).toBe(false);
    expect(
      mcpCapabilityDirectoryPresetIsActive(preset('tools'), MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS),
    ).toBe(false);
  });

  it('counts a preset without pulling a page of rows', () => {
    const params = mcpCapabilityDirectoryPresetCountParams(preset('public'));
    expect(params.get('visibility')).toBe('public');
    expect(params.get('limit')).toBe('1');
    expect(params.get('offset')).toBe('0');
  });
});

// ---------------------------------------------------------------------------------------
// The two summary lines
// ---------------------------------------------------------------------------------------

describe('mcpCapabilityDirectoryRange', () => {
  it('states the visible slice of the matched set', () => {
    expect(mcpCapabilityDirectoryRange(0, 8, 8)).toBe('1–8 of 8');
    expect(mcpCapabilityDirectoryRange(50, 50, 120)).toBe('51–100 of 120');
  });

  it('never prints `1–0 of 0` for an empty result', () => {
    expect(mcpCapabilityDirectoryRange(0, 0, 0)).toBe('No capabilities');
  });

  it('clamps the end to the total when the last page is short', () => {
    expect(mcpCapabilityDirectoryRange(100, 20, 120)).toBe('101–120 of 120');
  });
});

describe('mcpCapabilityDirectoryFootLine', () => {
  it('quotes the name term back when there is one', () => {
    expect(
      mcpCapabilityDirectoryFootLine(
        8,
        { ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS, name: 'search' },
        'server',
        'asc',
      ),
    ).toBe('8 capabilities match “search” · page size 50 · sorted by server ascending');
  });

  it('drops the match clause when nothing was searched for', () => {
    expect(
      mcpCapabilityDirectoryFootLine(
        1,
        MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
        'name',
        'desc',
      ),
    ).toBe('1 capability · page size 50 · sorted by capability descending');
  });

  it('states the direction in words, so the sentence stands without the chevron', () => {
    const line = mcpCapabilityDirectoryFootLine(
      3,
      MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
      'type',
      'desc',
    );
    expect(line).toContain('sorted by type descending');
    expect(line).not.toMatch(/[↑↓]/);
  });
});

// ---------------------------------------------------------------------------------------
// The sort resolver
// ---------------------------------------------------------------------------------------

describe('mcpCapabilityDirectorySortFromTable', () => {
  it('passes a real column and direction straight through', () => {
    expect(mcpCapabilityDirectorySortFromTable({ column: 'name', direction: 'desc' })).toEqual({
      sort: 'name',
      direction: 'desc',
    });
  });

  it('resolves the table’s third state to the default order, not to no order', () => {
    // `GET …/capabilities` always orders by one of server/name/type, so an "unsorted" request
    // would still come back `server ascending` — a click that appeared to do nothing.
    expect(mcpCapabilityDirectorySortFromTable(null)).toEqual({ sort: 'server', direction: 'asc' });
  });

  it('falls back to the default column for an id no sort answers to', () => {
    expect(mcpCapabilityDirectorySortFromTable({ column: 'host', direction: 'asc' })).toEqual({
      sort: 'server',
      direction: 'asc',
    });
  });
});
