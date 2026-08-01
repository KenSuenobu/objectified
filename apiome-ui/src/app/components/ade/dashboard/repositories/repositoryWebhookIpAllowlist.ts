/**
 * Webhook source-IP allowlist — types and presentation rules (REPO-7.6, #2804).
 *
 * The panel this feeds has one job that a table of CIDRs does not do on its own: say, in a
 * sentence, whether the filter is actually protecting anything right now. Three independent
 * switches decide that — the deployment-wide setting, this workspace's own policy, and
 * whether any provider ranges have been cached to filter against — and an operator reading
 * three green ticks and one empty table has no way to combine them into an answer.
 * {@link allowlistPosture} does the combining, once, so the screen and its tests agree.
 *
 * Deliberately React-free, so every rule here is unit-testable without a DOM — the same
 * split as `repositoryQuotaTelemetry.ts` next to it.
 */

/** One cached provider-published range. */
export interface IpRange {
  cidr: string;
  /** IP version: 4 or 6. */
  family: number;
  /** `provider` when fetched upstream, `configured` when supplied by deployment settings. */
  source: string;
  /** ISO 8601, or null when the row predates a refresh. */
  refreshedAt: string | null;
}

/** One provider's cached ranges and the health of the refresh that fills them. */
export interface IpProvider {
  provider: string;
  /** The published endpoint, or null for a provider that publishes none. */
  sourceUrl: string | null;
  note: string;
  rangeCount: number;
  ranges: IpRange[];
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** `pending` | `success` | `failure` | `skipped`. */
  lastOutcome: string;
  lastError: string | null;
  /** True when no successful refresh has landed within two cadences. */
  stale: boolean;
}

/** One tenant-managed additional range. */
export interface IpAllowlistEntry {
  id: string;
  cidr: string;
  family: number;
  description: string | null;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** What `GET /api/repositories/webhook-ip-allowlist` returns. */
export interface IpAllowlistResponse {
  success: boolean;
  enforcementEnabled: boolean;
  strict: boolean;
  refreshIntervalSeconds: number;
  trustedProxyHops: number;
  tenantEnforcementEnabled: boolean;
  bypassReason: string | null;
  policyUpdatedAt: string | null;
  providers: IpProvider[];
  entries: IpAllowlistEntry[];
  error?: string;
}

/**
 * What the filter is actually doing, as one value.
 *
 * - `off` — the deployment has not enabled the filter at all.
 * - `bypassed` — enabled deployment-wide, but this workspace has opted out.
 * - `unfiltered` — enforced, but no provider ranges are cached, so in the default
 *   (non-strict) posture every delivery is being allowed with a warning. This is the state
 *   that most needs saying out loud: three switches read "on" and nothing is being filtered.
 * - `enforced` — the filter is on and has ranges to filter against.
 */
export type AllowlistPosture = 'off' | 'bypassed' | 'unfiltered' | 'enforced';

/** Order matters: the most permissive true statement wins. */
export function allowlistPosture(data: IpAllowlistResponse): AllowlistPosture {
  if (!data.enforcementEnabled) return 'off';
  if (!data.tenantEnforcementEnabled) return 'bypassed';
  const cached = data.providers.reduce((total, provider) => total + provider.rangeCount, 0);
  if (cached === 0 && !data.strict) return 'unfiltered';
  return 'enforced';
}

/** Headline and explanation for each posture, in the panel's voice. */
export const POSTURE_COPY: Record<AllowlistPosture, { title: string; body: string }> = {
  off: {
    title: 'Not enforced',
    body:
      'This deployment is not filtering webhook deliveries by source address. Every request reaches the signature check, which is still what authenticates it.',
  },
  bypassed: {
    title: 'Bypassed for this workspace',
    body:
      'The filter is enabled for this deployment, but this workspace has opted out: its repositories accept deliveries from any address.',
  },
  unfiltered: {
    title: 'Enforced, but nothing to filter against',
    body:
      'No provider ranges have been cached yet, so deliveries are being allowed and logged rather than blocked. Check the refresh status below.',
  },
  enforced: {
    title: 'Enforced',
    body:
      'Deliveries from addresses outside the ranges below are refused before their signature is checked.',
  },
};

/** Tone each posture should be drawn in — a settled state is not a warning. */
export const POSTURE_TONE: Record<AllowlistPosture, 'neutral' | 'warn' | 'good'> = {
  off: 'neutral',
  bypassed: 'warn',
  unfiltered: 'warn',
  enforced: 'good',
};

/** Human label for a provider id. */
export function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
  };
  return labels[provider] ?? provider;
}

