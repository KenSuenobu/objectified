/**
 * Presentation rules for the webhook source-IP allowlist (REPO-7.6, #2804).
 *
 * Two rules carry real weight here.
 *
 * `allowlistPosture` combines three independent switches into the one sentence the panel
 * leads with. The state worth naming is `unfiltered`: enforcement is on, this workspace has
 * not bypassed it, and there is still nothing cached to filter against — so every delivery is
 * being allowed. Three switches read "on" and nothing is being filtered, which is exactly the
 * state a table of green ticks would let someone mistake for safety.
 *
 * `validateCidr` mirrors the server's rule rather than a looser one. A value with host bits
 * set is refused instead of silently widened, because an operator who meant one host and got
 * 256 would never learn it from this screen.
 */

import { describe, test, expect } from '@jest/globals';
import { statusTone } from '@/app/components/ui/statusVocabulary';
import {
  POSTURE_COPY,
  POSTURE_STATUS,
  POSTURE_TONE,
  type IpAllowlistEntry,
  type IpAllowlistResponse,
  type IpProvider,
  allowlistPosture,
  cadenceLabel,
  formatTimestamp,
  providerLabel,
  refreshSummary,
  validateCidr,
  allowlistRangeTotal,
  bypassConfirm,
  isProviderOverdue,
  rangeSourceTitle,
  removeRangeConfirm,
} from '@/app/components/ade/repositories/webhookAllowlistModel';

function provider(overrides: Partial<IpProvider> = {}): IpProvider {
  return {
    provider: 'github',
    sourceUrl: 'https://api.github.com/meta',
    note: 'GitHub publishes its webhook egress ranges.',
    rangeCount: 1,
    ranges: [
      { cidr: '192.30.252.0/22', family: 4, source: 'provider', refreshedAt: null },
    ],
    lastAttemptAt: '2026-08-01T10:00:00Z',
    lastSuccessAt: '2026-08-01T10:00:00Z',
    lastOutcome: 'success',
    lastError: null,
    stale: false,
    ...overrides,
  };
}

/** One tenant-managed entry, enabled unless a test says otherwise. */
function entry(overrides: Partial<IpAllowlistEntry> = {}): IpAllowlistEntry {
  return {
    id: 'e1',
    cidr: '203.0.113.0/24',
    family: 4,
    description: 'Self-hosted GitLab runner',
    enabled: true,
    createdAt: '2026-08-02T09:00:00Z',
    updatedAt: null,
    ...overrides,
  };
}

function response(overrides: Partial<IpAllowlistResponse> = {}): IpAllowlistResponse {
  return {
    success: true,
    enforcementEnabled: true,
    strict: false,
    refreshIntervalSeconds: 86400,
    trustedProxyHops: 0,
    tenantEnforcementEnabled: true,
    bypassReason: null,
    policyUpdatedAt: null,
    providers: [provider()],
    entries: [],
    ...overrides,
  };
}

