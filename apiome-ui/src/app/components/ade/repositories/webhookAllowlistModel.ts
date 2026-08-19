/**
 * Webhook IP allowlist — the rules behind `/ade/dashboard/repositories/webhook-ip-allowlist`
 * (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/webhook-allowlist.html` and its **Notes → Keeps (1:1)**
 * list; DESIGN.md §7 (cards, dialogs) and §8 (destructive confirms).
 *
 * The panel this feeds has one job that a table of CIDRs does not do on its own: say, in a
 * sentence, whether the filter is actually protecting anything right now. Three independent
 * switches decide that — the deployment-wide setting, this workspace's own policy, and
 * whether any provider ranges have been cached to filter against — and an operator reading
 * three green ticks and one empty table has no way to combine them into an answer.
 * {@link allowlistPosture} does the combining, once, so the screen and its tests agree.
 *
 * Deliberately React-free, so every rule here is unit-testable without a DOM — the same
 * split as `quotaTelemetryModel.ts` next to it.
 *
 * ### What HIVE-7.6 changed
 *
 * Two edits used to happen the moment they were clicked. Removing a range and bypassing
 * enforcement both weaken the filter in front of an unauthenticated endpoint, and both were
 * one click with no confirmation — so both now go through a confirm whose words name the
 * consequence, and the copy for those confirms is here. That is the ticket's "allowlist edits
 * confirm before weakening enforcement" criterion. Enabling a range and *restoring*
 * enforcement stay one click: neither widens what is accepted.
 *
 * `POSTURE_TONE` also stopped inventing tone names (`good`) and now speaks the shared
 * vocabulary's, so the banner, its icon tile and the badge beside it take the same green.
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

/**
 * Tone each posture should be drawn in — a settled state is not a warning.
 *
 * The names are `ui/statusVocabulary`'s, not this module's: `ok` rather than the `good` this
 * used to invent, so the banner's frame, its icon tile and any badge beside it resolve
 * through the one table the rest of the product reads.
 */
export const POSTURE_TONE: Record<AllowlistPosture, AllowlistTone> = {
  off: 'neutral',
  bypassed: 'warn',
  unfiltered: 'warn',
  enforced: 'ok',
};

/** The three tones a posture can take — a subset of the shared vocabulary's. */
export type AllowlistTone = 'neutral' | 'warn' | 'ok';

/**
 * The status string the posture's badge and icon tile resolve their tone through.
 *
 * `unknown`, `warning` and `healthy` are all entries in `ui/statusVocabulary`, so no new
 * vocabulary is minted for a screen that has three states.
 */
