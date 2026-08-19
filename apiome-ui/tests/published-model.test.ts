/**
 * The decisions the Published surface makes (HIVE-8.1, #5327).
 *
 * `published-hive-redesign.test.tsx` renders the screen and `published-css.test.ts` pins the
 * declarations; this holds the rules, which are pure functions over plain data and therefore
 * testable without a DOM, a database or a clock.
 *
 * What it pins is the ticket's four acceptance criteria seen from the rules' side:
 *
 *   1. **Access URLs are correct per tenant slug** — one path builder, four viewers, and the
 *      `api_key` parameter appended without ever producing a second `?`.
 *   2. **Private-version viewing still requires and offers a key** — the gate on the View
 *      fly-out is the *absence of a live key*, not the mere fact of being private, and an
 *      expired or disabled key does not count as one.
 *   3. **Deprecated published versions carry their badge** — derived from stored metadata the
 *      same way REST's `effective_lifecycle` derives it, in every spelling the flag is written.
 *   4. **The visibility confirm keeps the mockup's exact copy**, in both directions.
 */

import {
  API_KEYS_HREF,
  PRIVATE_NEEDS_KEY_TITLE,
  SUNSET_TIMELINE_HREF,
  VERSIONS_HREF,
  hasUsableApiKey,
  isApiKeyUsable,
  isPublishedListFiltered,
  nextVisibility,
  publishedAccessLabel,
  publishedAccessPath,
  publishedFootLabel,
  publishedLifecycle,
  publishedLifecyclePill,
  publishedRowLabel,
  publishedRowMenuItems,
  publishedSummaryLine,
  publishedViewItems,
  publishedViewUrl,
  searchPublishedVersions,
  visibilityChangedToast,
  visibilityConfirm,
  visibilityErrorMessage,
  visibilityToggleTooltip,
  withApiKey,
  type PublishedVersion,
} from '../src/app/components/ade/published/publishedModel';
import { lifecycleFromMetadata } from '../src/app/components/ade/versions/versionsModel';

// ---------------------------------------------------------------------------------------
// Fixtures — the four rows the mockup draws
// ---------------------------------------------------------------------------------------

/**
 * One published revision, with the mockup's Payments 2.3.1 as the default.
 *
 * @param overrides What this row differs by.
 * @returns The row.
 */
function version(overrides: Partial<PublishedVersion> = {}): PublishedVersion {
  return {
    id: 'ver-payments-231',
    version_id: '2.3.1',
    description: 'Card, refund and payout endpoints.',
    visibility: 'public',
    published_at: '2026-08-03T16:05:00.000Z',
    created_at: '2026-08-01T10:00:00.000Z',
    project_id: 'prj-payments',
    project_name: 'Payments API',
    project_slug: 'payments-api',
    tenant_id: 'tnt-acme',
    tenant_name: 'Acme Corp',
    tenant_slug: 'acme',
    creator_name: 'Grace Hopper',
    creator_email: 'grace@acme.io',
    mock_enabled: true,
    metadata: {},
    ...overrides,
  };
}

const REST = 'https://api.example.com/v1';

// ---------------------------------------------------------------------------------------
// Access URLs
// ---------------------------------------------------------------------------------------

describe('access URLs', () => {
  it('addresses a revision by tenant, project and version slugs', () => {
    expect(publishedAccessPath(version())).toBe('acme/payments-api/2.3.1');
  });

  it('follows the tenant slug rather than the tenant name', () => {
    const row = version({ tenant_name: 'Acme Corporation, Inc.', tenant_slug: 'acme-corp' });
    expect(publishedAccessPath(row)).toBe('acme-corp/payments-api/2.3.1');
    expect(publishedAccessLabel(row)).toBe('schema/acme-corp/payments-api/2.3.1');
  });

  it('prints the schema path in the table and the absolute URL for the clipboard', () => {
    expect(publishedAccessLabel(version())).toBe('schema/acme/payments-api/2.3.1');
    expect(publishedViewUrl(REST, version(), 'openapi')).toBe(
      'https://api.example.com/v1/schema/acme/payments-api/2.3.1'
    );
  });

  it.each([
    ['openapi', 'schema'],
    ['arazzo', 'arazzo'],
    ['json', 'json'],
    ['swagger', 'swagger'],
  ] as const)('serves the %s viewer from /%s', (kind, segment) => {
    expect(publishedViewUrl(REST, version(), kind)).toBe(
      `https://api.example.com/v1/${segment}/acme/payments-api/2.3.1`
    );
  });

  it('does not double the separator when the base URL carries a trailing slash', () => {
    expect(publishedViewUrl('https://api.example.com/v1/', version(), 'openapi')).toBe(
      'https://api.example.com/v1/schema/acme/payments-api/2.3.1'
    );
  });
});