describe('allowlistPosture', () => {
  test('a deployment that has not enabled the filter reads as off', () => {
    expect(allowlistPosture(response({ enforcementEnabled: false }))).toBe('off');
  });

  test('a workspace that opted out reads as bypassed even when the deployment enforces', () => {
    expect(allowlistPosture(response({ tenantEnforcementEnabled: false }))).toBe('bypassed');
  });

  test('enforcement with no cached ranges reads as unfiltered, not enforced', () => {
    // The state most likely to be mistaken for safety: everything says "on" and every
    // delivery is being allowed.
    const data = response({ providers: [provider({ rangeCount: 0, ranges: [] })] });
    expect(allowlistPosture(data)).toBe('unfiltered');
  });

  test('strict mode with no cached ranges is enforced, because it blocks', () => {
    const data = response({
      strict: true,
      providers: [provider({ rangeCount: 0, ranges: [] })],
    });
    expect(allowlistPosture(data)).toBe('enforced');
  });

  test('the deployment switch outranks the workspace policy', () => {
    const data = response({ enforcementEnabled: false, tenantEnforcementEnabled: false });
    expect(allowlistPosture(data)).toBe('off');
  });

  test('every posture has copy and a tone', () => {
    for (const posture of ['off', 'bypassed', 'unfiltered', 'enforced'] as const) {
      expect(POSTURE_COPY[posture].title).toBeTruthy();
      expect(POSTURE_COPY[posture].body).toBeTruthy();
      expect(POSTURE_TONE[posture]).toBeTruthy();
    }
  });

  test('only the enforced posture is drawn as good news', () => {
    // `ok`, not the `good` this module used to invent: the tone names are the shared
    // vocabulary's, so the banner, its tile and any badge beside it take the same green
    // (HIVE-7.6, #5323).
    expect(POSTURE_TONE.enforced).toBe('ok');
    expect(POSTURE_TONE.unfiltered).toBe('warn');
    expect(POSTURE_TONE.bypassed).toBe('warn');
    expect(POSTURE_TONE.off).toBe('neutral');
  });

  test('every posture resolves its tone through a string the shared table holds', () => {
    for (const posture of ['off', 'bypassed', 'unfiltered', 'enforced'] as const) {
      expect(statusTone(POSTURE_STATUS[posture])).toBe(POSTURE_TONE[posture]);
    }
  });
});

describe('refreshSummary', () => {
  test('a skipped provider is described as a choice, not a fault', () => {
    // GitLab publishing no range list is a deployment state, and a permanently red panel
    // about it teaches people to ignore the panel.
    const summary = refreshSummary(provider({ lastOutcome: 'skipped', lastSuccessAt: null }));
    expect(summary).toContain('No range list to fetch');
  });

  test('a provider that has never refreshed says so, with its error', () => {
    const summary = refreshSummary(
      provider({ lastSuccessAt: null, lastError: 'HTTP 503', lastOutcome: 'failure' })
    );
    expect(summary).toContain('Never refreshed successfully');
    expect(summary).toContain('HTTP 503');
  });

  test('a stale provider is called overdue', () => {
    expect(refreshSummary(provider({ stale: true }))).toContain('overdue');
  });

  test('a healthy provider just reports when it last refreshed', () => {
    const summary = refreshSummary(provider());
    expect(summary).toContain('Last refreshed');
    expect(summary).not.toContain('overdue');
  });
});

describe('cadenceLabel', () => {
  test('a daily cadence is a word, not a number of seconds', () => {
    expect(cadenceLabel(86400)).toBe('daily');
  });

  test('multi-day and hourly cadences read naturally', () => {
    expect(cadenceLabel(172800)).toBe('every 2 days');
    expect(cadenceLabel(3600)).toBe('hourly');
    expect(cadenceLabel(7200)).toBe('every 2 hours');
  });

  test('anything shorter falls back to minutes', () => {
    expect(cadenceLabel(900)).toBe('every 15 minutes');
  });
});

describe('providerLabel', () => {
  test('known providers get their real capitalisation', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('gitlab')).toBe('GitLab');
    expect(providerLabel('bitbucket')).toBe('Bitbucket');
  });

  test('an unknown provider is shown as sent rather than hidden', () => {
    expect(providerLabel('sourcehut')).toBe('sourcehut');
  });
});

describe('formatTimestamp', () => {
  test('a missing timestamp is a dash, not "Invalid Date"', () => {
    expect(formatTimestamp(null)).toBe('—');
  });

  test('an unparseable value is shown raw rather than swallowed', () => {
    expect(formatTimestamp('whenever')).toBe('whenever');
  });
});

