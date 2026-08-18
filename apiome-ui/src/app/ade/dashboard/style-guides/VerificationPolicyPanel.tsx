'use client';

import { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw, Shield } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from '@/app/components/ui/Card';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Spinner } from '@/app/components/ui/Spinner';
import { Textarea } from '@/app/components/ui/Textarea';
import { formatPolicyInstant } from '@/app/components/ade/styleGuides';

import {
  isVerificationPolicyBlocking,
  verificationPolicyApi,
  type VerificationPolicy,
  type VerificationPolicyVersionList,
} from './verification-policy-api';

/**
 * Governance → Evidence-backed verification policy — ECA-3.1 (#4734), re-skinned by
 * HIVE-5.6 (#5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html`, its third tab; DESIGN.md §7 and §12.
 *
 * Tenant-level publish/deploy gate over ECA-1.3 evidence and CTG-3.1 whole-spec breaking
 * severity. The UI only edits and displays what the REST API returns — it never re-scores
 * evidence.
 *
 * ### What HIVE-5.6 changed
 *
 * The skin and the shape, not the contract. The six fields, their copy, the save gate and
 * every call are the screen's own. What changed: the form is a `Card` with its history beside
 * it rather than one long box, the four state pills are `Badge`s from the shared vocabulary
 * instead of four inline hue palettes, the wait is a shaped skeleton, and a read-only viewer
 * is told the panel is read-only rather than silently losing the Save button.
 *
 * The mockup's `last 8` history cap is kept: a version list is context for the policy above
 * it, and an unbounded one turns the aside into the page.
 */

/** The editable policy body — everything a PUT can change. */
interface PolicyDraft {
  requiredSuiteDigests: string;
  maxEvidenceAgeSeconds: string;
  requiredTargetNetworkClass: '' | 'public' | 'private';
  purpose: 'publish' | 'deploy' | 'both';
  breakingChangeAction: 'ignore' | 'warn' | 'block';
  enforcement: 'advisory' | 'block';
}

/** How many versions the history aside shows, as the mockup's "last 8" states. */
const HISTORY_LIMIT = 8;

/** Normalize the API policy into editable draft state. */
function toDraft(policy: VerificationPolicy): PolicyDraft {
  return {
    requiredSuiteDigests: (policy.requiredSuiteDigests ?? []).join('\n'),
    maxEvidenceAgeSeconds:
      policy.maxEvidenceAgeSeconds != null ? String(policy.maxEvidenceAgeSeconds) : '',
    requiredTargetNetworkClass: policy.requiredTargetNetworkClass ?? '',
    purpose: policy.purpose,
    breakingChangeAction: policy.breakingChangeAction,
    enforcement: policy.enforcement,
  };
}

