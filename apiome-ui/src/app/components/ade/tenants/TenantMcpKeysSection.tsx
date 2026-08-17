'use client';

import * as React from 'react';

import { Alert } from '@/app/components/ui/Alert';
import { LoadingState } from '@/app/components/ui/LoadingState';

import TenantMcpKeyCapabilitiesEditor from '@/app/ade/dashboard/tenants/TenantMcpKeyCapabilitiesEditor';
import {
  fetchMcpPolicy,
  fetchMcpToolCatalog,
  type McpToolCatalogItem,
} from '@/app/ade/dashboard/tenants/mcpPolicyApi';

/**
 * The manage drawer's Per-key capabilities section — HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `[data-tab-panel="m-keys"]`.
 *
 * ### Why this wrapper exists
 *
 * {@link TenantMcpKeyCapabilitiesEditor} needs two things it cannot fetch for itself: the
 * tool catalog, and the **saved** tenant ceiling — the set of tools a key may be granted at
 * all. Until this ticket it received both from `TenantMcpSettingsPanel`, which had already
 * loaded the policy and rendered the editor as its child.
 *
 * The mockup makes them siblings — two vertical tabs, not one panel inside another — so the
 * parent that supplied those props is gone. This wrapper takes its place: it loads the
 * policy and the catalog, derives the ceiling from the *saved* policy rather than from any
 * draft, and hands both to the editor unchanged.
 *
 * The ceiling deliberately comes from the server's copy, not from whatever the MCP settings
 * tab currently holds. A key cannot be granted a tool the tenant has not actually saved into
 * its ceiling, so showing an unlocked switch for one would be offering an edit the server
 * would refuse. `policyRevision` is the drawer's counter, bumped after a policy save, which
 * is when — and only when — the ceiling has genuinely moved.
 */

/** Props for {@link TenantMcpKeysSection}. */
export interface TenantMcpKeysSectionProps {
  /** True when the viewer may create keys and change their capabilities. */
  isAdmin: boolean;
  /** Bumped by the drawer after MCP settings are saved, to re-read the ceiling. */
  policyRevision: number;
}

/** What the tenant's saved policy tells this section. */
interface CeilingSources {
  catalog: McpToolCatalogItem[];
  ceilingToolIds: string[];
}

/**
 * The per-key capability editor, with the ceiling it needs.
 *
 * @param props See {@link TenantMcpKeysSectionProps}.
 * @returns The section.
 */
export default function TenantMcpKeysSection({
  isAdmin,
  policyRevision,
}: TenantMcpKeysSectionProps) {
  const [sources, setSources] = React.useState<CeilingSources | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [policy, catalog] = await Promise.all([fetchMcpPolicy(), fetchMcpToolCatalog()]);
        if (cancelled) return;
        setSources({
          catalog: catalog.tools ?? [],
          ceilingToolIds: (policy.tools ?? [])
            .filter((tool) => tool.in_ceiling)
            .map((tool) => tool.tool_id),
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load MCP policy');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    // Guards a save that lands while an earlier read is still in flight: the stale answer
    // would otherwise overwrite the fresh ceiling with the one it replaced.
    return () => {
      cancelled = true;
    };
  }, [policyRevision]);

  return (
    <section aria-labelledby="tnt-keys-heading" className="space-y-3">
      <div className="min-w-0">
        <h3 id="tnt-keys-heading" className="tnt-section-title">
          Per-key capabilities
        </h3>
        <p className="tnt-section-desc">
          Effective call access is per MCP API key. Inherit follows tenant defaults; Custom
          sets an enable-set capped by the tenant ceiling.
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {loading && !sources ? (
        <LoadingState message="Loading key capabilities…" minHeightClassName="min-h-[8rem]" />
      ) : sources ? (
        <TenantMcpKeyCapabilitiesEditor
          catalog={sources.catalog}
          ceilingToolIds={sources.ceilingToolIds}
          policyRevision={policyRevision}
          isAdmin={isAdmin}
        />
      ) : null}
    </section>
  );
}
