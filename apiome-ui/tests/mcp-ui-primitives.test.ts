/**
 * Shared MCP UI primitives — pure helper tests (V2-MCP-24.7 / MCAT-10.7).
 *
 * Locks down the design-token mappings the primitive components render from: grade glyph styling,
 * the transport / visibility / auth / capability-annotation badge resolvers, health-status
 * resolution, relative-time formatting, and the canonical detail-tab set.
 */
import {
  mcpNormalizeGrade,
  mcpGradeGlyphStyle,
  mcpTransportBadge,
  mcpPublishedBadge,
  mcpVisibilityBadge,
  mcpAuthBadge,
  mcpCapabilityAnnotationBadge,
  mcpLifecycleBadge,
  mcpProvenanceAddedViaBadge,
  mcpProvenanceTriggerBadge,
  MCP_CAPABILITY_ANNOTATION_ORDER,
  mcpHealthFromDiscoveryStatus,
  mcpHealthMeta,
  mcpRelativeTime,
  MCP_LINT_TIER_LABEL,
  MCP_DETAIL_TABS,
} from '../src/app/components/ade/dashboard/mcp/mcpUiPrimitives';

describe('mcpNormalizeGrade', () => {
  it.each([
    ['A', 'A'],
    ['b', 'B'],
    ['  c  ', 'C'],
    ['D', 'D'],
    ['f', 'F'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(mcpNormalizeGrade(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'G', 'A+', 'pass'])('returns null for %p', (input) => {
    expect(mcpNormalizeGrade(input as string | null | undefined)).toBeNull();
  });
});

describe('mcpGradeGlyphStyle', () => {
  // Since HIVE-2.4 (#5283) the bands are the shared ones in `ui/statusVocabulary`, so the
  // glyph paints from Hive tokens rather than from the Tailwind palette. The band *order* is
  // what these assert — A is the ok tone through to F on danger.
  it('paints each letter with its shared band fill', () => {
    expect(mcpGradeGlyphStyle('A').chipClass).toContain('bg-ok');
    expect(mcpGradeGlyphStyle('B').chipClass).toContain('var(--ok)');
    expect(mcpGradeGlyphStyle('C').chipClass).toContain('bg-warn');
    expect(mcpGradeGlyphStyle('D').chipClass).toContain('bg-orange');
    expect(mcpGradeGlyphStyle('F').chipClass).toContain('bg-danger');
  });

  it('places each band in the wider status vocabulary', () => {
    expect(mcpGradeGlyphStyle('A').tone).toBe('ok');
    expect(mcpGradeGlyphStyle('C').tone).toBe('warn');
    expect(mcpGradeGlyphStyle('D').tone).toBe('orange');
    expect(mcpGradeGlyphStyle('F').tone).toBe('danger');
  });

  it('exposes the resolved letter and matching ring/text tints', () => {
    const a = mcpGradeGlyphStyle('a');
    expect(a.letter).toBe('A');
    expect(a.ringClass).toBe('text-ok');
    expect(a.textClass).toBe('text-ok-fg');
  });

  it('falls back to a neutral unscored glyph for unknown/absent grades', () => {
    const unscored = mcpGradeGlyphStyle(null);
    expect(unscored.letter).toBeNull();
    expect(unscored.tone).toBe('outline');
    // A well, not a sixth (worse) grade.
    expect(unscored.chipClass).toContain('bg-inset');
  });
});

describe('mcpTransportBadge', () => {
  it('renders the modern transport as a neutral slate chip', () => {
    expect(mcpTransportBadge('streamable_http')).toEqual({ tone: 'slate', label: 'streamable_http' });
    expect(mcpTransportBadge('streamable-http').label).toBe('streamable_http');
  });

  it('labels the SSE transport as legacy', () => {
    expect(mcpTransportBadge('http+sse')).toEqual({ tone: 'slate', label: 'http+sse (legacy)' });
    expect(mcpTransportBadge('sse').label).toBe('http+sse (legacy)');
  });

  it('echoes an unknown transport and never crashes on blank input', () => {
    expect(mcpTransportBadge('quic').label).toBe('quic');
    expect(mcpTransportBadge('').label).toBe('unknown transport');
    expect(mcpTransportBadge(null).tone).toBe('slate');
  });
});

describe('mcpPublishedBadge', () => {
  it('maps published and unpublished endpoints to distinct badges', () => {
    expect(mcpPublishedBadge(true)).toEqual({ tone: 'green', label: 'Published' });
    expect(mcpPublishedBadge(false)).toEqual({ tone: 'slate', label: 'Unpublished' });
  });
});

describe('mcpVisibilityBadge', () => {
  it('maps private to indigo and public to green', () => {
    expect(mcpVisibilityBadge('private')).toEqual({ tone: 'violet', label: 'Private' });
    expect(mcpVisibilityBadge('PUBLIC')).toEqual({ tone: 'green', label: 'Public' });
  });

  it('falls back to a neutral chip for unknown visibility', () => {
    expect(mcpVisibilityBadge('shadow').tone).toBe('slate');
    expect(mcpVisibilityBadge(null).label).toBe('Unknown');
  });
});

describe('mcpAuthBadge', () => {
  it('maps bearer/header token auth to green', () => {
    expect(mcpAuthBadge('bearer')).toEqual({ tone: 'green', label: 'bearer' });
    expect(mcpAuthBadge('header').tone).toBe('green');
  });

  it('maps OAuth variants to a violet "OAuth 2.1" chip', () => {
    expect(mcpAuthBadge('oauth')).toEqual({ tone: 'violet', label: 'OAuth 2.1' });
    expect(mcpAuthBadge('oauth_2_1').label).toBe('OAuth 2.1');
  });

  it('treats absent/none auth as a neutral "No auth" chip', () => {
    expect(mcpAuthBadge('none')).toEqual({ tone: 'slate', label: 'No auth' });
    expect(mcpAuthBadge(null).label).toBe('No auth');
  });
});

describe('mcpCapabilityAnnotationBadge', () => {
  it('maps each asserted annotation to its mockup tone', () => {
    expect(mcpCapabilityAnnotationBadge('readOnlyHint', true)).toEqual({ tone: 'green', label: 'readOnly' });
    expect(mcpCapabilityAnnotationBadge('idempotentHint', true)).toEqual({ tone: 'blue', label: 'idempotent' });
    expect(mcpCapabilityAnnotationBadge('destructiveHint', true)).toEqual({ tone: 'red', label: 'destructive' });
    expect(mcpCapabilityAnnotationBadge('openWorldHint', true)).toEqual({ tone: 'amber', label: 'openWorld' });
  });

  it('returns null for a de-asserted hint or an unknown key', () => {
    expect(mcpCapabilityAnnotationBadge('readOnlyHint', false)).toBeNull();
    expect(mcpCapabilityAnnotationBadge('mysteryHint', true)).toBeNull();
  });

  it('orders the annotations per the MCP spec', () => {
    expect(MCP_CAPABILITY_ANNOTATION_ORDER).toEqual([
      'readOnlyHint',
      'idempotentHint',
      'destructiveHint',
      'openWorldHint',
    ]);
  });
});

describe('mcpLifecycleBadge', () => {
  it('maps each detected lifecycle stage to its tone + label (V2-MCP-34.4)', () => {
    expect(mcpLifecycleBadge('deprecated')).toEqual({ tone: 'red', label: 'deprecated' });
    expect(mcpLifecycleBadge('experimental')).toEqual({ tone: 'amber', label: 'experimental' });
    expect(mcpLifecycleBadge('beta')).toEqual({ tone: 'violet', label: 'beta' });
    expect(mcpLifecycleBadge('stable')).toEqual({ tone: 'green', label: 'stable (declared)' });
  });

  it('normalizes case and whitespace before resolving', () => {
    expect(mcpLifecycleBadge('  Deprecated ')).toEqual({ tone: 'red', label: 'deprecated' });
  });

  it('renders no badge for "unspecified" — silence must never read as stable', () => {
    expect(mcpLifecycleBadge('unspecified')).toBeNull();
    expect(mcpLifecycleBadge(null)).toBeNull();
    expect(mcpLifecycleBadge(undefined)).toBeNull();
    expect(mcpLifecycleBadge('')).toBeNull();
    expect(mcpLifecycleBadge('mystery-stage')).toBeNull();
  });
});

describe('mcpProvenanceTriggerBadge', () => {
  it('maps each discovery-run origin to its tone + label (V2-MCP-34.5)', () => {
    expect(mcpProvenanceTriggerBadge('manual')).toEqual({ tone: 'blue', label: 'manual run' });
    expect(mcpProvenanceTriggerBadge('sweep')).toEqual({ tone: 'indigo', label: 'scheduled sweep' });
    expect(mcpProvenanceTriggerBadge('registry')).toEqual({
      tone: 'violet',
      label: 'registry refresh',
    });
  });

  it('normalizes case and whitespace before resolving', () => {
    expect(mcpProvenanceTriggerBadge('  Sweep ')).toEqual({
      tone: 'indigo',
      label: 'scheduled sweep',
    });
  });

  it('resolves missing/unknown origins to the neutral "unrecorded" chip, never a concrete one', () => {
    const unrecorded = { tone: 'slate', label: 'unrecorded' };
    expect(mcpProvenanceTriggerBadge(null)).toEqual(unrecorded);
    expect(mcpProvenanceTriggerBadge(undefined)).toEqual(unrecorded);
    expect(mcpProvenanceTriggerBadge('')).toEqual(unrecorded);
    expect(mcpProvenanceTriggerBadge('mystery-source')).toEqual(unrecorded);
  });
});

describe('mcpProvenanceAddedViaBadge', () => {
  it('maps each catalog-entry origin to its tone + label (V2-MCP-34.5)', () => {
    expect(mcpProvenanceAddedViaBadge('manual')).toEqual({ tone: 'blue', label: 'added manually' });
    expect(mcpProvenanceAddedViaBadge('registry')).toEqual({
      tone: 'violet',
      label: 'added from registry',
    });
    expect(mcpProvenanceAddedViaBadge('import')).toEqual({
      tone: 'indigo',
      label: 'added via import',
    });
  });

  it('defaults an absent value to manual (the DB default) and shows an unknown one verbatim', () => {
    expect(mcpProvenanceAddedViaBadge(null)).toEqual({ tone: 'blue', label: 'added manually' });
    expect(mcpProvenanceAddedViaBadge(undefined)).toEqual({ tone: 'blue', label: 'added manually' });
    expect(mcpProvenanceAddedViaBadge('federation')).toEqual({
      tone: 'slate',
      label: 'added via federation',
    });
  });
});

describe('mcpHealthFromDiscoveryStatus', () => {
  it.each([
    ['ok', 'healthy'],
    ['success', 'healthy'],
    // Discovery engine / auto-refresh sweep stamps these on successful runs.
    ['changed', 'healthy'],
    ['unchanged', 'healthy'],
    ['degraded', 'degraded'],
    ['partial', 'degraded'],
    ['partial_page', 'degraded'],
    ['failed', 'unreachable'],
    ['timeout', 'unreachable'],
    ['connect_error', 'unreachable'],
    ['connect_timeout', 'unreachable'],
    ['auth_required', 'unreachable'],
  ])('maps %p to %p', (input, expected) => {
    expect(mcpHealthFromDiscoveryStatus(input)).toBe(expected);
  });

  it('treats an absent status as unknown and an unrecognized one as unreachable', () => {
    expect(mcpHealthFromDiscoveryStatus(null)).toBe('unknown');
    expect(mcpHealthFromDiscoveryStatus('')).toBe('unknown');
    expect(mcpHealthFromDiscoveryStatus('weird')).toBe('unreachable');
  });

  it('exposes a colored dot + label per state, from the shared vocabulary', () => {
    // HIVE-2.4 (#5283): the tone is whatever the vocabulary says that state is, so a degraded
    // endpoint is the same amber as a degraded anything-else.
    expect(mcpHealthMeta('healthy').tone).toBe('ok');
    expect(mcpHealthMeta('healthy').dotClass).toBe('bg-ok');
    expect(mcpHealthMeta('degraded').tone).toBe('warn');
    expect(mcpHealthMeta('degraded').dotClass).toBe('bg-warn');
    expect(mcpHealthMeta('unreachable').tone).toBe('danger');
    expect(mcpHealthMeta('unreachable').dotClass).toBe('bg-danger');
    expect(mcpHealthMeta('unknown').tone).toBe('neutral');
    expect(mcpHealthMeta('unknown').label).toBe('Unknown');
  });
});

describe('mcpRelativeTime', () => {
  const now = Date.parse('2026-06-27T12:00:00Z');

  it('returns "never" for absent or unparseable timestamps', () => {
    expect(mcpRelativeTime(null, now)).toBe('never');
    expect(mcpRelativeTime('not-a-date', now)).toBe('never');
  });

  it('describes sub-day spans compactly', () => {
    expect(mcpRelativeTime('2026-06-27T11:59:30Z', now)).toBe('just now');
    expect(mcpRelativeTime('2026-06-27T11:55:00Z', now)).toBe('5m ago');
    expect(mcpRelativeTime('2026-06-27T10:00:00Z', now)).toBe('2h ago');
  });

  it('describes day spans and falls back to a date past ~30 days', () => {
    expect(mcpRelativeTime('2026-06-24T12:00:00Z', now)).toBe('3d ago');
    // 60 days earlier → absolute date string (not a relative span).
    expect(mcpRelativeTime('2026-04-28T12:00:00Z', now)).not.toMatch(/ago/);
  });
});

describe('detail tab + tier constants', () => {
  it('defines the canonical detail tab strip in mockup order', () => {
    expect(MCP_DETAIL_TABS.map((t) => t.value)).toEqual([
      'overview',
      'capabilities',
      'insight',
      'versions',
      'lint',
      'test',
      'credentials',
      'settings',
    ]);
    expect(MCP_DETAIL_TABS.find((t) => t.value === 'lint')?.label).toBe('Lint & Score');
    expect(MCP_DETAIL_TABS.find((t) => t.value === 'insight')?.label).toBe('Insight');
  });

  it('labels the requirement tiers MUST / SHOULD / Advisory', () => {
    expect(MCP_LINT_TIER_LABEL).toEqual({ must: 'MUST', should: 'SHOULD', advisory: 'Advisory' });
  });
});
