/**
 * Client contract for the evidence-backed verification policy — ECA-3.1 (#4734).
 *
 * Governance → Style Guides hosts the config panel; the versions publish dialog hosts the
 * decision panel. Both talk to `/api/verification-policy`, which forwards to REST
 * `/v1/tenants/{slug}/governance/verification-policy…`. Types mirror the REST camelCase aliases.
 *
 * The UI never invents pass/fail — it renders the evaluate payload the server returns.
 */

/** The tenant's policy in force — `GET/PUT /api/verification-policy`. */
export interface VerificationPolicy {
  policyVersionId: string | null;
  versionNumber: number;
  contentFingerprint: string;
  isDefault: boolean;
  requiredSuiteDigests: string[];
  maxEvidenceAgeSeconds: number | null;
  requiredTargetNetworkClass: 'public' | 'private' | null;
  purpose: 'publish' | 'deploy' | 'both';
  breakingChangeAction: 'ignore' | 'warn' | 'block';
  enforcement: 'advisory' | 'block';
  actorLabel: string | null;
  createdAt: string | null;
}

export interface VerificationPolicyVersionList {
  versions: VerificationPolicy[];
  count: number;
}

export interface VerificationPolicyGateResult {
  gate: string;
  passed: boolean;
  detail: Record<string, unknown>;
  action?: string | null;
}

/** Shared decision payload — identical for API, publish precheck, and dashboard. */
export interface VerificationPolicyDecision {
  passed: boolean;
  enforcement: 'advisory' | 'block';
  policyVersionId: string | null;
  policyContentFingerprint: string;
  evaluationId: string | null;
  evidenceRunIds: string[];
  gateResults: VerificationPolicyGateResult[];
  warnings: Array<Record<string, unknown>>;
  purpose: 'publish' | 'deploy';
  skipped: boolean;
}

export interface VerificationPolicyEvaluateRequest {
  purpose: 'publish' | 'deploy';
  projectSlug?: string;
  projectId?: string;
  versionId?: string;
  versionSlug?: string;
}

/**
 * Call the verification-policy proxy.
 *
 * @param path Sub-path under `/api/verification-policy`.
 * @param init Fetch options.
 * @returns The parsed `data` payload, or `null` for a 204.
 */
export async function verificationPolicyApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const res = await fetch(`/api/verification-policy${path ? `/${path}` : ''}`, init);
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const err = json.error;
    const message =
      typeof err === 'object' && err !== null
        ? (err as { message?: string }).message || JSON.stringify(err)
        : err || 'Request failed';
    throw new Error(String(message));
  }
  return json.data as T;
}

/** Whether a blocking enforcement mode would refuse a failed decision. */
export function isVerificationPolicyBlocking(policy: VerificationPolicy): boolean {
  return policy.enforcement === 'block';
}
