/**
 * Export Studio URL state — deep links & resumable Studio state (MFX-41.4, #4351).
 *
 * Enterprise export work is collaborative: "look at this export config" has to be a URL. The
 * Studio therefore mirrors its session — the scoped source, the chosen target, the non-default
 * options, and the step the user is on — into the query string, and reads it back on load. This
 * module owns that encoding and its validation:
 *
 *  - **Compact options.** Overrides travel as `opts`: base64url-encoded JSON, so a shared link
 *    stays short and survives copy/paste without a wall of percent-escapes. The legacy plain-JSON
 *    `options` param (the MFX-41.3 "re-run in Studio" links) still decodes, so links minted before
 *    this ticket keep working.
 *  - **No secrets, ever.** Credential-shaped option keys (password / token / secret / api-key / …)
 *    are stripped on the way out *and* on the way in, so a delivery credential (MFX-46.3) can
 *    never ride in a URL — not even one hand-crafted by a user.
 *  - **Validated, never trusted.** Every param is checked here before the Studio sees it. There is
 *    no zod in this workspace (the roadmap's stack note is a placeholder), so the checks are
 *    hand-rolled and total: anything unreadable degrades to a notice the Studio renders, never to
 *    a crash and never to a silently wrong session.
 *  - **Reachable steps only.** A restored step is clamped to what the link can actually establish.
 *    A verify verdict is a fact about a dry-run, not a URL parameter, so a `step=review` link
 *    resumes at Verify and the user re-verifies before generating.
 *
 * The href *builder* lives with the rest of the deep-link contract in `exportStudioLink.ts`,
 * which imports from here; this module never imports from it (one direction, no cycle).
 */

/** The Studio's stepper stops, in order — the canonical list the URL's `step` is validated against. */
export const EXPORT_STUDIO_STEP_ORDER = ['source', 'target', 'options', 'verify', 'review'] as const;

/** One stepper stop of the Export Studio. */
export type ExportStudioStep = (typeof EXPORT_STUDIO_STEP_ORDER)[number];

/** The compact (base64url-JSON) option-overrides param. */
export const STUDIO_OPTIONS_PARAM = 'opts';

/** The legacy plain-JSON option-overrides param (MFX-41.3 links keep working). */
export const STUDIO_LEGACY_OPTIONS_PARAM = 'options';

/** The resumable-step param. */
export const STUDIO_STEP_PARAM = 'step';

/** Longest scalar param value the Studio will read; anything longer is treated as unusable. */
const MAX_PARAM_LENGTH = 512;

/** Longest encoded options payload the Studio will emit or read (keeps links pasteable). */
const MAX_ENCODED_OPTIONS_LENGTH = 2048;

/** Control characters never appear in real Studio state — only in a corrupted or mangled link. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Option keys whose *values* may be credentials. Matched case-insensitively against the key, and
 * deliberately specific: `api_key` is a secret, a bare `key` (e.g. a partition key) is not — a
 * false positive silently degrades an otherwise shareable link.
 */
const SECRET_OPTION_KEY_PATTERN =
  /(password|passwd|secret|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|signature|authorization|bearer)/i;

/** Why a deep link could not be honoured in full — each maps to a user-facing notice. */
export type ExportStudioLinkIssueCode =
  /** A param was present but unusable (over-long / control characters). */
  | 'param-invalid'
  /** The options payload could not be decoded; the target opens at its defaults. */
  | 'options-unreadable'
  /** The link carried credential-shaped option keys; they were ignored. */
  | 'options-redacted'
  /** The link's target is not in this source's registry (unregistered / filtered out). */
  | 'target-unknown'
  /** The link's target exists but cannot run for this source (e.g. missing toolchain). */
  | 'target-unavailable'
  /** Some option keys in the link do not exist on the resolved target and were ignored. */
  | 'options-foreign';

/** A single graceful-degradation notice: a stable code plus the sentence the Studio renders. */
export interface ExportStudioLinkIssue {
  code: ExportStudioLinkIssueCode;
  message: string;
}

/** The validated deep-link state of one Studio session. */
export interface ExportStudioUrlState {
  /** The artifact (project / catalog-item) id to export; null when the link carried none. */
  artifact: string | null;
  /** The revision selector (UUID or label); null for the latest revision. */
  version: string | null;
  /** A human name for the source, shown in the header. */
  label: string | null;
  /** The pre-selected emitter key, unresolved — membership is checked against the loaded registry. */
  target: string | null;
  /** The raw launch origin (`resolveStudioBack` tolerates unknown values). */
  origin: string | null;
  /** The source's original import format, when the link carried one. */
  sourceFormat: string | null;
  /** Non-default option overrides to pre-fill; already stripped of credential-shaped keys. */
  options: Record<string, unknown> | null;
  /** The step to resume on, before reachability clamping; null when the link carried none. */
  step: ExportStudioStep | null;
}