/** Split the digest textarea into the list the API stores. */
function parseDigests(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/**
 * The verification publish & deploy policy panel.
 *
 * @param props.readOnly Whether the viewer may save. A member sees every value and no Save.
 * @returns The policy form and its version history.
 */
export default function VerificationPolicyPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [policy, setPolicy] = useState<VerificationPolicy | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [versions, setVersions] = useState<VerificationPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [current, history] = await Promise.all([
        verificationPolicyApi<VerificationPolicy>(''),
        verificationPolicyApi<VerificationPolicyVersionList>('versions'),
      ]);
      if (current) {
        setPolicy(current);
        setDraft(toDraft(current));
      }
      setVersions(history?.versions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load verification policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    policy && draft ? JSON.stringify(draft) !== JSON.stringify(toDraft(policy)) : false;

  const handleSave = async () => {
    if (!draft || readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const maxAgeRaw = draft.maxEvidenceAgeSeconds.trim();
      const body: Record<string, unknown> = {
        requiredSuiteDigests: parseDigests(draft.requiredSuiteDigests),
        purpose: draft.purpose,
        breakingChangeAction: draft.breakingChangeAction,
        enforcement: draft.enforcement,
      };
      if (maxAgeRaw === '') {
        body.clearMaxEvidenceAgeSeconds = true;
      } else {
        body.maxEvidenceAgeSeconds = Number(maxAgeRaw);
      }
      if (draft.requiredTargetNetworkClass === '') {
        body.clearRequiredTargetNetworkClass = true;
      } else {
        body.requiredTargetNetworkClass = draft.requiredTargetNetworkClass;
      }
      const saved = await verificationPolicyApi<VerificationPolicy>('', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (saved) {
        setPolicy(saved);
        setDraft(toDraft(saved));
      }
      const history = await verificationPolicyApi<VerificationPolicyVersionList>('versions');
      setVersions(history?.versions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save verification policy');
    } finally {
      setSaving(false);
    }
  };

  const busy = readOnly || saving;

  return (
    <div className="vp-panel" data-testid="verification-policy-panel">
      {error && <Alert variant="error">{error}</Alert>}

      <div className="vp-layout">
        <Card>
          <CardHeader className="qp-card-header">
            <span className="qp-card-header__lead">
              <span className="tnt-icon-tile" data-tone="violet">
                <Shield aria-hidden />
              </span>
              <span className="qp-card-header__text">
                <span className="vp-title-row">
                  <h3 className="qp-card-title">Verification publish &amp; deploy policy</h3>
                  {policy &&
                    (policy.isDefault ? (
                      <Badge variant="outline" data-testid="verification-policy-default-badge">
                        Default (advisory)
                      </Badge>
                    ) : (
                      <Badge variant="outline" mono data-testid="verification-policy-version-badge">
                        v{policy.versionNumber}
                      </Badge>
                    ))}
                  {policy && (
                    <Badge variant={isVerificationPolicyBlocking(policy) ? 'rose' : 'warn'}>
                      {isVerificationPolicyBlocking(policy) ? 'Blocking' : 'Advisory'}
                    </Badge>
                  )}
                </span>
                <p className="qp-card-desc">
                  Require recent passing contract evidence (suite digests) and set whole-spec
                  breaking posture before publish or deploy. Decisions cite exact evidence run
                  IDs. Consumer-aware breaking acknowledgment lands with #4479.
                </p>
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label="Refresh policy"
              data-testid="verification-policy-refresh"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
          </CardHeader>

          {loading && !draft ? (
            <CardContent className="vp-skeleton">
              <span className="sr-only" role="status">
                Loading policy…
              </span>
              <Skeleton className="vp-skeleton__block" />
              <Skeleton className="vp-skeleton__row" />
              <Skeleton className="vp-skeleton__row" />
            </CardContent>
          ) : draft && policy ? (
            <CardContent className="vp-body">
              <div className="sg-field">
                <Label htmlFor="vp-digests">Required suite digests (one per line)</Label>
                <Textarea
                  id="vp-digests"
                  className="mono"
                  rows={3}
                  disabled={busy}
                  value={draft.requiredSuiteDigests}
                  onChange={(e) => setDraft({ ...draft, requiredSuiteDigests: e.target.value })}
                  placeholder="sha256:…"
                />
                <p className="sg-field__hint">
                  Evidence must match one of these digests to count as passing.
                </p>
              </div>

              <div className="qp-grid">
                <div className="sg-field">
                  <Label htmlFor="vp-max-age">Max evidence age (seconds)</Label>
                  <Input
                    id="vp-max-age"
                    type="number"
                    min={1}
                    className="sg-num"
                    disabled={busy}
                    value={draft.maxEvidenceAgeSeconds}
                    onChange={(e) => setDraft({ ...draft, maxEvidenceAgeSeconds: e.target.value })}
                    placeholder="No limit"
                  />
                  <p className="sg-field__hint">Older evidence is treated as missing.</p>
                </div>
                <div className="sg-field">
                  <Label htmlFor="vp-network">Required target network class</Label>
                  <select
                    id="vp-network"
                    className="hive-control sg-select"
                    disabled={busy}
                    value={draft.requiredTargetNetworkClass}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        requiredTargetNetworkClass: e.target
                          .value as PolicyDraft['requiredTargetNetworkClass'],
                      })
                    }
                  >
                    <option value="">Any</option>
                    <option value="public">public</option>
                    <option value="private">private</option>
                  </select>
                </div>
                <div className="sg-field">
                  <Label htmlFor="vp-purpose">Purpose</Label>
                  <select
                    id="vp-purpose"
                    className="hive-control sg-select"
                    disabled={busy}
                    value={draft.purpose}
                    onChange={(e) =>
                      setDraft({ ...draft, purpose: e.target.value as PolicyDraft['purpose'] })
                    }
                  >
                    <option value="both">both</option>
                    <option value="publish">publish</option>
                    <option value="deploy">deploy</option>
                  </select>
                </div>
                <div className="sg-field">
                  <Label htmlFor="vp-breaking">Breaking-change action (whole-spec)</Label>
                  <select
                    id="vp-breaking"
                    className="hive-control sg-select"
                    disabled={busy}
                    value={draft.breakingChangeAction}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        breakingChangeAction: e.target
                          .value as PolicyDraft['breakingChangeAction'],
                      })
                    }
                  >
                    <option value="ignore">ignore</option>
                    <option value="warn">warn</option>
                    <option value="block">block</option>
                  </select>
                </div>
              </div>

              <div className="sg-field vp-enforcement">
                <Label htmlFor="vp-enforcement">Enforcement</Label>
                <select
                  id="vp-enforcement"
                  className="hive-control sg-select"
                  disabled={busy}
                  value={draft.enforcement}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      enforcement: e.target.value as PolicyDraft['enforcement'],
                    })
                  }
                >
                  <option value="advisory">advisory</option>
                  <option value="block">block</option>
                </select>
                <p className="sg-field__hint">
                  Block refuses the publish/deploy when evidence is missing or stale.
                </p>
              </div>
            </CardContent>
          ) : null}

          <CardFooter>
            <span className="sg-quiet">
              {readOnly
                ? 'Read-only: only tenant administrators can save a policy version.'
                : 'Every save creates a new immutable version.'}
            </span>
            {!readOnly && (
              <Button
                disabled={!dirty || saving}
                data-testid="verification-policy-save"
                onClick={() => void handleSave()}
              >
                {saving ? <Spinner size="sm" aria-hidden /> : null}
                {saving ? 'Saving…' : 'Save new version'}
              </Button>
            )}
          </CardFooter>
        </Card>

        <aside className="vp-aside">
          <Card>
            <CardHeader className="qp-list-header">
              <span className="qp-card-header__text">
                <h3 className="qp-card-title">
                  <History aria-hidden className="qp-card-title__glyph" />
                  Version history
                </h3>
                <p className="qp-card-desc">The last {HISTORY_LIMIT} saved versions.</p>
              </span>
            </CardHeader>
            {versions.length === 0 ? (
              <CardContent>
                <p className="sg-quiet">No version has been saved yet.</p>
              </CardContent>
            ) : (
              <ul className="qp-rows" data-testid="verification-policy-versions">
                {versions.slice(0, HISTORY_LIMIT).map((version) => (
                  <li
                    key={version.policyVersionId ?? version.versionNumber}
                    className="vp-version-row"
                  >
                    <span className="vp-version-row__label mono">
                      v{version.versionNumber} · {version.enforcement} ·{' '}
                      {version.breakingChangeAction}
                    </span>
                    <span className="vp-version-row__when">
                      {formatPolicyInstant(version.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