export const POSTURE_STATUS: Record<AllowlistPosture, string> = {
  off: 'unknown',
  bypassed: 'warning',
  unfiltered: 'warning',
  enforced: 'healthy',
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

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------

/** The page's one-line description, under the title. */
export const ALLOWLIST_PAGE_DESC =
  'Which source addresses may deliver webhooks here. Deliveries from anywhere else are refused before their signature is checked.';

/** The live region while the first read is in flight. */
export const ALLOWLIST_LOADING = 'Loading the allowlist…';

/** The heading a failed read gets. The message beside it is whatever the server said. */
export const ALLOWLIST_ERROR_TITLE = 'Allowlist unavailable';

/** The fallback message when a failed read carried no explanation of its own. */
export const ALLOWLIST_ERROR_FALLBACK = 'Could not load the allowlist.';

/** The fallback message when a failed *write* carried no explanation of its own. */
export const ALLOWLIST_SAVE_ERROR = 'That change could not be saved.';

/** The workspace gate: the policy and its extra ranges belong to one tenant. */
export const ALLOWLIST_NO_TENANT =
  'The webhook allowlist is scoped to one workspace, so pick one to see which addresses it accepts.';

/** A provider whose refresh has cached nothing. */
export const NO_RANGES_CACHED = 'No ranges cached.';

/** The heading of the tenant-managed ranges card. */
export const ADDITIONAL_RANGES_TITLE = 'Additional ranges for this workspace';

/** What the tenant-managed ranges are for. */
export const ADDITIONAL_RANGES_DESC =
  'For the addresses no provider publishes — a self-hosted runner, an egress gateway, a relay. These apply to this workspace’s repositories only.';

/** No extra ranges: the provider lists are the whole filter. */
export const ADDITIONAL_RANGES_EMPTY =
  'No additional ranges. Only the provider-published ranges above are allowed.';

/** An entry whose operator did not say why it exists. */
export const NO_RANGE_DESCRIPTION = 'No description';

/** The heading of the enforcement card. */
export const ENFORCEMENT_TITLE = 'Enforcement for this workspace';

/** What bypassing costs, and who may do it. */
export const ENFORCEMENT_DESC =
  'Bypassing the allowlist means this workspace’s repositories accept deliveries from any address. Tenant administrators only, and the reason is recorded in the audit ledger.';

/** Refused before the confirm even opens: a bypass with no reason records nothing. */
export const BYPASS_REASON_REQUIRED =
  'Say why enforcement is being turned off — the audit trail records it.';

/** Refused before the range is sent: an allowlist entry nobody can explain is one nobody can review. */
export const RANGE_REASON_REQUIRED = 'Say why this range should be allowed.';

/** The four mutation toasts, in the words the mockup's footer fixes. */
export const ALLOWLIST_TOASTS = {
  added: 'Range allowed.',
  disabled: 'Range disabled.',
  enabled: 'Range enabled.',
  removed: 'Range removed.',
  bypassed: 'Enforcement bypassed for this workspace.',
  restored: 'Enforcement restored.',
} as const;

// ---------------------------------------------------------------------------------------
// Confirms — the two edits that weaken the filter
// ---------------------------------------------------------------------------------------

/** A confirm dialog's two lines. */
export interface AllowlistConfirmCopy {
  /** The dialog's title — a question naming the exact thing being changed. */
  title: string;
  /** One sentence on what happens if it is answered yes. */
  description: string;
  /** The destructive button's label. */
  confirmLabel: string;
}

/**
 * The confirm for removing a tenant range.
 *
 * The CIDR is in the *title* rather than only in the body: a confirm that says "Remove this
 * range?" is one an operator can answer without having checked which row they clicked.
 *
 * @param cidr - The range about to be removed.
 * @returns The dialog's copy.
 */
export function removeRangeConfirm(cidr: string): AllowlistConfirmCopy {
  return {
    title: `Remove ${cidr}?`,
    description: 'Deliveries from this range will be refused as soon as it is removed.',
    confirmLabel: 'Remove range',
  };
}

/**
 * The confirm for bypassing enforcement.
 *
 * The reason is quoted back, because it is what the audit ledger will hold and this is the
 * last moment anyone can correct it.
 *
 * @param reason - The reason typed into the enforcement card.
 * @returns The dialog's copy.
 */
export function bypassConfirm(reason: string): AllowlistConfirmCopy {
  const trimmed = reason.trim();
  return {
    title: 'Bypass the allowlist?',
    description: `This workspace’s repositories will accept webhook deliveries from any address. The reason “${trimmed}” is recorded in the audit ledger.`,
    confirmLabel: 'Bypass allowlist',
  };
}

/**
 * Whether a provider card should be drawn as overdue.
 *
 * `skipped` is stale by the clock and settled in fact — a provider that publishes no range
 * list will never refresh, and drawing it amber for ever would train an operator to ignore
 * the colour on the cards that mean it.
 *
 * @param provider - The provider.
 * @returns True when the card takes the warn frame.
 */
export function isProviderOverdue(provider: IpProvider): boolean {
  return provider.stale && provider.lastOutcome !== 'skipped';
}

/**
 * How many ranges the whole filter is built from.
 *
 * @param data - The allowlist projection.
 * @returns Provider-cached ranges plus enabled tenant ranges. A disabled entry is not part of
 *   the filter, so it is not counted — the figure has to match what the server would accept.
 */
export function allowlistRangeTotal(data: IpAllowlistResponse): number {
  const cached = data.providers.reduce((total, provider) => total + provider.rangeCount, 0);
  const tenant = data.entries.filter((entry) => entry.enabled).length;
  return cached + tenant;
}

/**
 * The title a cached range's chip carries.
 *
 * @param source - The range's `source`.
 * @returns Where the range came from, in words.
 */
export function rangeSourceTitle(source: string): string {
  return source === 'configured'
    ? 'Supplied by this deployment’s settings'
    : 'Published by the provider';
}