/** A parsed link: the state to open with, plus everything that had to be degraded to get there. */
export interface ParsedExportStudioUrlState {
  state: ExportStudioUrlState;
  issues: ExportStudioLinkIssue[];
}

/** The minimal read interface both `URLSearchParams` and Next's `ReadonlyURLSearchParams` satisfy. */
export interface ReadableSearchParams {
  get(name: string): string | null;
}

/** True when `value` is a plain (non-array, non-null) object — the only shape options may take. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split an option map into what may be shared and what must never leave the browser.
 *
 * @param options The override map (or null).
 * @returns `safe` — the shareable overrides, or null when nothing remains; `redacted` — the keys
 *          withheld because they look like credentials, in their original order.
 */
export function stripSecretOptions(options: Record<string, unknown> | null | undefined): {
  safe: Record<string, unknown> | null;
  redacted: string[];
} {
  if (!options) return { safe: null, redacted: [] };
  const safe: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (SECRET_OPTION_KEY_PATTERN.test(key)) {
      redacted.push(key);
      continue;
    }
    safe[key] = value;
  }
  return { safe: Object.keys(safe).length > 0 ? safe : null, redacted };
}

/** base64 → base64url (URL-safe alphabet, no padding). */
function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → base64 (restores the standard alphabet and padding). */
function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  return `${base64}${padding}`;
}

/**
 * Encode option overrides for the URL: credential-shaped keys removed, JSON, base64url.
 *
 * Falls back to the plain JSON text when base64 is unavailable (a non-browser runtime without
 * `btoa`) — `decodeStudioOptions` reads both, so the link still works.
 *
 * @param options The non-default overrides to share (or null/empty for none).
 * @returns The `opts` param value, or null when there is nothing safe (or nothing small enough) to
 *          encode — an over-long payload is dropped rather than minting an unusable link.
 */
export function encodeStudioOptions(
  options: Record<string, unknown> | null | undefined,
): string | null {
  const { safe } = stripSecretOptions(options);
  if (!safe) return null;
  let json: string;
  try {
    json = JSON.stringify(safe);
  } catch {
    // Non-serializable values (cycles) can only come from a caller bug; share nothing rather than throw.
    return null;
  }
  let encoded = json;
  if (typeof btoa === 'function') {
    try {
      const bytes = new TextEncoder().encode(json);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      encoded = toBase64Url(btoa(binary));
    } catch {
      encoded = json;
    }
  }
  return encoded.length > MAX_ENCODED_OPTIONS_LENGTH ? null : encoded;
}

/**
 * Decode an option-overrides param — the compact base64url form *or* the legacy plain JSON one.
 *
 * Tolerant by design: a missing, over-long, malformed, or non-object value yields null, so a
 * hand-edited URL can never break the Studio — it simply opens the target at its defaults.
 * Credential-shaped keys are stripped here too, so a hand-crafted link cannot pre-fill a secret.
 *
 * @param raw The raw `opts` (or legacy `options`) query-string value.
 * @returns The decoded, secret-free override map, or null when absent/unreadable.
 */
export function decodeStudioOptions(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  const decoded = decodeStudioOptionsRaw(raw);
  return decoded ? stripSecretOptions(decoded).safe : null;
}

/**
 * Decode an option-overrides param without stripping secrets — the parse step needs the raw map to
 * report *which* credential keys it withheld. Callers outside this module want
 * {@link decodeStudioOptions}.
 *
 * @param raw The raw `opts` (or legacy `options`) query-string value.
 * @returns The decoded map, or null when absent/unreadable.
 */
function decodeStudioOptionsRaw(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || raw.length > MAX_ENCODED_OPTIONS_LENGTH) return null;
  const candidates: string[] = [];
  // A legacy link carries JSON text (possibly still percent-decoded to start with `{`).
  if (raw.trimStart().startsWith('{')) candidates.push(raw);
  if (typeof atob === 'function') {
    try {
      const binary = atob(fromBase64Url(raw));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      candidates.push(new TextDecoder('utf-8').decode(bytes));
    } catch {
      // Not base64 — fall through to the raw text candidate below.
    }
  }
  candidates.push(raw);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Try the next candidate encoding.
    }
  }
  return null;
}

/**
 * Read one scalar param, rejecting values that cannot be legitimate Studio state.
 *
 * @param params The query string to read.
 * @param name The param name.
 * @param issues Collects a `param-invalid` notice when the value is present but unusable.
 * @returns The trimmed value, or null when absent/empty/unusable.
 */
function readScalarParam(
  params: ReadableSearchParams,
  name: string,
  issues: ExportStudioLinkIssue[],
): string | null {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  // Over-long values and control characters mean a corrupted or hand-mangled link, never real state.
  if (value.length > MAX_PARAM_LENGTH || CONTROL_CHARACTERS.test(value)) {
    issues.push({
      code: 'param-invalid',
      message: `The link's “${name}” value could not be read and was ignored.`,
    });
    return null;
  }
  return value;
}