/**
 * One sentence on a provider's refresh state.
 *
 * `skipped` is not a failure and must not read like one: it means the provider publishes no
 * range list and none has been configured, which is a deployment choice rather than a fault.
 */
export function refreshSummary(provider: IpProvider): string {
  if (provider.lastOutcome === 'skipped') {
    return 'No range list to fetch — configure ranges for this provider if it delivers here.';
  }
  if (!provider.lastSuccessAt) {
    return provider.lastError
      ? `Never refreshed successfully. Last error: ${provider.lastError}`
      : 'Never refreshed.';
  }
  const when = formatTimestamp(provider.lastSuccessAt);
  if (provider.stale) return `Last successful refresh ${when} — overdue.`;
  return `Last refreshed ${when}.`;
}

/** Render an ISO timestamp for the panel, falling back to the raw value if unparseable. */
export function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

/** The refresh cadence as a phrase, so the panel does not print "86400 seconds". */
export function cadenceLabel(seconds: number): string {
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? 'daily' : `every ${days} days`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'hourly' : `every ${hours} hours`;
  }
  return `every ${Math.max(1, Math.round(seconds / 60))} minutes`;
}

/**
 * Client-side check of a CIDR before it is sent.
 *
 * Deliberately the *same rule* the server applies, not a looser one: a value with host bits
 * set is rejected rather than silently widened, because an operator who meant one host and
 * got 256 would never learn it from this screen. The server re-validates regardless — this
 * only exists so the answer arrives while the field is still focused.
 *
 * @param raw - What the operator typed.
 * @returns An error message, or null when the value is acceptable.
 */
export function validateCidr(raw: string): string | null {
  const text = (raw ?? '').trim();
  if (!text) return 'Enter an IP address or CIDR range.';
  if (text.length > 64) return 'That is too long to be an address.';

  const [address, prefixText, ...rest] = text.split('/');
  if (rest.length > 0) return 'A CIDR has at most one “/”.';

  const isIpv6 = address.includes(':');
  const octets = isIpv6 ? null : address.split('.');

  if (!isIpv6) {
    if (!octets || octets.length !== 4) return 'That is not an IPv4 address.';
    for (const octet of octets) {
      if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) {
        return 'That is not an IPv4 address.';
      }
    }
  } else if (!/^[0-9a-fA-F:]+$/.test(address) || address.split('::').length > 2) {
    return 'That is not an IPv6 address.';
  }

  if (prefixText === undefined) return null;
  if (!/^\d{1,3}$/.test(prefixText)) return 'The prefix length must be a number.';
  const prefix = Number(prefixText);
  const maxPrefix = isIpv6 ? 128 : 32;
  if (prefix > maxPrefix) return `The prefix length cannot exceed /${maxPrefix}.`;

  if (!isIpv6 && octets) {
    // Host bits: everything below the prefix must be zero, or the range an operator gets is
    // not the range they typed.
    const value = octets.reduce((acc, octet) => acc * 256 + Number(octet), 0);
    const hostBits = 32 - prefix;
    if (hostBits > 0 && value % 2 ** hostBits !== 0) {
      return 'This range has host bits set — did you mean a single address, or a wider range?';
    }
  }
  return null;
}