describe('withApiKey', () => {
  it('leaves the URL alone when there is no key', () => {
    expect(withApiKey('https://x/y', null)).toBe('https://x/y');
    expect(withApiKey('https://x/y', undefined)).toBe('https://x/y');
    expect(withApiKey('https://x/y', '   ')).toBe('https://x/y');
  });

  it('appends the key as the api_key query parameter', () => {
    expect(withApiKey('https://x/y', 'sk_live_1')).toBe('https://x/y?api_key=sk_live_1');
  });

  it('joins with & when the URL already has a query', () => {
    expect(withApiKey('https://x/y?a=1', 'sk_live_1')).toBe('https://x/y?a=1&api_key=sk_live_1');
  });

  it('trims and percent-encodes the key so it cannot break the query', () => {
    expect(withApiKey('https://x/y', '  sk/live+1  ')).toBe('https://x/y?api_key=sk%2Flive%2B1');
  });
});

// ---------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------

describe('API keys', () => {
  const NOW = new Date('2026-08-19T00:00:00.000Z');

  it('counts an enabled key with no expiry', () => {
    expect(isApiKeyUsable({ id: 'k1', enabled: true, expires_at: null }, NOW)).toBe(true);
  });

  it('does not count a disabled key', () => {
    expect(isApiKeyUsable({ id: 'k1', enabled: false, expires_at: null }, NOW)).toBe(false);
  });

  it('does not count an expired key', () => {
    expect(
      isApiKeyUsable({ id: 'k1', enabled: true, expires_at: '2026-08-18T23:59:00.000Z' }, NOW)
    ).toBe(false);
  });

  it('counts a key that expires later', () => {
    expect(
      isApiKeyUsable({ id: 'k1', enabled: true, expires_at: '2026-09-01T00:00:00.000Z' }, NOW)
    ).toBe(true);
  });

  it('treats an unparseable expiry as no expiry rather than as expired', () => {
    expect(isApiKeyUsable({ id: 'k1', enabled: true, expires_at: 'whenever' }, NOW)).toBe(true);
  });

  it('reports whether the workspace holds any live key', () => {
    expect(hasUsableApiKey([], NOW)).toBe(false);
    expect(
      hasUsableApiKey(
        [
          { id: 'k1', enabled: false, expires_at: null },
          { id: 'k2', enabled: true, expires_at: '2026-01-01T00:00:00.000Z' },
        ],
        NOW
      )
    ).toBe(false);
    expect(
      hasUsableApiKey(
        [
          { id: 'k1', enabled: false, expires_at: null },
          { id: 'k2', enabled: true, expires_at: null },
        ],
        NOW
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

describe('lifecycle', () => {
  it('is stable for a revision with no metadata at all', () => {
    expect(publishedLifecycle(version({ metadata: null }))).toBe('stable');
    expect(publishedLifecycle(version({ metadata: undefined }))).toBe('stable');
    expect(publishedLifecycle(version({ metadata: {} }))).toBe('stable');
  });

  it('honours an explicit lifecycle tag', () => {
    expect(publishedLifecycle(version({ metadata: { lifecycle: 'beta' } }))).toBe('beta');
    expect(publishedLifecycle(version({ metadata: { lifecycle: ' ARCHIVED ' } }))).toBe('archived');
  });

  it('ignores a lifecycle tag that is not one of the four #739 values', () => {
    expect(publishedLifecycle(version({ metadata: { lifecycle: 'retired' } }))).toBe('stable');
  });

  // The SQL expression in `revision_lifecycle.py` matches all of these spellings, so the
  // client-side rule has to as well or the two would disagree about the same row.
  it.each([[true], ['true'], ['1'], ['yes'], ['True']])(
    'infers deprecated from the #507 flag written as %p',
    (flag) => {
      expect(publishedLifecycle(version({ metadata: { deprecated: flag } }))).toBe('deprecated');
    }
  );

  it('lets an explicit tag win over the inferred flag', () => {
    expect(
      publishedLifecycle(version({ metadata: { deprecated: true, lifecycle: 'stable' } }))
    ).toBe('stable');
  });

  it('is the same rule the versions model exports', () => {
    const metadata = { deprecated: true };
    expect(publishedLifecycle(version({ metadata }))).toBe(lifecycleFromMetadata(metadata));
  });
});

describe('the lifecycle pill', () => {
  it('is absent for a stable revision — three of the mockup’s four rows draw none', () => {
    expect(publishedLifecyclePill(version())).toBeNull();
  });

  it('names the sunset instant in UTC when one is scheduled', () => {
    const pill = publishedLifecyclePill(
      version({ metadata: { deprecated: true, sunsetAt: '2026-08-27T00:00:00Z' } })
    );
    expect(pill).not.toBeNull();
    expect(pill?.lifecycle).toBe('deprecated');
    expect(pill?.label).toBe('Deprecated');
    expect(pill?.sunsetLabel).toBe('27 Aug 2026 00:00 UTC');
    expect(pill?.title).toContain('27 Aug 2026 00:00 UTC');
  });

  it('reads the legacy sunsetDate spelling as well', () => {
    const pill = publishedLifecyclePill(
      version({ metadata: { deprecated: true, sunsetDate: '2026-08-27T00:00:00Z' } })
    );
    expect(pill?.sunsetLabel).toBe('27 Aug 2026 00:00 UTC');
  });

  it('still draws for a deprecated revision with no sunset', () => {
    const pill = publishedLifecyclePill(version({ metadata: { deprecated: true } }));
    expect(pill?.sunsetLabel).toBeNull();
    expect(pill?.title).toBe('Deprecated — see the sunset timeline.');
  });
});

// ---------------------------------------------------------------------------------------
// Search and the foot
// ---------------------------------------------------------------------------------------

describe('search', () => {
  const ROWS = [
    version(),
    version({
      id: 'ver-payments-220',
      version_id: '2.2.0',
      description: 'Card tokenisation + 3DS challenge flow.',
      visibility: 'private',
    }),
    version({
      id: 'ver-orders-192',
      version_id: '1.9.2',
      project_name: 'Orders Service',
      project_slug: 'orders-service',
      description: 'Order lifecycle: cart → checkout → fulfilment.',
    }),
  ];

  it('returns every row for an empty or whitespace query', () => {
    expect(searchPublishedVersions(ROWS, '')).toHaveLength(3);
    expect(searchPublishedVersions(ROWS, '   ')).toHaveLength(3);
  });

  it('matches the project name, case-insensitively', () => {
    expect(searchPublishedVersions(ROWS, 'orders')).toHaveLength(1);
    expect(searchPublishedVersions(ROWS, 'ORDERS')).toHaveLength(1);
  });

  it('matches the version label', () => {
    expect(searchPublishedVersions(ROWS, '2.2')).toHaveLength(1);
  });

  it('matches the description', () => {
    expect(searchPublishedVersions(ROWS, 'tokenisation')).toHaveLength(1);
  });

  it('matches the tenant name', () => {
    expect(searchPublishedVersions(ROWS, 'acme corp')).toHaveLength(3);
  });

  it('survives a row with no description', () => {
    expect(searchPublishedVersions([version({ description: null })], 'anything')).toHaveLength(0);
  });

  it('does not mutate or reorder the list it was handed', () => {
    const result = searchPublishedVersions(ROWS, '');
    expect(result).not.toBe(ROWS);
    expect(result.map((row) => row.id)).toEqual(ROWS.map((row) => row.id));
  });
});

describe('the foot', () => {
  it('says how many of how many, with the noun agreeing', () => {
    expect(publishedFootLabel(4, 4)).toBe('Showing 4 of 4 published versions');
    expect(publishedFootLabel(1, 1)).toBe('Showing 1 of 1 published version');
    expect(publishedFootLabel(0, 4)).toBe('Showing 0 of 4 published versions');
  });

  it('marks the list filtered only when a search is actually hiding rows', () => {
    expect(isPublishedListFiltered('', 4, 4)).toBe(false);
    expect(isPublishedListFiltered('payments', 4, 4)).toBe(false);
    expect(isPublishedListFiltered('payments', 2, 4)).toBe(true);
    expect(isPublishedListFiltered('   ', 2, 4)).toBe(false);
  });
});

describe('the summary line', () => {
  it('describes the surface when nothing is published', () => {
    expect(publishedSummaryLine([])).toContain('Published, locked versions');
  });

  it('counts the rows, the public ones and the mocked ones', () => {
    const rows = [
      version(),
      version({ id: 'b', visibility: 'private', mock_enabled: false }),
      version({ id: 'c', visibility: 'private', mock_enabled: true }),
    ];
    expect(publishedSummaryLine(rows)).toBe(
      '3 published versions · 1 public · 2 with a hosted mock'
    );
  });

  it('keeps the noun singular for one row', () => {
    expect(publishedSummaryLine([version()])).toBe(
      '1 published version · 1 public · 1 with a hosted mock'
    );
  });
});

// ---------------------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------------------

describe('visibility', () => {
  it('moves a public revision to private and back', () => {
    expect(nextVisibility(version())).toBe('private');
    expect(nextVisibility(version({ visibility: 'private' }))).toBe('public');
  });

  it('tells the reader which way the click goes', () => {
    expect(visibilityToggleTooltip(version())).toBe('Click to change to private');
    expect(visibilityToggleTooltip(version({ visibility: 'private' }))).toBe(
      'Click to change to public'
    );
  });

  it('keeps the mockup’s exact confirm copy going public', () => {
    const options = visibilityConfirm(version({ visibility: 'private' }));
    expect(options.title).toBe('Change Visibility to PUBLIC');
    expect(options.message).toContain('Change visibility to PUBLIC?');
    expect(options.message).toContain(
      'This will make the OpenAPI Specification public without requiring an API Key.'
    );
    expect(options.confirmLabel).toBe('Change Visibility');
    expect(options.cancelLabel).toBe('Cancel');
    expect(options.variant).toBe('warning');
  });

  it('keeps the mockup’s exact confirm copy going private', () => {
    const options = visibilityConfirm(version());
    expect(options.title).toBe('Change Visibility to PRIVATE');
    expect(options.message).toContain('Change visibility to PRIVATE?');
    expect(options.message).toContain('This will restrict access by requiring an API Key.');
  });

  it('confirms the change in the toast the mockup names', () => {
    expect(visibilityChangedToast('public')).toBe('Visibility changed to public.');
    expect(visibilityChangedToast('private')).toBe('Visibility changed to private.');
  });

  it('keeps the server’s own words in the failure banner', () => {
    expect(visibilityErrorMessage('503 Service Unavailable')).toBe(
      'Failed to update visibility: 503 Service Unavailable'
    );
  });

  it('still says something when the server said nothing', () => {
    expect(visibilityErrorMessage(null)).toBe('Failed to update visibility.');
    expect(visibilityErrorMessage('   ')).toBe('Failed to update visibility.');
  });
});

// ---------------------------------------------------------------------------------------
// The row menu
// ---------------------------------------------------------------------------------------

describe('the View fly-out', () => {
  it('offers the three viewers in the mockup’s order', () => {
    expect(publishedViewItems(version(), { hasApiKey: false }).map((item) => item.label)).toEqual([
      'OpenAPI',
      'Arazzo',
      'JSON Schema',
    ]);
  });

  it('leaves a public revision’s viewers reachable with no key in the workspace', () => {
    const items = publishedViewItems(version(), { hasApiKey: false });
    expect(items.every((item) => item.disabled)).toBe(false);
    expect(items[0].title).toBe('View OpenAPI spec');
  });

  it('gates a private revision when the workspace holds no live key, and says why', () => {
    const items = publishedViewItems(version({ visibility: 'private' }), { hasApiKey: false });
    expect(items.every((item) => item.disabled)).toBe(true);
    expect(items.every((item) => item.title === PRIVATE_NEEDS_KEY_TITLE)).toBe(true);
  });

  it('reopens a private revision’s viewers once a key exists', () => {
    const items = publishedViewItems(version({ visibility: 'private' }), { hasApiKey: true });
    expect(items.some((item) => item.disabled)).toBe(false);
  });
});

describe('the row menu', () => {
  it('offers Swagger UI, Copy URL and the visibility verb, in that order', () => {
    expect(publishedRowMenuItems(version()).map((item) => item.id)).toEqual([
      'swagger',
      'copy',
      'visibility',
    ]);
  });

  it('names the visibility verb for the direction the row would move', () => {
    expect(publishedRowMenuItems(version())[2].label).toBe('Make Private');
    expect(publishedRowMenuItems(version({ visibility: 'private' }))[2].label).toBe('Make Public');
  });

  it('rules a hairline above the visibility verb and nowhere else', () => {
    const separators = publishedRowMenuItems(version()).filter((item) => item.separatorBefore);
    expect(separators.map((item) => item.id)).toEqual(['visibility']);
  });

  it('offers no unpublish and no delete — both live on Versions', () => {
    const ids = publishedRowMenuItems(version()).map((item) => String(item.id));
    expect(ids).not.toContain('unpublish');
    expect(ids).not.toContain('delete');
  });

  it('names a row by its project and version', () => {
    expect(publishedRowLabel(version())).toBe('Payments API v2.3.1');
  });

  it('does not double the v when the stored label already carries one', () => {
    expect(publishedRowLabel(version({ version_id: 'v2.3.1' }))).toBe('Payments API v2.3.1');
  });
});

// ---------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------

describe('the routes it links to', () => {
  it('points at the surfaces that own what this screen only refers to', () => {
    expect(API_KEYS_HREF).toBe('/ade/dashboard/api-keys');
    expect(VERSIONS_HREF).toBe('/ade/dashboard/versions');
    expect(SUNSET_TIMELINE_HREF).toBe('/ade/dashboard/versions/sunset-timeline');
  });
});