describe('validateCidr', () => {
  test('a plain address is accepted', () => {
    expect(validateCidr('203.0.113.9')).toBeNull();
    expect(validateCidr('2001:db8::1')).toBeNull();
  });

  test('a well-formed range is accepted', () => {
    expect(validateCidr('192.30.252.0/22')).toBeNull();
    expect(validateCidr('2a0a:a440::/29')).toBeNull();
  });

  test('an empty value asks for one rather than failing silently', () => {
    expect(validateCidr('')).toContain('Enter an IP address');
  });

  test('host bits are refused rather than rounded away', () => {
    expect(validateCidr('10.0.0.1/24')).toContain('host bits');
  });

  test('a prefix wider than the family allows is refused', () => {
    expect(validateCidr('10.0.0.0/33')).toContain('/32');
    expect(validateCidr('2001:db8::/129')).toContain('/128');
  });

  test('a malformed address is refused', () => {
    expect(validateCidr('999.1.1.1')).toContain('IPv4');
    expect(validateCidr('10.0.0')).toContain('IPv4');
    expect(validateCidr('not-an-address')).toBeTruthy();
  });

  test('more than one slash is refused', () => {
    expect(validateCidr('10.0.0.0/8/8')).toContain('one');
  });

  test('a non-numeric prefix is refused', () => {
    expect(validateCidr('10.0.0.0/eight')).toContain('number');
  });

  test('an absurdly long value is refused before it is parsed', () => {
    expect(validateCidr('1.2.3.4'.padEnd(200, '0'))).toContain('too long');
  });
});

// ---------------------------------------------------------------------------------------
// HIVE-7.6 (#5323) — the confirms, and the rest of the redesign's rules
// ---------------------------------------------------------------------------------------

describe('the remove-range confirm', () => {
  test('names the exact range in its title, not “this range”', () => {
    // A confirm an operator can answer without having checked which row they clicked is a
    // confirm that does not protect anything.
    expect(removeRangeConfirm('203.0.113.0/24').title).toBe('Remove 203.0.113.0/24?');
  });

  test('says what happens, in the present tense', () => {
    const copy = removeRangeConfirm('198.51.100.7');
    expect(copy.description).toContain('refused as soon as it is removed');
    expect(copy.confirmLabel).toBe('Remove range');
  });
});

describe('the bypass confirm', () => {
  test('quotes the reason back — the last moment anyone can correct the ledger entry', () => {
    const copy = bypassConfirm('  Vendor relay delivers from an unpublished address  ');
    expect(copy.description).toContain('“Vendor relay delivers from an unpublished address”');
    expect(copy.description).toContain('audit ledger');
  });

  test('states the consequence before the button that causes it', () => {
    const copy = bypassConfirm('Vendor relay');
    expect(copy.title).toBe('Bypass the allowlist?');
    expect(copy.description).toContain('any address');
    expect(copy.confirmLabel).toBe('Bypass allowlist');
  });
});

describe('overdue providers', () => {
  test('a stale provider with a list to fetch is overdue', () => {
    expect(isProviderOverdue(provider({ stale: true, lastOutcome: 'success' }))).toBe(true);
  });

  test('a provider that publishes no list is settled, not overdue', () => {
    // Drawing it amber for ever would train an operator to ignore the colour on the cards
    // that mean it.
    expect(isProviderOverdue(provider({ stale: true, lastOutcome: 'skipped' }))).toBe(false);
  });

  test('a provider refreshing on schedule is not overdue', () => {
    expect(isProviderOverdue(provider({ stale: false, lastOutcome: 'success' }))).toBe(false);
  });
});

describe('what the filter is actually built from', () => {
  test('counts cached provider ranges plus the enabled tenant ones', () => {
    const data = response({
      providers: [provider({ rangeCount: 6 }), provider({ provider: 'gitlab', rangeCount: 2 })],
      entries: [entry({ enabled: true }), entry({ id: 'e2', enabled: true })],
    });
    expect(allowlistRangeTotal(data)).toBe(10);
  });

  test('a disabled entry is not part of the filter, so it is not counted', () => {
    const data = response({
      providers: [provider({ rangeCount: 1 })],
      entries: [entry({ enabled: true }), entry({ id: 'e2', enabled: false })],
    });
    expect(allowlistRangeTotal(data)).toBe(2);
  });
});

describe('where a cached range came from', () => {
  test('a provider-published range says so', () => {
    expect(rangeSourceTitle('provider')).toContain('Published by the provider');
  });

  test('a deployment-configured range is not passed off as the provider’s', () => {
    expect(rangeSourceTitle('configured')).toContain('deployment');
  });
});