/** True when `value` names one of the Studio's steps. */
export function isExportStudioStep(value: unknown): value is ExportStudioStep {
  return (
    typeof value === 'string' &&
    (EXPORT_STUDIO_STEP_ORDER as readonly string[]).includes(value)
  );
}

/**
 * Validate a Studio deep link into the session state it describes.
 *
 * Every field degrades independently: an unreadable options payload still leaves the source and
 * target usable, and an unknown step simply starts at Source. Problems worth telling the user
 * about come back as `issues`; a silently-defaulted field (an unknown `from`, an unknown `step`)
 * does not, because there is nothing the user could act on.
 *
 * @param params The Studio route's query string.
 * @returns The validated state plus the notices the Studio should render.
 */
export function parseExportStudioUrlState(
  params: ReadableSearchParams,
): ParsedExportStudioUrlState {
  const issues: ExportStudioLinkIssue[] = [];
  const rawStep = readScalarParam(params, STUDIO_STEP_PARAM, issues);
  // Read the options payload directly: it has its own (larger) budget, enforced by the decoder.
  const rawOptions =
    params.get(STUDIO_OPTIONS_PARAM) ?? params.get(STUDIO_LEGACY_OPTIONS_PARAM);

  let options: Record<string, unknown> | null = null;
  if (rawOptions) {
    const decoded = decodeStudioOptionsRaw(rawOptions);
    if (!decoded) {
      issues.push({
        code: 'options-unreadable',
        message:
          'The options in this link could not be read — the target opens with its default options.',
      });
    } else {
      const { safe, redacted } = stripSecretOptions(decoded);
      options = safe;
      if (redacted.length > 0) {
        issues.push({
          code: 'options-redacted',
          message: `Credentials are never carried in a link: ${redacted.join(', ')} ${
            redacted.length === 1 ? 'was' : 'were'
          } ignored. Re-enter ${redacted.length === 1 ? 'it' : 'them'} before generating.`,
        });
      }
    }
  }

  return {
    state: {
      artifact: readScalarParam(params, 'artifact', issues),
      version: readScalarParam(params, 'version', issues),
      label: readScalarParam(params, 'label', issues),
      target: readScalarParam(params, 'target', issues),
      origin: readScalarParam(params, 'from', issues),
      sourceFormat: readScalarParam(params, 'sourceFormat', issues),
      options,
      step: isExportStudioStep(rawStep) ? rawStep : null,
    },
    issues,
  };
}

/** What a restored session has actually established, and so how far into the stepper it may resume. */
export interface StudioStepReachability {
  /** Whether the link's target resolved to an available target for this source. */
  hasTarget: boolean;
  /** Whether the seeded option values satisfy the target's options schema. */
  optionsValid: boolean;
}

/**
 * Clamp a link's requested step to the furthest one it can honestly resume.
 *
 * A URL can carry a configuration but never a *verdict*: the Verify dry-run has not run after a
 * reload, so `review` resumes at `verify` and the user re-verifies before generating — the same
 * gate a fresh session passes through. Likewise a link whose target no longer resolves lands on
 * `target` (pick one) and one whose options are incomplete lands on `options` (finish them).
 *
 * @param requested The validated step from the URL (null when the link carried none).
 * @param reachability What the restored session established.
 * @returns The step to open on.
 */
export function resolveResumableStep(
  requested: ExportStudioStep | null | undefined,
  reachability: StudioStepReachability,
): ExportStudioStep {
  if (!requested || requested === 'source') return 'source';
  if (requested === 'target' || !reachability.hasTarget) return 'target';
  if (requested === 'options' || !reachability.optionsValid) return 'options';
  // `verify` and `review` both resume at Verify: the verdict that gates Generate is never encoded.
  return 'verify';
}

/**
 * Turn a failed source load into a sentence that says what is actually wrong with the link.
 *
 * A shared link outlives the thing it points at: the version can be deleted, and the recipient can
 * belong to another tenant (the proxy is tenant-scoped — `/api/export/targets` resolves the tenant
 * from the session, never from the URL, so a cross-tenant link resolves to *their* tenant and
 * misses). Both come back as HTTP status codes; the generic loader message does not explain them.
 *
 * @param status The HTTP status of the failed targets request, when known.
 * @param fallback The loader's own error message, used for anything unrecognised.
 * @returns The message to show in the Studio's error notice.
 */
export function describeStudioSourceFailure(
  status: number | null | undefined,
  fallback: string,
): string {
  if (status === 404) {
    return 'This link points at a source or version that no longer exists. It may have been deleted or renamed since the link was shared.';
  }
  if (status === 403) {
    return 'This export link is not available in your workspace. Exports are scoped to the tenant that owns the source — ask the sender to share it with your workspace.';
  }
  if (status === 401) {
    return 'Your session has expired. Sign in again to open this export link.';
  }
  return fallback;
}
